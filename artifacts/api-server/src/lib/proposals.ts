/**
 * One-tap proposals: repairs the beheercentrum knows how to execute but
 * that contain a decision. Nothing runs until the user presses the button
 * (POST /actions/proposals/{id}/execute).
 *
 * Hard boundaries — NEVER proposed or executed:
 *   code changes, database changes, production restarts, deploys.
 * The only implemented action is re-running an existing GitHub Actions
 * check, which changes nothing in the codebase.
 */

import {
  listMonitoredRepos,
  latestRuns,
  rerunFailedJobs,
  failedJobNames,
  GitHubError,
} from "./github.js";
import { findAutoRetry, logAction } from "./actionlog.js";
import { rerunForbidden } from "./selfheal.js";

export interface Proposal {
  id: string;
  title: string;
  description: string;
  actionDescription: string;
  repo: string | null;
}

/**
 * Proposal ids encode the exact action + target, so an execute call can
 * verify the situation is still current (no stale button presses).
 * Format: rerun:<repo>:<runId>
 */
export async function listProposals(): Promise<Proposal[]> {
  const repos = await listMonitoredRepos();
  const proposals: Proposal[] = [];

  await Promise.all(
    repos.map(async (repo) => {
      let run;
      try {
        run = (await latestRuns(repo, 1))[0];
      } catch {
        return;
      }
      if (!run || run.status !== "completed") return;
      if (run.conclusion !== "failure" && run.conclusion !== "timed_out") return;

      // Deploy/release/migration/restart-like jobs are never rerun,
      // so they are never proposed either.
      const jobNames = await failedJobNames(repo, run.id);
      if (rerunForbidden([run.name, ...jobNames])) return;

      const autoRetry = await findAutoRetry(repo, run.id);
      const alreadyRetried = autoRetry !== null;

      proposals.push({
        id: `rerun:${repo}:${run.id}`,
        title: `Controle opnieuw uitvoeren voor ${repo}`,
        description: alreadyRetried
          ? `De laatste controle van ${repo} is rood en de automatische herhaling loste het niet op. Een handmatige herstart kan zinvol zijn als het probleem inmiddels verholpen is.`
          : `De laatste controle van ${repo} is rood. De oorzaak lijkt geen tijdelijke hapering, dus er is niet automatisch opnieuw geprobeerd.`,
        actionDescription:
          "Start exact dezelfde mislukte controle nogmaals op GitHub. Wijzigt geen code, geen database en raakt productie niet aan.",
        repo,
      });
    }),
  );

  proposals.sort((a, b) => a.id.localeCompare(b.id));
  return proposals;
}

export interface ExecuteResult {
  status: number; // 200 | 404 | 502
  success: boolean;
  message: string;
}

export async function executeProposal(id: string): Promise<ExecuteResult> {
  const match = id.match(/^rerun:([^:]+):(\d+)$/);
  if (!match) {
    return { status: 404, success: false, message: "Onbekend voorstel." };
  }
  const repo = match[1]!;
  const runId = Number(match[2]!);

  // Staleness check: the run must still be the latest, completed and red.
  let run;
  try {
    run = (await latestRuns(repo, 1))[0];
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      return { status: 404, success: false, message: "Onbekend voorstel." };
    }
    if (err instanceof GitHubError) {
      return { status: 502, success: false, message: "GitHub was niet bereikbaar. Probeer het zo opnieuw." };
    }
    throw err;
  }
  if (
    !run ||
    run.id !== runId ||
    run.status !== "completed" ||
    (run.conclusion !== "failure" && run.conclusion !== "timed_out")
  ) {
    return {
      status: 404,
      success: false,
      message: "Dit voorstel is verouderd: de situatie is inmiddels veranderd. Ververs het overzicht.",
    };
  }

  // Re-verify the hard boundary at execute time as well.
  const jobNames = await failedJobNames(repo, runId);
  if (rerunForbidden([run.name, ...jobNames])) {
    return {
      status: 404,
      success: false,
      message:
        "Deze controle bevat een deploy- of herstartstap en wordt daarom nooit opnieuw gestart vanuit het beheercentrum.",
    };
  }

  const result = await rerunFailedJobs(repo, runId);

  await logAction({
    kind: "manual_rerun",
    action: `Mislukte controle handmatig opnieuw gestart voor ${repo} (goedgekeurd via knop)`,
    repo,
    runId: String(runId),
    reason: "gebruiker keurde het voorstel in het beheercentrum goed",
    outcome: result.ok ? "herstart gestart op GitHub" : `herstart mislukt: ${result.message}`,
  });

  return {
    status: result.ok ? 200 : 502,
    success: result.ok,
    message: result.ok
      ? "De controle is opnieuw gestart op GitHub. De uitslag verschijnt hier zodra hij klaar is."
      : result.message,
  };
}
