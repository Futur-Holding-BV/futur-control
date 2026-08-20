/**
 * Bounded, non-destructive self-heal.
 *
 * A transient failed GitHub run may be re-run three times. A public service
 * may be restarted three times, but only through an explicitly configured
 * repository workflow named "herstart" with a workflow_dispatch trigger.
 * Every attempt is durably claimed before execution and written to the audit
 * log. Code, data, configuration, secrets, access and firewall policy are
 * never changed.
 */

import {
  dispatchRestartWorkflow,
  failedJobNames,
  failedRunErrorLines,
  findRestartWorkflow,
  latestRuns,
  loadWorkflowRunDefinition,
  rerunFailedJobs,
} from "./github.js";
import {
  claimSelfHealAttempt,
  findAutoRetry,
  getActiveSelfHealIncident,
  getSelfHealIncident,
  logAction,
  markSelfHealActionLogged,
  markSelfHealFailure,
  markSelfHealRecovered,
  markSelfHealRunning,
  markSelfHealUnavailable,
  updateOutcome,
  type SelfHealIncident,
} from "./actionlog.js";
import { logger } from "./logger.js";

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

/**
 * Same-version deploy/release/publish jobs are intentionally allowed.
 * Rollback, data, backup, settings, credentials, access and firewall actions
 * remain a hard boundary.
 */
const FORBIDDEN_RERUN_PATTERN =
  /rollback|roll[\s-]?back|terugdraai|migrat|(?:backup|back-up).{0,80}(?:restore|terugzett)|(?:restore|terugzett).{0,80}(?:backup|back-up)|\b(?:chmod|chown|setfacl|iptables|nft|firewall-cmd)\b|\bfirewall\b|\b(?:secrets?|geheim|credentials?|permissions?|rechten?|configuration|configuratie|settings?|instelling)\b.{0,80}\b(?:set|update|change|delete|remove|write|wijzig)\b|\b(?:set|update|change|delete|remove|write|wijzig)\b.{0,80}\b(?:secrets?|geheim|credentials?|permissions?|rechten?|configuration|configuratie|settings?|instelling)\b/i;

export const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000] as const;
const SERVICE_FINAL_OBSERVATION_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

export interface SelfHealDecision {
  holdNotification: boolean;
  escalationDetail: string | null;
}

const NO_ACTION: SelfHealDecision = {
  holdNotification: false,
  escalationDetail: null,
};

const HOLD: SelfHealDecision = {
  holdNotification: true,
  escalationDetail: null,
};

export function looksTransient(lines: string[]): boolean {
  return lines.some((line) => TRANSIENT_PATTERNS.some((pattern) => pattern.test(line)));
}

