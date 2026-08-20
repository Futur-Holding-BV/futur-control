import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Outbox for e-mail notifications that could not be delivered via
 * Microsoft Graph. Each failed send is stored with its error message and
 * an attempt counter; the background monitor retries every poll cycle.
 * After a generous upper bound the failure is loudly written to the
 * action log — a mail is never silently dropped.
 */
export const mailOutbox = pgTable("mail_outbox", {
  id: serial("id").primaryKey(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  /** Last error message from Graph (or the network layer). */
  lastError: text("last_error").notNull(),
  /** Number of delivery attempts so far (including the original one). */
  attempts: integer("attempts").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type MailOutboxRow = typeof mailOutbox.$inferSelect;
