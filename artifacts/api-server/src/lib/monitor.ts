/**
 * Background monitor: polls all repositories every POLL_INTERVAL_MS.
 *
 * Notifications are sent on:
 *   • green → red status transition (failed GitHub Actions check)
 *   • new anomaly commit (>300 changed lines in one file)
 *   • repo still red after REMINDER_INTERVAL_MS since the last red notification
 *
 * Concurrency & delivery guarantees
 * ──────────────────────────────────
 * Advisory lock  — pg_try_advisory_lock ensures that in an autoscale
 *   deployment only ONE instance runs the polling cycle at a time.
 *   Other instances skip the cycle silently when the lock is held.
 *
 * Delivery-first ordering  — the Slack POST is attempted BEFORE writing
 *   the new "notified" state to the database.  If the POST fails, the
 *   notified_status / notified_anomaly_sha columns are NOT advanced, so
 *   the next poll will retry.  If the POST succeeds, the columns are
 *   advanced and subsequent polls will not resend.
 *
 *   NOTE: exactly-once delivery over an external HTTP endpoint is
 *   impossible to guarantee; a server crash between a successful POST and
 *   the subsequent DB write could produce a duplicate.  That is an
 *   accepted trade-off for this tool.
 *
 * GitHub access remains strictly read-only.
 */

import { pool, db, repoStatusSnapshots } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { listMonitoredRepos, repoSummary, type Status, type Anomaly, type RepoSummary } from "./github.js";
import { maybeAutoRetry, settleRecovery } from "./selfheal.js";
import { retryMailOutbox } from "./mail.js";
import { logAction } from "./actionlog.js";
import { isQuietTime, MIN_PROBLEM_AGE_MS } from "./quiet.js";
import { logger } from "./logger.js";
import {
  checkPublicServices,
  openFinding,
  resolveFinding,
  runFindingDelivery,
  syncExpiryFindings,
} from "./findings.js";
import { recordSuccessfulMonitorRound } from "./watchdog.js";

/**
 * A "problem" is a red status (failed check or stale code) OR an unknown
 * status (gray — the check yields nothing). Unknown counts as a problem,
 * not as rest, and notifies by the same rules.
 */
