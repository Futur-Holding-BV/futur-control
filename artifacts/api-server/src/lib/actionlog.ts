/**
 * Audit log for automatic self-heal actions and manually approved
 * one-tap actions. Every entry records what, when, why, and outcome.
 */

import { db, actionLog, pool } from "@workspace/db";
import { and, desc, eq, like, or } from "drizzle-orm";
import { logger } from "./logger.js";

export interface LogActionInput {
  kind:
    | "auto_retry"
    | "auto_restart"
    | "manual_rerun"
    | "melding_onderdrukt"
    | "extern_lezen"
    | "mail_mislukt"
    | "bevinding_opgelost";

  action: string;

  repo?: string | null;

  runId?: string | null;

  reason: string;

  outcome: string;
}

export async function logAction(input: LogActionInput): Promise<number | null> {
  try {
    const rows = await db
      .insert(actionLog)
      .values({
        kind: input.kind,
        action: input.action,
        repo: input.repo ?? null,
        runId: input.runId ?? null,
        reason: input.reason,
        outcome: input.outcome,
      })
      .returning({ id: actionLog.id });
    return rows[0]?.id ?? null;
  } catch (err) {
    logger.error({ err }, "Logboek: wegschrijven van actie mislukt");
    return null;
  }
}

export async function updateOutcome(id: number, outcome: string): Promise<void> {
  try {
    await db
      .update(actionLog)
      .set({ outcome, reportedAt: null })
      .where(eq(actionLog.id, id));
  } catch (err) {
    logger.error({ err, id }, "Logboek: bijwerken van uitkomst mislukt");
  }
}

export async function markActionsReported(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    "UPDATE action_log SET reported_at = now() WHERE id = ANY($1::int[])",
    [ids],
  );
}

