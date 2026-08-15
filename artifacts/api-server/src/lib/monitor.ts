/**
 * Background monitor: polls all repositories every POLL_INTERVAL_MS.
 *
 * Notifications are sent on:
 *   • green → red status transition (failed GitHub Actions check)
 *   • new anomaly commit (>300 changed lines in one file)
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
import { notifyRepoRed, notifyMultipleReposRed, notifyAnomaly } from "./notifications.js";
import { maybeAutoRetry, settleRecovery } from "./selfheal.js";
import { logger } from "./logger.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ADVISORY_LOCK_KEY = "6839201475"; // stable across restarts; fits pg bigint

// ---------------------------------------------------------------------------
// Local structural type — avoids importing from 'pg' directly.
// Only the two methods we actually call are declared.
// ---------------------------------------------------------------------------
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
}

async function loadSnapshot(repoName: string): Promise<Snapshot | null> {
  try {
    const rows = await db
      .select()
      .from(repoStatusSnapshots)
      .where(eq(repoStatusSnapshots.repoName, repoName))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function saveSnapshot(
  repoName: string,
  status: Status,
  notifiedStatus: string,
  notifiedAnomalySha: string | null,
): Promise<void> {
  try {
    await db
      .insert(repoStatusSnapshots)
      .values({ repoName, status, notifiedStatus, notifiedAnomalySha, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: repoStatusSnapshots.repoName,
        set: { status, notifiedStatus, notifiedAnomalySha, updatedAt: new Date() },
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
  /**
   * True when this repo transitions to red and has not yet been notified,
   * AND no automatic retry was started (selfheal).  When a retry is started,
   * we hold back the notification until the next poll.
   */
  isNewRed: boolean;
  /** Anomaly that hasn't been notified yet, or null. */
  newAnomaly: Anomaly | null;
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
  const notifiedStatus = snapshot?.notifiedStatus ?? "gray";
  const notifiedAnomalySha = snapshot?.notifiedAnomalySha ?? null;

  let isNewRed = summary.status === "red" && notifiedStatus !== "red";
  if (isNewRed) {
    logger.info({ repo: repoName, notifiedStatus }, "Statusovergang naar rood gedetecteerd");

    // Self-heal: when the failure looks like a temporary hiccup, retry the
    // check ONCE automatically and hold back the red notification until the
    // retry has concluded. If the retry fails, the repo stays red on the
    // next poll and the notification goes out then.
    const retryStarted = await maybeAutoRetry(repoName);
    if (retryStarted) {
      isNewRed = false;
    }
  }

  const anomaly = summary.anomaly ?? null;
  const newAnomaly =
    anomaly && anomaly.commitSha !== notifiedAnomalySha ? anomaly : null;
  if (newAnomaly) {
    logger.info({ repo: repoName, sha: newAnomaly.commitSha }, "Nieuwe afwijking gedetecteerd");
  }

  return { repoName, summary, notifiedStatus, notifiedAnomalySha, isNewRed, newAnomaly };
}

// ---------------------------------------------------------------------------
// Poll cycle (guarded by advisory lock)
// ---------------------------------------------------------------------------

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

    // 1. Gather data for all repos (no Slack calls yet).
    const monitoredRepos = await listMonitoredRepos();
    const results: RepoCheckData[] = [];
    for (const repo of monitoredRepos) {
      const data = await gatherRepoData(repo);
      if (data) results.push(data);
    }

    // 2. Decide how to notify for red transitions.
    //    ≥2 new red repos → one bundled summary message.
    //    1 new red repo  → individual message (existing behaviour).
    const newRedRepos = results.filter((r) => r.isNewRed);

    // Track which repos had their red notification successfully delivered.
    const redDelivered = new Set<string>();

    if (newRedRepos.length >= 2) {
      const summaries = newRedRepos.map((r) => r.summary);
      const delivered = await notifyMultipleReposRed(summaries);
      if (delivered) {
        for (const r of newRedRepos) redDelivered.add(r.repoName);
      }
    } else if (newRedRepos.length === 1) {
      const r = newRedRepos[0]!;
      const delivered = await notifyRepoRed(r.summary);
      if (delivered) redDelivered.add(r.repoName);
    }

    // 3. Send anomaly notifications, settle recoveries, and persist snapshots.
    for (const data of results) {
      const { repoName, summary, notifiedStatus, notifiedAnomalySha } = data;

      // Determine new notified-status to persist.
      let newNotifiedStatus = notifiedStatus;
      if (data.isNewRed && redDelivered.has(repoName)) {
        newNotifiedStatus = "red";
      } else if (summary.status === "green" && notifiedStatus === "red") {
        // Confirmed recovery: reset so the next red→green→red cycle alerts again.
        // We deliberately do NOT reset on gray (not a recovery).
        newNotifiedStatus = "green";
      }

      // Settle a pending automatic retry: when the repo is green thanks to a
      // retried run, mark the log entry "hersteld na herhaling".
      if (summary.status === "green") {
        await settleRecovery(repoName);
      }

      // Anomaly notification (always per-repo).
      let newNotifiedAnomalySha = notifiedAnomalySha;
      if (data.newAnomaly) {
        const delivered = await notifyAnomaly(repoName, data.newAnomaly, summary.htmlUrl);
        if (delivered) {
          newNotifiedAnomalySha = data.newAnomaly.commitSha;
        }
      }

      await saveSnapshot(repoName, summary.status, newNotifiedStatus, newNotifiedAnomalySha);
    }

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
