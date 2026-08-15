import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-repository monitoring state.
 *
 * Two status fields intentionally separated:
 *   status          — the last OBSERVED status fetched from GitHub (always current)
 *   notifiedStatus  — the last status for which a Slack notification was
 *                     successfully delivered. Only advanced after the Slack
 *                     POST returns 200.  This ensures that a failed delivery
 *                     leaves notifiedStatus behind so the next poll retries.
 */
export const repoStatusSnapshots = pgTable("repo_status_snapshots", {
  repoName: text("repo_name").primaryKey(),
  /** Last status fetched from GitHub (green | red | gray) */
  status: text("status").notNull().default("gray"),
  /** Last status for which Slack notification was successfully delivered */
  notifiedStatus: text("notified_status").notNull().default("gray"),
  /** SHA of the anomaly commit for which a Slack notification was delivered */
  notifiedAnomalySha: text("notified_anomaly_sha"),
  /**
   * When the most recent red Slack notification was delivered (initial alert or
   * reminder).  Null until the first red notification is sent.  Used to
   * throttle reminder messages: a follow-up is only sent once the repo has been
   * continuously red for longer than REMINDER_INTERVAL_MS since this timestamp.
   * Reset to null on recovery.
   */
  lastRedNotifiedAt: timestamp("last_red_notified_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type RepoStatusSnapshot = typeof repoStatusSnapshots.$inferSelect;
export type InsertRepoStatusSnapshot =
  typeof repoStatusSnapshots.$inferInsert;