function isProblem(status: string): boolean {
  return status === "red" || status === "gray";
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ADVISORY_LOCK_KEY = "6839201475"; // stable across restarts; fits pg bigint

/**
 * How long a repo must remain continuously red before a reminder notification
 * is sent.  Survives server restarts because last_red_notified_at is stored in
 * the database.  Configurable via REMINDER_INTERVAL_MS environment variable;
 * defaults to 60 minutes.
 */
const REMINDER_INTERVAL_MS = Number(
  process.env["REMINDER_INTERVAL_MS"] ?? 60 * 60 * 1000,
);
interface PgPoolClient {
  query(
    text: string,
    values?: (string | number | boolean | null)[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

// ---------------------------------------------------------------------------
// Advisory-lock helpers
// ---------------------------------------------------------------------------

async function tryAcquireAdvisoryLock(): Promise<{
  client: PgPoolClient | null;
  acquired: boolean;
}> {
  const client = (await pool.connect()) as unknown as PgPoolClient;
  try {
    const res = await client.query(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [ADVISORY_LOCK_KEY],
    );
    const acquired = Boolean(res.rows[0]?.["acquired"]);
    if (!acquired) {
      client.release();
      return { client: null, acquired: false };
    }
    return { client, acquired: true };
  } catch (err) {
    client.release();
    throw err;
  }
}

async function releaseAdvisoryLock(client: PgPoolClient): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [
      ADVISORY_LOCK_KEY,
    ]);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

interface Snapshot {
  status: string;
  notifiedStatus: string;
  notifiedAnomalySha: string | null;
  /** When the most recent red Slack notification was delivered (null = never). */
  lastRedNotifiedAt: Date | null;
  /** Since when the repo has continuously been in a problem state. */
  problemSince: Date | null;
}

async function loadSnapshot(repoName: string): Promise<Snapshot | null> {
  try {
    const rows = await db
      .select()
      .from(repoStatusSnapshots)
      .where(eq(repoStatusSnapshots.repoName, repoName))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      status: row.status,
      notifiedStatus: row.notifiedStatus,
      notifiedAnomalySha: row.notifiedAnomalySha ?? null,
      lastRedNotifiedAt: row.lastRedNotifiedAt ?? null,
      problemSince: row.problemSince ?? null,
    };
  } catch {
    return null;
  }
}

async function saveSnapshot(
  repoName: string,
  status: Status,
  notifiedStatus: string,
  notifiedAnomalySha: string | null,
  lastRedNotifiedAt: Date | null,
  problemSince: Date | null,
): Promise<void> {
  try {
    await db
      .insert(repoStatusSnapshots)
      .values({
        repoName,
        status,
        notifiedStatus,
        notifiedAnomalySha,
        lastRedNotifiedAt,
        problemSince,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: repoStatusSnapshots.repoName,
        set: {
          status,
          notifiedStatus,
          notifiedAnomalySha,
          lastRedNotifiedAt,
          problemSince,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn({ err, repo: repoName }, "Snapshot opslaan mislukt");
  }
}

// ---------------------------------------------------------------------------
// Per-repo data gathering (no notifications sent here)
// ---------------------------------------------------------------------------

interface RepoCheckData {
  repoName: string;
  summary: RepoSummary;
  notifiedStatus: string;
  notifiedAnomalySha: string | null;
  /** When the most recent red notification was delivered; null if never. */
  lastRedNotifiedAt: Date | null;
  /** Since when the repo is continuously in a problem state; null when healthy. */
  problemSince: Date | null;
  /**
   * True when this repo is in a problem state (red or unknown) that has
   * persisted for at least MIN_PROBLEM_AGE_MS, has not yet been notified,
   * no automatic retry was started (selfheal), and we are outside the quiet
   * window. When a retry is started or the quiet window is active, the
   * notification is held back until a later poll.
   */
  isNewRed: boolean;
  /**
   * True when the repo problem was already notified and the reminder
   * interval has elapsed since the last notification.  Mutually exclusive
   * with isNewRed.  Suppressed during the quiet window.
   */
  isReminderDue: boolean;
  /** Anomaly that hasn't been notified yet, or null. */
  newAnomaly: Anomaly | null;
  /**
   * Set when a problem resolved before it was ever notified (blip shorter
   * than the debounce, or arisen-and-resolved inside the quiet window).
   * The persist phase writes it to the action log — visible in the
   * overview, but no Slack message.
   */
  suppressedResolution: { since: Date; quiet: boolean } | null;
}

/**
 * Fetches the live status for one repo and compares it with the stored
 * snapshot. Returns a data object that pollAll uses to decide how to notify.
 * Does NOT send any Slack messages.
 *
 * Exported for unit-testing only.
 */
export async function gatherRepoData(repoName: string): Promise<RepoCheckData | null> {
  let summary: RepoSummary;
  try {
    summary = await repoSummary(repoName);
  } catch (err) {
    logger.warn({ err, repo: repoName }, "Statuscontrole overgeslagen");
    return null;
  }

  const snapshot = await loadSnapshot(repoName);
  // "none" (not a real status) so that a first-ever problem does notify;
  // pre-existing rows keep their stored value.
  const notifiedStatus = snapshot?.notifiedStatus ?? "none";
  const notifiedAnomalySha = snapshot?.notifiedAnomalySha ?? null;
  const lastRedNotifiedAt = snapshot?.lastRedNotifiedAt ?? null;

  const now = new Date();
  const quiet = isQuietTime(now);
  const problematic = isProblem(summary.status);

  // Debounce clock: when did the current uninterrupted problem start?
  const problemSince = problematic ? (snapshot?.problemSince ?? now) : null;

  // Unknown status counts as a problem; give the notification a reason.
  if (summary.status === "gray" && !summary.failReason) {
    summary = {
      ...summary,
      failReason: "Status onbekend: de controle levert geen resultaat op",
    };
  }

  // A problem resolved before it was ever notified → log-only, no Slack.
  const suppressedResolution =
    !problematic && snapshot?.problemSince && !isProblem(notifiedStatus)
      ? {
          since: snapshot.problemSince,
          // "Quiet-window blip" only when it both arose AND resolved inside
          // the quiet window; a problem that spills past the window edge
          // gets the neutral/debounce wording instead.
          quiet: isQuietTime(snapshot.problemSince) && quiet,
        }
      : null;

  const persistedLongEnough =
    problemSince !== null &&
    now.getTime() - problemSince.getTime() >= MIN_PROBLEM_AGE_MS;

  let isNewRed =
    problematic && !isProblem(notifiedStatus) && persistedLongEnough;

  // Self-heal runs on a fresh red immediately (independent of debounce or
  // quiet hours — a rerun is not a notification and may fix the problem
  // before the debounce elapses). A red caused by the staleness check
  // (staleReason set) or an unknown status never enters the self-heal
  // chain: there is no failed run to rerun.
  if (
    summary.status === "red" &&
    !isProblem(notifiedStatus) &&
    !summary.staleReason
  ) {
    if (problemSince === now) {
      logger.info({ repo: repoName, notifiedStatus }, "Statusovergang naar rood gedetecteerd");
    }
    const retryStarted = await maybeAutoRetry(repoName);
    if (retryStarted) {
      isNewRed = false;
    }
  }

  // Reminder: repo problem was already notified and has persisted for longer
  // than REMINDER_INTERVAL_MS since the last notification. Held back during
  // the quiet window (it goes out on the first allowed poll).
  const isReminderDue =
    !isNewRed &&
    problematic &&
    isProblem(notifiedStatus) &&
    lastRedNotifiedAt !== null &&
    Date.now() - lastRedNotifiedAt.getTime() >= REMINDER_INTERVAL_MS;

  if (isReminderDue) {
    logger.info(
      { repo: repoName, lastRedNotifiedAt, reminderIntervalMs: REMINDER_INTERVAL_MS },
      "Herinnering: repo blijft rood",
    );
  }

  // Anomaly notifications also respect the quiet window: keep the anomaly
  // un-notified (sha not advanced) so it goes out on the first allowed poll.
  const anomaly = summary.anomaly ?? null;
  const newAnomaly =
    anomaly && anomaly.commitSha !== notifiedAnomalySha
      ? anomaly
      : null;
  if (newAnomaly) {
    logger.info({ repo: repoName, sha: newAnomaly.commitSha }, "Nieuwe afwijking gedetecteerd");
  }

  return {
    repoName,
    summary,
    notifiedStatus,
    notifiedAnomalySha,
    lastRedNotifiedAt,
    problemSince,
    isNewRed,
    isReminderDue,
    newAnomaly,
    suppressedResolution,
  };
}

/**
 * Writes a log-only entry for a problem that resolved before it was ever
 * notified (blip shorter than the debounce, or arisen-and-resolved during
 * the quiet window). Visible in the /logboek overview; no Slack message.
 */
async function logSuppressedResolution(
  repoName: string,
  suppressed: { since: Date; quiet: boolean },
): Promise<void> {
  const minutes = Math.max(
    1,
    Math.round((Date.now() - suppressed.since.getTime()) / 60_000),
  );
  const reason = suppressed.quiet
    ? `Probleem ontstaan en opgelost tijdens het stiltevenster (duur ± ${minutes} min)`
    : minutes * 60_000 < 10 * 60_000
      ? `Hapering van ± ${minutes} min — korter dan de meldingsdrempel van 10 minuten`
      : `Probleem loste vanzelf op (duur ± ${minutes} min) voordat een melding was verstuurd`;
  await logAction({
    kind: "melding_onderdrukt",
    action: "Melding onderdrukt",
    repo: repoName,
    reason,
    outcome: "vanzelf opgelost, geen melding verstuurd",
  });
  logger.info({ repo: repoName, reason }, "Melding onderdrukt");
}

/**
 * Processes a single repo: gathers its status, sends any required Slack
 * notifications, and persists the updated snapshot.
 *
 * This function does NOT apply bundling logic (≥2 repos → one message).
 * Bundling only happens inside pollAll which processes all repos together.
 * checkRepo is exported so unit tests can exercise the per-repo logic in
 * isolation without standing up the full poll cycle.
 */
export async function checkRepo(repoName: string): Promise<void> {
  const data = await gatherRepoData(repoName);
  if (!data) return;

  const {
    summary,
    notifiedStatus,
    notifiedAnomalySha,
    lastRedNotifiedAt,
    isNewRed,
    isReminderDue,
    newAnomaly,
  } = data;

  let newNotifiedStatus = notifiedStatus;
  let newLastRedNotifiedAt = lastRedNotifiedAt;

  if (data.suppressedResolution) {
    await logSuppressedResolution(data.repoName, data.suppressedResolution);
  }

  if (isNewRed || isReminderDue) {
    const kind = summary.status === "gray" ? "repo_without_check" : "build_failed";
    await openFinding({
      id: `build:${data.repoName}`,
      kind,
      subject: data.repoName,
      title: `Bouwcontrole ${data.repoName} faalt`,
      detail: summary.failReason ?? "De controle levert geen werkende status op.",
    });
    newNotifiedStatus = summary.status;
    newLastRedNotifiedAt = new Date();
  } else if (!isProblem(summary.status) && isProblem(notifiedStatus)) {
    // Recovery: green or yellow after a notified problem — reset so the
    // next problem cycle alerts again. Yellow (stale but not critical)
    // counts as recovered; gray does not (unknown is itself a problem).
    newNotifiedStatus = summary.status;
    newLastRedNotifiedAt = null;
    await resolveFinding(`build:${data.repoName}`);
  }

  if (summary.status === "green") {
    await settleRecovery(repoName);
  }

  let newNotifiedAnomalySha = notifiedAnomalySha;
  if (newAnomaly) {
    await openFinding({
      id: `anomaly:${repoName}:${newAnomaly.commitSha}`,
      kind: "anomaly",
      subject: repoName,
      title: `Afwijkend grote wijziging in ${repoName}`,
      detail: `${newAnomaly.fileName}: ${newAnomaly.linesChanged} regels gewijzigd — ${newAnomaly.commitTitle}`,
    });
    newNotifiedAnomalySha = newAnomaly.commitSha;
  }

  await saveSnapshot(
    repoName,
    summary.status,
    newNotifiedStatus,
    newNotifiedAnomalySha,
    newLastRedNotifiedAt,
    data.problemSince,
  );
}
/** Exported for unit-testing only. */
export async function pollAll(): Promise<void> {
  let lockClient: PgPoolClient | null = null;
  try {
    const { client, acquired } = await tryAcquireAdvisoryLock();
    if (!acquired) {
      logger.debug(
        "Monitor: advisory lock bezet — een andere instantie is al actief, sla over",
      );
      return;
    }
    lockClient = client;

    logger.debug("Monitor: start controle van alle repositories");

    // 0. Retry queued e-mails from earlier failed sends (mail outbox).
    //    Failures inside the retry can never break the poll cycle.
    try {
      await retryMailOutbox();
    } catch (err) {
      logger.error({ err }, "E-mailwachtrij verwerken mislukt");
    }

    // 1. Gather data for all repos (no Slack calls yet).
    const monitoredRepos = await listMonitoredRepos();
    const results: RepoCheckData[] = [];
    for (const repo of monitoredRepos) {
      const data = await gatherRepoData(repo);
      if (data) results.push(data);
    }

    // 2. Convert repository observations into open/resolved findings.
    for (const data of results) {
      const {
        repoName,
        summary,
        notifiedStatus,
        notifiedAnomalySha,
        lastRedNotifiedAt,
      } = data;

      // Determine new notified-status and reminder timestamp to persist.
      let newNotifiedStatus = notifiedStatus;
      let newLastRedNotifiedAt = lastRedNotifiedAt;

      if (data.suppressedResolution) {
        await logSuppressedResolution(repoName, data.suppressedResolution);
      }

      if (data.isNewRed || data.isReminderDue) {
        const kind = summary.status === "gray" ? "repo_without_check" : "build_failed";
        await openFinding({
          id: `build:${repoName}`, kind, subject: repoName,
          title: `Bouwcontrole ${repoName} faalt`,
          detail: summary.failReason ?? "De controle levert geen werkende status op.",
        });
        newNotifiedStatus = summary.status;
        newLastRedNotifiedAt = new Date();
      } else if (!isProblem(summary.status) && isProblem(notifiedStatus)) {
        // Confirmed recovery: green or yellow after a notified problem —
        // reset so the next problem cycle alerts again.
        newNotifiedStatus = summary.status;
        newLastRedNotifiedAt = null;
        await resolveFinding(`build:${repoName}`);
      }

      // Settle a pending automatic retry: when the repo is green thanks to a
      // retried run, mark the log entry "hersteld na herhaling".
      if (summary.status === "green") {
        await settleRecovery(repoName);
      }

      let newNotifiedAnomalySha = notifiedAnomalySha;
      if (data.newAnomaly) {
        await openFinding({
          id: `anomaly:${repoName}:${data.newAnomaly.commitSha}`, kind: "anomaly", subject: repoName,
          title: `Afwijkend grote wijziging in ${repoName}`,
          detail: `${data.newAnomaly.fileName}: ${data.newAnomaly.linesChanged} regels gewijzigd — ${data.newAnomaly.commitTitle}`,
        });
        newNotifiedAnomalySha = data.newAnomaly.commitSha;
      }

      await saveSnapshot(
        repoName,
        summary.status,
        newNotifiedStatus,
        newNotifiedAnomalySha,
        newLastRedNotifiedAt,
        data.problemSince,
      );
    }
    await Promise.all([checkPublicServices(), syncExpiryFindings()]);
    await runFindingDelivery();
    await recordSuccessfulMonitorRound();

    logger.debug("Monitor: controle afgerond");
  } catch (err) {
    logger.error({ err }, "Monitor: fout tijdens pollronde");
  } finally {
    if (lockClient) {
      await releaseAdvisoryLock(lockClient);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startMonitor(): void {
  if (pollTimer) return;

  const initialDelay = setTimeout(() => void pollAll(), 10_000);
  pollTimer = setInterval(() => void pollAll(), POLL_INTERVAL_MS);

  if (initialDelay.unref) initialDelay.unref();
  if (pollTimer.unref) pollTimer.unref();

  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Achtergrondmonitor gestart");
}

export function stopMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info("Achtergrondmonitor gestopt");
  }
}
