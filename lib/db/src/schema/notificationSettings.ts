import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Single-row table holding the Slack webhook configuration.
 * Row with id=1 is created on first save and updated thereafter.
 */
export const notificationSettings = pgTable("notification_settings", {
  id: serial("id").primaryKey(),
  /** Incoming-webhook URL (e.g. https://hooks.slack.com/services/…) */
  slackWebhookUrl: text("slack_webhook_url"),
  /** Whether notifications are active */
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type InsertNotificationSettings =
  typeof notificationSettings.$inferInsert;