export function rerunForbidden(names: Array<string | null | undefined>): boolean {
  return names.some((name) => Boolean(name && FORBIDDEN_RERUN_PATTERN.test(name)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inspect every job, including dependants that rerun-failed-jobs may execute. */
export function workflowDefinitionForbidden(definition: unknown): boolean {
  if (!isRecord(definition) || !isRecord(definition["jobs"])) return true;
  const safeWriteScopes = new Set([
    "attestations",
    "checks",
    "contents",
    "deployments",
    "id-token",
    "packages",
    "pages",
    "statuses",
  ]);
  const permissionsForbidden = (permissions: unknown): boolean => {
    if (permissions === undefined || permissions === null) return false;
    if (typeof permissions === "string") {
      return permissions !== "read-all";
    }
    if (!isRecord(permissions)) return true;
    return Object.entries(permissions).some(
      ([scope, level]) =>
        String(level).toLowerCase() === "write" && !safeWriteScopes.has(scope),
    );
  };
  if (permissionsForbidden(definition["permissions"])) return true;
  for (const job of Object.values(definition["jobs"])) {
    if (isRecord(job) && permissionsForbidden(job["permissions"])) return true;
  }
  return FORBIDDEN_RERUN_PATTERN.test(JSON.stringify(definition["jobs"]));
}

function buildIncidentKey(repo: string, runId: number): string {
  return `build:${repo}:${runId}`;
}

function serviceIncidentKey(host: string, outageStartedAt: number): string {
  return `service:${host}:${outageStartedAt}`;
}

function retryAtAfterFailure(attempt: number, now: Date): Date | null {
  const delay = RETRY_DELAYS_MS[attempt - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay);
}

function historyDetail(incident: SelfHealIncident): string {
  const attempts =
    incident.history.length > 0
      ? incident.history.map((line) => `• ${line}`).join("\n")
      : "• De drie herstelpogingen zijn zonder herstel afgerond.";
  return `Automatisch herstel is na drie pogingen gestopt:\n${attempts}`;
}

async function recordFailure(input: {
  incident: SelfHealIncident;
  detail: string;
  now: Date;
}): Promise<SelfHealDecision> {
  const exhausted = input.incident.attempts >= MAX_ATTEMPTS;
  const updated = await markSelfHealFailure({
    incidentKey: input.incident.incidentKey,
    detail: input.detail,
    nextAttemptAt: exhausted
      ? null
      : retryAtAfterFailure(input.incident.attempts, input.now),
    exhausted,
    expectedAttempt: input.incident.attempts,
  });
  if (!updated) {
    const current = await getSelfHealIncident(input.incident.incidentKey);
    return current?.status === "exhausted"
      ? { holdNotification: false, escalationDetail: historyDetail(current) }
      : HOLD;
  }
  return exhausted && updated
    ? { holdNotification: false, escalationDetail: historyDetail(updated) }
    : HOLD;
}

async function executeBuildAttempt(input: {
  repo: string;
  runId: number;
  runAttempt: number;
  incident: SelfHealIncident;
  reason: string;
  now: Date;
}): Promise<SelfHealDecision> {
  const attempt = input.incident.attempts;
  const actionId = await logAction({
    kind: "auto_retry",
    action: `Mislukte controle automatisch opnieuw gestart voor ${input.repo} (poging ${attempt}/3)`,
    repo: input.repo,
    runId: String(input.runId),
    reason: input.reason,
    outcome: `poging ${attempt}/3 wordt gestart`,
  });
  if (actionId === null) {
    return recordFailure({
      incident: input.incident,
      detail: `Poging ${attempt}/3 is veilig afgebroken omdat het logboek niet kon worden bijgewerkt.`,
      now: input.now,
    });
  }
  const ownsAttempt = await markSelfHealActionLogged(
    input.incident.incidentKey,
    actionId,
    attempt,
  );
  if (!ownsAttempt) {
    await updateOutcome(actionId, `poging ${attempt}/3 niet uitgevoerd: claim niet meer geldig`);
    return HOLD;
  }

  const result = await rerunFailedJobs(input.repo, input.runId);
  logger.info(
    { repo: input.repo, runId: input.runId, attempt, ok: result.ok },
    "Automatische herhaling van mislukte controle",
  );

  if (result.ok) {
    await updateOutcome(actionId, `poging ${attempt}/3 gestart; wacht op de uitslag`);
    await markSelfHealRunning({
      incidentKey: input.incident.incidentKey,
      attempt,
      observedRunAttempt: input.runAttempt,
      actionLogId: actionId,
    });
    return HOLD;
  }

  const detail = `Poging ${attempt}/3 kon niet starten: ${result.message}`;
  await updateOutcome(actionId, detail);
  return recordFailure({ incident: input.incident, detail, now: input.now });
}

/**
 * Evaluates and advances the retry chain for the latest GitHub run.
 * A held notification is released only after a forbidden/non-transient
 * decision or after all three attempts have failed.
 */
export async function maybeAutoRetry(
  repo: string,
  now = new Date(),
): Promise<SelfHealDecision> {
  let run;
  try {
    run = (await latestRuns(repo, 1))[0];
  } catch {
    return NO_ACTION;
  }
  if (!run) return NO_ACTION;

  const incidentKey = buildIncidentKey(repo, run.id);
  let incident = await getSelfHealIncident(incidentKey);

  if (incident?.status === "exhausted") {
    return { holdNotification: false, escalationDetail: historyDetail(incident) };
  }
  if (incident?.status === "recovered" || incident?.status === "unavailable") {
    return NO_ACTION;
  }
  if (incident?.status === "starting") {
    const staleAt = incident.updatedAt.getTime() + 10 * 60_000;
    if (now.getTime() < staleAt) return HOLD;
    if (incident.lastActionLogId !== null) {
      await updateOutcome(
        incident.lastActionLogId,
        `poging ${incident.attempts}/3 heeft na een serveronderbreking een onbekende uitkomst en telt veilig als verbruikt`,
      );
    }
    const reclaimed = await claimSelfHealAttempt({
      incidentKey,
      kind: "build_retry",
      repo,
      targetId: String(run.id),
      now,
    });
    if (!reclaimed) {
      return recordFailure({
        incident,
        detail: `Poging ${incident.attempts}/3 heeft door een serveronderbreking een onbekende uitkomst en wordt niet opnieuw uitgevoerd.`,
        now,
      });
    }
    return executeBuildAttempt({
      repo,
      runId: run.id,
      runAttempt: run.run_attempt ?? 1,
      incident: reclaimed,
      reason: "een eerder geclaimde poging werd na een serveronderbreking veilig hervat",
      now,
    });
  }

  if (incident?.status === "running") {
    if (
      run.status !== "completed" ||
      (run.run_attempt ?? 1) <= (incident.observedRunAttempt ?? 1)
    ) {
      return HOLD;
    }
    if (run.conclusion === "success") return HOLD;

    const detail = `Poging ${incident.attempts}/3 is afgerond maar de controle bleef ${run.conclusion ?? "rood"}.`;
    if (incident.lastActionLogId !== null) {
      await updateOutcome(incident.lastActionLogId, detail);
    }
    return recordFailure({ incident, detail, now });
  }

  if (incident?.status === "waiting") {
    if (!incident.nextAttemptAt || incident.nextAttemptAt.getTime() > now.getTime()) {
      return HOLD;
    }
    const claim = await claimSelfHealAttempt({
      incidentKey,
      kind: "build_retry",
      repo,
      targetId: String(run.id),
      now,
    });
    if (!claim) return HOLD;
    return executeBuildAttempt({
      repo,
      runId: run.id,
      runAttempt: run.run_attempt ?? 1,
      incident: claim,
      reason: "de vorige automatische herhaling loste de tijdelijke storing niet op",
      now,
    });
  }

  if (run.status !== "completed") return NO_ACTION;
  if (run.conclusion !== "failure" && run.conclusion !== "timed_out") return NO_ACTION;

  const [errorLines, jobNames] = await Promise.all([
    failedRunErrorLines(repo, run.id),
    failedJobNames(repo, run.id),
  ]);
  const names = [run.name, ...jobNames];
  let workflowDefinition: unknown | null = null;
  try {
    workflowDefinition = await loadWorkflowRunDefinition(repo, run);
  } catch (err) {
    logger.warn({ err, repo, runId: run.id }, "Workflowdefinitie controleren mislukt");
  }
  if (
    rerunForbidden(names) ||
    workflowDefinition === null ||
    workflowDefinitionForbidden(workflowDefinition)
  ) {
    return {
      holdNotification: false,
      escalationDetail:
        "Geen automatisch herstel uitgevoerd: de volledige workflow kon niet veilig worden goedgekeurd of bevat een verboden rollback-, migratie-, back-upherstel-, instellingen-, geheimen-, rechten- of firewallactie.",
    };
  }

  const evidence = [...jobNames, ...errorLines];
  if (run.conclusion !== "timed_out" && !looksTransient(evidence)) return NO_ACTION;

  const claim = await claimSelfHealAttempt({
    incidentKey,
    kind: "build_retry",
    repo,
    targetId: String(run.id),
    now,
  });
  if (!claim) return HOLD;
  const reason =
    run.conclusion === "timed_out"
      ? "de controle liep vast op een tijdslimiet (timed_out)"
      : "de fout lijkt een tijdelijke hapering (netwerk/timeout/limiet), geen codefout";
  return executeBuildAttempt({
    repo,
    runId: run.id,
    runAttempt: run.run_attempt ?? 1,
    incident: claim,
    reason,
    now,
  });
}

export async function settleRecovery(repo: string): Promise<boolean> {
  let run;
  try {
    run = (await latestRuns(repo, 1))[0];
  } catch {
    return false;
  }
  if (!run || run.conclusion !== "success" || (run.run_attempt ?? 1) <= 1) return false;

  const incident = await getSelfHealIncident(buildIncidentKey(repo, run.id));
  if (!incident || incident.status === "recovered") {
    return (await findAutoRetry(repo, run.id)) !== null;
  }
  if (incident.lastActionLogId !== null) {
    await updateOutcome(
      incident.lastActionLogId,
      `geslaagd — hersteld na ${incident.attempts} automatische poging(en)`,
    );
  }
  await markSelfHealRecovered(incident.incidentKey);
  return true;
}

/** Parse the explicit host=repository mapping used for safe service restarts. */
export function restartRepoForHost(host: string): string | null {
  for (const part of (process.env["SERVICE_RESTART_REPOS"] ?? "").split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const mappedHost = part.slice(0, separator).trim();
    const repo = part.slice(separator + 1).trim();
    if (mappedHost === host && repo) return repo;
  }
  return null;
}

async function executeServiceAttempt(input: {
  host: string;
  repo: string;
  incident: SelfHealIncident;
  now: Date;
}): Promise<SelfHealDecision> {
  const attempt = input.incident.attempts;
  let workflow;
  try {
    workflow = await findRestartWorkflow(input.repo);
  } catch (err) {
    await markSelfHealUnavailable(input.incident.incidentKey);
    logger.warn({ err, repo: input.repo, host: input.host }, "Herstartworkflow controleren mislukt");
    return {
      holdNotification: false,
      escalationDetail: `Geen automatische herstart uitgevoerd: de herstartworkflow van ${input.repo} kon niet veilig worden gecontroleerd.`,
    };
  }
  if (!workflow) {
    await markSelfHealUnavailable(input.incident.incidentKey);
    return {
      holdNotification: false,
      escalationDetail: `Geen automatische herstart uitgevoerd: ${input.repo} biedt geen veilig vastgezette workflow_dispatch met exact de naam “herstart” in een onveranderlijke GitHub Release.`,
    };
  }
  if (workflowDefinitionForbidden(workflow.definition)) {
    await markSelfHealUnavailable(input.incident.incidentKey);
    return {
      holdNotification: false,
      escalationDetail:
        `Geen automatische herstart uitgevoerd: de workflow “herstart” van ${input.repo} bevat een verboden rollback-, migratie-, back-upherstel-, instellingen-, geheimen-, rechten- of firewallactie.`,
    };
  }

  const actionId = await logAction({
    kind: "auto_restart",
    action: `Dienst ${input.host} automatisch herstart via ${input.repo} (poging ${attempt}/3)`,
    repo: input.repo,
    runId: input.incident.incidentKey,
    reason: "De publieke HTTPS-dienst bleef onbereikbaar en de repo biedt een expliciete herstartworkflow.",
    outcome: `poging ${attempt}/3 wordt gestart`,
  });
  if (actionId === null) {
    return recordFailure({
      incident: input.incident,
      detail: `Poging ${attempt}/3 is veilig afgebroken omdat het logboek niet kon worden bijgewerkt.`,
      now: input.now,
    });
  }
  const ownsAttempt = await markSelfHealActionLogged(
    input.incident.incidentKey,
    actionId,
    attempt,
  );
  if (!ownsAttempt) {
    await updateOutcome(actionId, `poging ${attempt}/3 niet uitgevoerd: claim niet meer geldig`);
    return HOLD;
  }

  const result = await dispatchRestartWorkflow(input.repo, workflow);
  if (!result.ok) {
    const detail = `Poging ${attempt}/3 kon niet starten: ${result.message}`;
    await updateOutcome(actionId, detail);
    return recordFailure({ incident: input.incident, detail, now: input.now });
  }

  const observationDelay =
    RETRY_DELAYS_MS[attempt - 1] ?? SERVICE_FINAL_OBSERVATION_MS;
  await updateOutcome(actionId, `poging ${attempt}/3 gestart; wacht op bereikbaarheidscontrole`);
  await markSelfHealRunning({
    incidentKey: input.incident.incidentKey,
    attempt,
    actionLogId: actionId,
    nextAttemptAt: new Date(input.now.getTime() + observationDelay),
  });
  return HOLD;
}

export async function maybeAutoRestartService(input: {
  host: string;
  repo: string;
  outageStartedAt: number;
  now?: Date;
}): Promise<SelfHealDecision> {
  const now = input.now ?? new Date();
  const incidentKey = serviceIncidentKey(input.host, input.outageStartedAt);
  let incident = await getSelfHealIncident(incidentKey);

  if (incident?.status === "unavailable") {
    return {
      holdNotification: false,
      escalationDetail: `Geen automatische herstart uitgevoerd: ${input.repo} biedt geen bruikbare herstartworkflow.`,
    };
  }
  if (incident?.status === "exhausted") {
    return { holdNotification: false, escalationDetail: historyDetail(incident) };
  }
  if (incident?.status === "recovered") return NO_ACTION;
  if (incident?.status === "starting") {
    const staleAt = incident.updatedAt.getTime() + 10 * 60_000;
    if (now.getTime() < staleAt) return HOLD;
    if (incident.lastActionLogId !== null) {
      await updateOutcome(
        incident.lastActionLogId,
        `poging ${incident.attempts}/3 heeft na een serveronderbreking een onbekende uitkomst en telt veilig als verbruikt`,
      );
    }
    const reclaimed = await claimSelfHealAttempt({
      incidentKey,
      kind: "service_restart",
      repo: input.repo,
      targetId: input.host,
      now,
    });
    if (!reclaimed) {
      return recordFailure({
        incident,
        detail: `Poging ${incident.attempts}/3 heeft door een serveronderbreking een onbekende uitkomst en wordt niet opnieuw uitgevoerd.`,
        now,
      });
    }
    return executeServiceAttempt({
      host: input.host,
      repo: input.repo,
      incident: reclaimed,
      now,
    });
  }

  if (incident?.status === "running") {
    if (incident.nextAttemptAt && incident.nextAttemptAt.getTime() > now.getTime()) {
      return HOLD;
    }
    const detail = `Poging ${incident.attempts}/3 is uitgevoerd maar ${input.host} bleef onbereikbaar.`;
    if (incident.lastActionLogId !== null) {
      await updateOutcome(incident.lastActionLogId, detail);
    }
    const exhausted = incident.attempts >= MAX_ATTEMPTS;
    const updated = await markSelfHealFailure({
      incidentKey,
      detail,
      nextAttemptAt: exhausted ? null : now,
      exhausted,
      expectedAttempt: incident.attempts,
    });
    if (!updated) {
      const current = await getSelfHealIncident(incidentKey);
      return current?.status === "exhausted"
        ? { holdNotification: false, escalationDetail: historyDetail(current) }
        : HOLD;
    }
    if (exhausted) {
      return { holdNotification: false, escalationDetail: historyDetail(updated) };
    }
    incident = updated;
  }

  if (incident?.status === "waiting" && incident.nextAttemptAt) {
    if (incident.nextAttemptAt.getTime() > now.getTime()) return HOLD;
  }

  const claim = await claimSelfHealAttempt({
    incidentKey,
    kind: "service_restart",
    repo: input.repo,
    targetId: input.host,
    now,
  });
  if (!claim) return HOLD;
  return executeServiceAttempt({
    host: input.host,
    repo: input.repo,
    incident: claim,
    now,
  });
}

export async function settleServiceRecovery(host: string, repo: string): Promise<boolean> {
  const incident = await getActiveSelfHealIncident({
    kind: "service_restart",
    repo,
    targetId: host,
  });
  if (!incident) return false;
  if (incident.lastActionLogId !== null) {
    await updateOutcome(
      incident.lastActionLogId,
      `geslaagd — ${host} is weer bereikbaar na poging ${incident.attempts}/3`,
    );
  }
  await markSelfHealRecovered(incident.incidentKey);
  return true;
}

export async function wasRecoveredAfterRetry(
  repo: string,
  runId: number,
  runAttempt: number | undefined,
  conclusion: string | null,
): Promise<boolean> {
  if (conclusion !== "success" || (runAttempt ?? 1) <= 1) return false;
  return (await findAutoRetry(repo, runId)) !== null;
}
