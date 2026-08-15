import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Audit log of every automatic self-heal action and every manually
 * approved one-tap action. Read-only towards the codebases: the only
 * actions ever logged here are GitHub Actions re-runs.
 */
export const actionLog = pgTable("action_log", {
  id: serial("id").primaryKey(),
  /** Machine-readable kind: auto_retry | manual_rerun */
  kind: text("kind").notNull(),
  /** Plain-language description of what was done (Dutch) */
  action: text("action").notNull(),
  repo: text("repo"),
  /** GitHub Actions run id the action applied to (as string) */
  runId: text("run_id"),
  /** Why the action was taken */
  reason: text("reason").notNull(),
  /** Plain-language outcome; updated when the result becomes known */
  outcome: text("outcome").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type ActionLogEntry = typeof actionLog.$inferSelect;
export type InsertActionLogEntry = typeof actionLog.$inferInsert;
