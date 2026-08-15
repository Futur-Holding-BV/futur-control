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
import { listMonitoredRepos, repoSummary, type Status, type Anomaly } from "./github.js";
import { notifyRepoRed, notifyAnomaly } from "./notifications.js";
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
// Per-repo check
// ---------------------------------------------------------------------------

/** Exported for unit-testing only. */
export async function checkRepo(repoName: string): Promise<void> {
  // 1. Fetch live status from GitHub.
  let summary;
  try {
    summary = await repoSummary(repoName);
  } catch (err) {
    logger.warn({ err, repo: repoName }, "Statuscontrole overgeslagen");
    return;
  }

  // 2. Read the last persisted state.
  const snapshot = await loadSnapshot(repoName);
  const notifiedStatus = snapshot?.notifiedStatus ?? "gray";
  const notifiedAnomalySha = snapshot?.notifiedAnomalySha ?? null;

  // These track what we'll persist after (possibly) sending notifications.
  let newNotifiedStatus = notifiedStatus;
  let newNotifiedAnomalySha = notifiedAnomalySha;

  // 3. Green → red transition?  Only notify if the LAST NOTIFIED status was
  //    not already red (prevents re-alerting on a stable red repo).
  if (summary.status === "red" && notifiedStatus !== "red") {
    logger.info({ repo: repoName, notifiedStatus }, "Statusovergang naar rood gedetecteerd");

    // Self-heal: when the failure looks like a temporary hiccup, retry the
    // check ONCE automatically and hold back the red notification until the
    // retry has concluded. If the retry fails, the repo stays red on the
    // next poll and the notification goes out then.
    const retryStarted = await maybeAutoRetry(repoName);
    if (!retryStarted) {
      // Attempt Slack delivery FIRST.  The fetch has a bounded timeout so it
      // cannot stall the advisory lock indefinitely.
      const delivered = await notifyRepoRed(summary);
      if (delivered) {
        newNotifiedStatus = "red";
      }
      // If delivery failed: newNotifiedStatus stays at its old value.
      // Next poll will detect the same red transition and retry.
    }
  } else if (summary.status === "green" && notifiedStatus === "red") {
    // Confirmed recovery (green only): reset so the next red→green→red cycle
    // produces a fresh alert.
    // We deliberately do NOT reset on gray (unknown / workflow in-progress)
    // because gray is not a recovery — resetting on gray would cause a
    // duplicate alert on the subsequent red poll when the workflow completes.
    newNotifiedStatus = "green";
  }

  // Settle a pending automatic retry: when the repo is green thanks to a
  // retried run, mark the log entry "hersteld na herhaling".
  if (summary.status === "green") {
    await settleRecovery(repoName);
  }

  // 4. New anomaly?
  const anomaly = summary.anomaly;
  if (anomaly && anomaly.commitSha !== notifiedAnomalySha) {
    logger.info({ repo: repoName, sha: anomaly.commitSha }, "Nieuwe afwijking gedetecteerd");
    const delivered = await notifyAnomaly(repoName, anomaly, summary.htmlUrl);
    if (delivered) {
      newNotifiedAnomalySha = anomaly.commitSha;
    }
    // If delivery failed: notifiedAnomalySha is not advanced → retry next poll.
  }

  // 5. Persist: always save the observed status; notification state only
  //    advances when Slack delivery succeeded above.
  await saveSnapshot(repoName, summary.status, newNotifiedStatus, newNotifiedAnomalySha);
}

// ---------------------------------------------------------------------------
// Poll cycle (guarded by advisory lock)
// ---------------------------------------------------------------------------

async function pollAll(): Promise<void> {
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
    const repos = await listMonitoredRepos();
    for (const repo of repos) {
      await checkRepo(repo);
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
