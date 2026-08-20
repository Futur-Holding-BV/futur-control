import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Persistent operator-facing findings, independent from transient monitor snapshots. */
export const findings = pgTable("findings", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  level: text("level").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  autoResolved: boolean("auto_resolved").notNull().default(false),
  immediateSentAt: timestamp("immediate_sent_at", { withTimezone: true }),
  dailySentOn: text("daily_sent_on"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/** Editable delivery policy. The seeded values are the product defaults. */
export const findingLevels = pgTable("finding_levels", {
  kind: text("kind").primaryKey(),
  level: text("level").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/** State for availability debounce and the once-per-day report lock. */
export const monitorState = pgTable("monitor_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});