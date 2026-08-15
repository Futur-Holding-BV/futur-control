import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Persistent brute-force counter for login attempts.
 * One row per IP address; replaced on each new sliding window.
 */
export const loginAttempts = pgTable("login_attempts", {
  ip: text("ip").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
});

export type LoginAttemptRow = typeof loginAttempts.$inferSelect;
