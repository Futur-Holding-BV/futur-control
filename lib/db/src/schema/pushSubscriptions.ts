import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Web-push subscriptions of installed PWA clients (Android/iOS/desktop).
 * One row per browser/device endpoint. Rows are removed automatically when
 * the push service reports the subscription gone (HTTP 404/410).
 */
export const pushSubscriptions = pgTable("push_subscriptions", {
  /** Unique push endpoint URL — natural primary key. */
  endpoint: text("endpoint").primaryKey(),
  /** Client public key (p256dh) for payload encryption. */
  p256dh: text("p256dh").notNull(),
  /** Client auth secret for payload encryption. */
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/**
 * Server VAPID key pair for web push. Generated once at first use and kept
 * stable afterwards (changing it would invalidate all subscriptions).
 * Single row with id = 'default'.
 */
export const vapidKeys = pgTable("vapid_keys", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
});
