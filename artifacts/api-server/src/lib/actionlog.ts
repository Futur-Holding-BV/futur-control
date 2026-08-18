/**
 * Audit log for automatic self-heal actions and manually approved
 * one-tap actions. Every entry records what, when, why, and outcome.
 */

import { db, actionLog } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "./logger.js";

export interface LogActionInput {
  kind: "auto_retry" | "manual_rerun" | "melding_onderdrukt" | "extern_lezen";
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
    await db.update(actionLog).set({ outcome }).where(eq(actionLog.id, id));
  } catch (err) {
    logger.error({ err, id }, "Logboek: bijwerken van uitkomst mislukt");
  }
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
          eq(actionLog.runId, String(runId)),
        ),
      )
      .orderBy(desc(actionLog.id))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function listRecentActions(limit = 100) {
  return db
    .select()
    .from(actionLog)
    .orderBy(desc(actionLog.createdAt), desc(actionLog.id))
    .limit(limit);
}
