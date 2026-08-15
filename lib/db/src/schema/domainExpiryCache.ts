import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Persists the most recent successful RDAP expiry date per domain.
 * Written on every successful RDAP fetch so the stale fallback survives
 * a server restart during an RDAP outage.
 */
export const domainExpiryCache = pgTable("domain_expiry_cache", {
  domain: text("domain").primaryKey(),
  /** The expiry date returned by RDAP. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** When the RDAP fetch that produced this date was made. */
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export type DomainExpiryCacheRow = typeof domainExpiryCache.$inferSelect;
