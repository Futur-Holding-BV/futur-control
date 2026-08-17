import { pgTable, text, integer } from "drizzle-orm/pg-core";

/**
 * Per-repository monitoring settings.
 *
 * Staleness thresholds (in days without a commit) are stored here so a
 * project that is deliberately paused can get higher thresholds and does
 * not raise false alarms. Repos without a row use the defaults (7 / 14).
 */
export const repoSettings = pgTable("repo_settings", {
  repo: text("repo").primaryKey(),
  staleYellowDays: integer("stale_yellow_days").notNull().default(7),
  staleRedDays: integer("stale_red_days").notNull().default(14),
});