/** Latest auto-retry entry for a specific run, or null. */
export async function findAutoRetry(
  repo: string,
  runId: number,
): Promise<{ id: number; outcome: string } | null> {
  try {
    const rows = await db
      .select({ id: actionLog.id, outcome: actionLog.outcome })
      .from(actionLog)
      .where(
        and(
          eq(actionLog.kind, "auto_retry"),
          eq(actionLog.repo, repo),
          or(
            eq(actionLog.runId, String(runId)),
            like(actionLog.runId, `${runId}:attempt:%`),
          ),
        ),
      )
      .orderBy(desc(actionLog.id))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export type SelfHealKind = "build_retry" | "service_restart";
export type SelfHealStatus =
  | "starting"
  | "running"
  | "waiting"
  | "exhausted"
  | "recovered"
  | "unavailable";

export interface SelfHealIncident {
  incidentKey: string;
  kind: SelfHealKind;
  repo: string;
  targetId: string;
  attempts: number;
  status: SelfHealStatus;
  nextAttemptAt: Date | null;
  observedRunAttempt: number | null;
  lastActionLogId: number | null;
  history: string[];
  updatedAt: Date;
}

interface IncidentRow {
  incident_key: string;
  kind: SelfHealKind;
  repo: string;
  target_id: string;
  attempts: number;
  status: SelfHealStatus;
  next_attempt_at: Date | null;
  observed_run_attempt: number | null;
  last_action_log_id: number | null;
  history: unknown;
  updated_at: Date;
}

function toIncident(row: IncidentRow): SelfHealIncident {
  return {
    incidentKey: row.incident_key,
    kind: row.kind,
    repo: row.repo,
    targetId: row.target_id,
    attempts: row.attempts,
    status: row.status,
    nextAttemptAt: row.next_attempt_at,
    observedRunAttempt: row.observed_run_attempt,
    lastActionLogId: row.last_action_log_id,
    history: Array.isArray(row.history)
      ? row.history.filter((item): item is string => typeof item === "string")
      : [],
    updatedAt: row.updated_at,
  };
}

export async function getSelfHealIncident(
  incidentKey: string,
): Promise<SelfHealIncident | null> {
  const result = await pool.query<IncidentRow>(
    `SELECT incident_key, kind, repo, target_id, attempts, status,
            next_attempt_at, observed_run_attempt, last_action_log_id, history, updated_at
       FROM self_heal_incidents WHERE incident_key = $1`,
    [incidentKey],
  );
  return result.rows[0] ? toIncident(result.rows[0]) : null;
}

export async function getActiveSelfHealIncident(input: {
  kind: SelfHealKind;
  repo: string;
  targetId: string;
}): Promise<SelfHealIncident | null> {
  const result = await pool.query<IncidentRow>(
    `SELECT incident_key, kind, repo, target_id, attempts, status,
            next_attempt_at, observed_run_attempt, last_action_log_id, history, updated_at
       FROM self_heal_incidents
      WHERE kind = $1 AND repo = $2 AND target_id = $3
        AND status IN ('starting', 'running', 'waiting')
      ORDER BY created_at DESC LIMIT 1`,
    [input.kind, input.repo, input.targetId],
  );
  return result.rows[0] ? toIncident(result.rows[0]) : null;
}

/**
 * Atomically owns the next attempt. A concurrent monitor receives null and
 * therefore cannot execute the same recovery action twice.
 */
export async function claimSelfHealAttempt(input: {
  incidentKey: string;
  kind: SelfHealKind;
  repo: string;
  targetId: string;
  now: Date;
}): Promise<SelfHealIncident | null> {
  const result = await pool.query<IncidentRow>(
    `INSERT INTO self_heal_incidents
       (incident_key, kind, repo, target_id, attempts, status, updated_at)
     VALUES ($1, $2, $3, $4, 1, 'starting', $5)
     ON CONFLICT (incident_key) DO UPDATE SET
       attempts = self_heal_incidents.attempts + 1,
       status = 'starting',
       next_attempt_at = NULL,
       updated_at = EXCLUDED.updated_at
     WHERE self_heal_incidents.attempts < 3 AND (
       (self_heal_incidents.status = 'waiting'
         AND self_heal_incidents.next_attempt_at <= EXCLUDED.updated_at)
       OR
       (self_heal_incidents.status = 'starting'
         AND self_heal_incidents.updated_at <= EXCLUDED.updated_at - interval '10 minutes')
     )
     RETURNING incident_key, kind, repo, target_id, attempts, status,
               next_attempt_at, observed_run_attempt, last_action_log_id, history, updated_at`,
    [input.incidentKey, input.kind, input.repo, input.targetId, input.now],
  );
  return result.rows[0] ? toIncident(result.rows[0]) : null;
}

export async function markSelfHealActionLogged(
  incidentKey: string,
  actionLogId: number,
  attempt: number,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE self_heal_incidents
        SET last_action_log_id = $2, updated_at = now()
      WHERE incident_key = $1 AND status = 'starting' AND attempts = $3`,
    [incidentKey, actionLogId, attempt],
  );
  return Boolean(result.rowCount);
}

export async function markSelfHealRunning(input: {
  incidentKey: string;
  attempt: number;
  observedRunAttempt?: number | null;
  actionLogId: number;
  nextAttemptAt?: Date | null;
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE self_heal_incidents SET
       status = 'running',
       observed_run_attempt = COALESCE($3, observed_run_attempt),
       last_action_log_id = $4,
       next_attempt_at = $5,
       updated_at = now()
     WHERE incident_key = $1 AND attempts = $2 AND status = 'starting'`,
    [
      input.incidentKey,
      input.attempt,
      input.observedRunAttempt ?? null,
      input.actionLogId,
      input.nextAttemptAt ?? null,
    ],
  );
  return Boolean(result.rowCount);
}

export async function markSelfHealFailure(input: {
  incidentKey: string;
  detail: string;
  nextAttemptAt: Date | null;
  exhausted: boolean;
  expectedAttempt: number;
}): Promise<SelfHealIncident | null> {
  const result = await pool.query<IncidentRow>(
    `UPDATE self_heal_incidents SET
       status = $2,
       next_attempt_at = $3,
       history = history || jsonb_build_array($4::text),
       updated_at = now()
     WHERE incident_key = $1
       AND attempts = $5
       AND status IN ('starting', 'running')
     RETURNING incident_key, kind, repo, target_id, attempts, status,
               next_attempt_at, observed_run_attempt, last_action_log_id, history, updated_at`,
    [
      input.incidentKey,
      input.exhausted ? "exhausted" : "waiting",
      input.nextAttemptAt,
      input.detail,
      input.expectedAttempt,
    ],
  );
  return result.rows[0] ? toIncident(result.rows[0]) : null;
}

export async function markSelfHealRecovered(incidentKey: string): Promise<void> {
  await pool.query(
    `UPDATE self_heal_incidents
        SET status = 'recovered', next_attempt_at = NULL, updated_at = now()
      WHERE incident_key = $1`,
    [incidentKey],
  );
}

export async function markSelfHealUnavailable(incidentKey: string): Promise<void> {
  await pool.query(
    `UPDATE self_heal_incidents
        SET status = 'unavailable', next_attempt_at = NULL, updated_at = now()
      WHERE incident_key = $1`,
    [incidentKey],
  );
}

export async function listRecentActions(limit = 100) {
  return db
    .select()
    .from(actionLog)
    .orderBy(desc(actionLog.createdAt), desc(actionLog.id))
    .limit(limit);
}
