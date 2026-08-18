/**
 * Staleness check: a repository whose last commit is older than the
 * configured thresholds turns yellow (default 7 days) or red (default 14
 * days). Red uses the existing notification chain, exactly like a failed
 * check. Thresholds are stored per repository in the database so a project
 * that is deliberately paused does not raise false alarms.
 */

import type { Status } from "./github.js";

export const DEFAULT_YELLOW_DAYS = 7;
export const DEFAULT_RED_DAYS = 14;

export interface StaleThresholds {
  staleYellowDays: number;
  staleRedDays: number;
}

export interface StalenessResult {
  /** New status after the staleness check. */
  status: Status;
  /** Plain Dutch explanation, only set when staleness influenced the status. */
  staleReason: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Applies the staleness rules on top of the check status:
 * - No commit information → never green: green becomes gray with a reason.
 * - Last commit older than the red threshold → red (an existing red from a
 *   failed check keeps its own failure reason).
 * - Older than the yellow threshold → yellow, unless the repo is already red.
 */
export function applyStaleness(
  checkStatus: Status,
  lastCommitAt: Date | null,
  thresholds: StaleThresholds,
  now: Date = new Date(),
): StalenessResult {
  if (!lastCommitAt || isNaN(lastCommitAt.getTime())) {
    // Unknown commit age: we cannot vouch for freshness, so never green.
    if (checkStatus === "green") {
      return {
        status: "gray",
        staleReason:
          "geen commit-informatie beschikbaar — ouderdom van de code kan niet worden vastgesteld",
      };
    }
    if (checkStatus === "gray") {
      // No workflow runs AND no commit info: make the dual absence explicit so
      // the dashboard can explain it rather than showing a bare gray dot.
      return {
        status: "gray",
        staleReason:
          "geen actieve GitHub Actions-checks gevonden en geen commit-informatie beschikbaar",
      };
    }
    return { status: checkStatus, staleReason: null };
  }

  const ageDays = Math.floor((now.getTime() - lastCommitAt.getTime()) / DAY_MS);

  // A check that already failed keeps its own red status and failure reason;
  // staleness never overrides or annotates an existing failure.
  if (checkStatus === "red") {
    return { status: "red", staleReason: null };
  }

  if (ageDays >= thresholds.staleRedDays) {
    return {
      status: "red",
      staleReason: `laatste commit is ${ageDays} dagen oud (rode drempel: ${thresholds.staleRedDays} dagen)`,
    };
  }

  if (ageDays >= thresholds.staleYellowDays) {
    return {
      status: "yellow",
      staleReason: `laatste commit is ${ageDays} dagen oud (gele drempel: ${thresholds.staleYellowDays} dagen)`,
    };
  }

  return { status: checkStatus, staleReason: null };
}

/** Reads the thresholds for a repo from the database, with defaults 7/14. */
export async function getRepoThresholds(repo: string): Promise<StaleThresholds> {
  try {
    const { db, repoSettings } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(repoSettings)
      .where(eq(repoSettings.repo, repo))
      .limit(1);
    const row = rows[0];
    if (row) {
      return { staleYellowDays: row.staleYellowDays, staleRedDays: row.staleRedDays };
    }
  } catch {
    // Database unavailable: fall back to defaults — the staleness check
    // must never take down the status overview itself.
  }
  return { staleYellowDays: DEFAULT_YELLOW_DAYS, staleRedDays: DEFAULT_RED_DAYS };
}

/** Stores thresholds for a repo (upsert). */
export async function saveRepoThresholds(
  repo: string,
  thresholds: StaleThresholds,
): Promise<void> {
  const { pool } = await import("@workspace/db");
  await pool.query(
    `INSERT INTO repo_settings (repo, stale_yellow_days, stale_red_days)
     VALUES ($1, $2, $3)
     ON CONFLICT (repo) DO UPDATE
       SET stale_yellow_days = EXCLUDED.stale_yellow_days,
           stale_red_days = EXCLUDED.stale_red_days`,
    [repo, thresholds.staleYellowDays, thresholds.staleRedDays],
  );
}
