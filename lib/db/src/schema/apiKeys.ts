import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Server-generated API keys for read-only machine-to-machine access
 * (e.g. the Connect dashboard block fetching the status summary).
 * Generated once at first use, stable afterwards. One row per purpose.
 */
export const apiKeys = pgTable("api_keys", {
  /** Purpose of the key, e.g. 'status-lees'. */
  name: text("name").primaryKey(),
  key: text("key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type ApiKeyRow = typeof apiKeys.$inferSelect;
