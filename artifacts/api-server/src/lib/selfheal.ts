/**
 * Self-heal: exactly ONE automatic action is allowed — re-running a failed
 * GitHub Actions check when the failure looks like a temporary hiccup
 * (network glitch, timeout, rate limit, registry outage). One retry per
 * run, never more. Every attempt and its outcome is written to the action
 * log. Nothing else is ever automated.
 */

import {
  latestRuns,
  failedRunErrorLines,
  failedJobNames,
  rerunFailedJobs,
} from "./github.js";
import { logAction, updateOutcome, findAutoRetry } from "./actionlog.js";
import { logger } from "./logger.js";

/** Patterns that indicate a temporary infrastructure hiccup, not a code problem. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /econnreset|econnrefused|etimedout|eai_again|epipe/i,
  /\btime[d]? ?out\b/i,
  /rate limit|too many requests|\b429\b/i,
  /\b50[234]\b.*(gateway|service|server)|bad gateway|service unavailable|gateway time/i,
  /could not resolve|network (error|failure|unreachable)|connection (reset|refused|closed|timed)/i,
  /temporar(y|ily)|transient/i,
  /fetch failed|socket hang ?up/i,
  /registry\.(npmjs|yarnpkg)\.org.*(error|fail|timeout)/i,
];

export function looksTransient(lines: string[]): boolean {
  return lines.some((line) => TRANSIENT_PATTERNS.some((p) => p.test(line)));
}

/**
 * Hard boundary: a rerun re-executes the FAILED jobs of a workflow. Jobs
 * that deploy, release, migrate or restart anything are therefore never
 * rerun — not automatically and not via a proposal.
 */
const FORBIDDEN_RERUN_PATTERN =
  /deploy|release|publish|rollout|uitrol|migrat|restart|herstart|\bprod(uction|uctie)?\b/i;

export function rerunForbidden(names: Array<string | null | undefined>): boolean {
  return names.some((n) => n && FORBIDDEN_RERUN_PATTERN.test(n));
}

function isPendingOutcome(outcome: string): boolean {
  return outcome === "herstart wordt gestart" || outcome === "herstart gestart, wacht op uitkomst";
}

/**
 * Called by the monitor when a repo's latest run is red.
 * Returns true when an automatic retry was started THIS cycle (the red
 * notification is then held back until the retry has concluded).
 */
export async function maybeAutoRetry(repo: string): Promise<boolean> {
  let run;
  try {
    run = (await latestRuns(repo, 1))[0];
  } catch {
    return false;
  }
  if (!run || run.status !== "completed") return false;
  if (run.conclusion !== "failure" && run.conclusion !== "timed_out") return false;

  const existing = await findAutoRetry(repo, run.id);

  // A previous attempt exists: settle its outcome if the run has concluded again.
  if (existing) {
    if (isPendingOutcome(existing.outcome) && (run.run_attempt ?? 1) > 1) {
      await updateOutcome(existing.id, "herhaling faalde — controle blijft rood");
    }
    return false; // only one automatic retry per run
  }

  // Decide whether the failure looks transient.
  const [errorLines, jobNames] = await Promise.all([
    failedRunErrorLines(repo, run.id),
    failedJobNames(repo, run.id),
  ]);

  // Never rerun deploy/release/migration/restart-like jobs.
  if (rerunForbidden([run.name, ...jobNames])) return false;

  const evidence = [...jobNames, ...errorLines];
  if (run.conclusion !== "timed_out" && !looksTransient(evidence)) return false;

  const reason =
    run.conclusion === "timed_out"
      ? "de controle liep vast op een tijdslimiet (timed_out)"
      : "de fout lijkt een tijdelijke hapering (netwerk/timeout/limiet), geen codefout";

  // Atomic claim FIRST: the unique index on (repo, run_id) for auto_retry
  // makes this insert fail for a second concurrent or repeated attempt.
  // No claim (conflict or DB error) → no rerun. Fail closed.
  const claimId = await logAction({
    kind: "auto_retry",
    action: `Mislukte controle automatisch één keer opnieuw gestart voor ${repo}`,
    repo,
    runId: String(run.id),
    reason,
    outcome: "herstart wordt gestart",
  });
  if (claimId === null) return false;

  const result = await rerunFailedJobs(repo, run.id);
  logger.info({ repo, runId: run.id, ok: result.ok }, "Automatische herhaling van mislukte controle");

  await updateOutcome(
    claimId,
    result.ok ? "herstart gestart, wacht op uitkomst" : `herstart mislukt: ${result.message}`,
  );

  return result.ok;
}

/**
 * Called when a repo turns green: if that green is the result of an
 * automatic retry, settle the log entry and report recovery.
 * Returns true when the repo "hersteld na herhaling".
 */
export async function settleRecovery(repo: string): Promise<boolean> {
  let run;
  try {
    run = (await latestRuns(repo, 1))[0];
  } catch {
    return false;
  }
  if (!run || run.conclusion !== "success" || (run.run_attempt ?? 1) <= 1) return false;

  const entry = await findAutoRetry(repo, run.id);
  if (!entry) return false;
  if (isPendingOutcome(entry.outcome)) {
    await updateOutcome(entry.id, "geslaagd — hersteld na herhaling");
  }
  return true;
}

/**
 * Whether a successful run recovered thanks to an automatic retry
 * (used to badge the repo as "hersteld na herhaling" in the overview).
 */
export async function wasRecoveredAfterRetry(
  repo: string,
  runId: number,
  runAttempt: number | undefined,
  conclusion: string | null,
): Promise<boolean> {
  if (conclusion !== "success" || (runAttempt ?? 1) <= 1) return false;
  return (await findAutoRetry(repo, runId)) !== null;
}
