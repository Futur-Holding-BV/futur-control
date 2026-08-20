/**
 * E-mail channel via Microsoft Graph (client-credentials flow, no SMTP).
 *
 * Configuration comes exclusively from environment variables (Replit Secrets):
 *   GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET — app registration
 *   MAIL_FROM — sending mailbox (must be allowed for the app registration)
 *   MAIL_TO   — recipient address(es), comma-separated
 *
 * Behaviour:
 *   • Missing configuration is logged ONCE at first use and only disables the
 *     mail channel — Slack and push keep working.
 *   • The access token is cached until ~60 s before expiry; never a fresh
 *     token per message.
 *   • A failed send is stored in the mail_outbox table with the error message
 *     and an attempt counter, and is retried on every monitor cycle. After a
 *     generous upper bound the failure is loudly written to the action log —
 *     a mail is never silently dropped.
 */

import { db, mailOutbox, pool } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logAction } from "./actionlog.js";
import { logger } from "./logger.js";

const GRAPH_TIMEOUT_MS = 15_000;

/** Refresh the token this many ms before its actual expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** After this many attempts the outbox entry is loudly logged and removed. */
export const MAX_OUTBOX_ATTEMPTS = 20;
const DAILY_REPORT_SUBJECT = /^📋 Dagbericht (\d{4}-\d{2}-\d{2}): bewaking draait$/;
const DAILY_REPORT_ACCEPTED = /^daily-report-accepted:(\d{4}-\d{2}-\d{2})$/;
const mailRowsAwaitingDailyConfirmation = new Set<number>();

interface MailConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  from: string;
  to: string[];
}

let missingConfigLogged = false;

/**
 * Reads the mail configuration from the environment. When anything is
 * missing, logs ONE clear line (first call only) and returns null — the
 * mail channel is then simply off; nothing else is affected.
 */
export function getMailConfig(): MailConfig | null {
  const tenantId = process.env["GRAPH_TENANT_ID"] ?? "";
  const clientId = process.env["GRAPH_CLIENT_ID"] ?? "";
  const clientSecret = process.env["GRAPH_CLIENT_SECRET"] ?? "";
  const from = process.env["MAIL_FROM"] ?? "";
  const to = (process.env["MAIL_TO"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const missing: string[] = [];
  if (!tenantId) missing.push("GRAPH_TENANT_ID");
  if (!clientId) missing.push("GRAPH_CLIENT_ID");
  if (!clientSecret) missing.push("GRAPH_CLIENT_SECRET");
  if (!from) missing.push("MAIL_FROM");
  if (to.length === 0) missing.push("MAIL_TO");

  if (missing.length > 0) {
    if (!missingConfigLogged) {
      missingConfigLogged = true;
      logger.warn(
        { missing },
        "E-mailkanaal uitgeschakeld: mailinstellingen ontbreken — Slack en push blijven gewoon werken",
      );
    }
    return null;
  }
  return { tenantId, clientId, clientSecret, from, to };
}

export function isMailConfigured(): boolean {
  return getMailConfig() !== null;
}

// ---------------------------------------------------------------------------
// Token cache — one token per process, refreshed ~60 s before expiry.
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAtMs: number } | null = null;

/** Test-only: clears the cached token and the once-only config log flag. */
export function resetMailStateForTests(): void {
  cachedToken = null;
  missingConfigLogged = false;
  mailRowsAwaitingDailyConfirmation.clear();
}

async function getAccessToken(config: MailConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS) {
    return cachedToken.token;
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Microsoft Graph tokenaanvraag mislukt (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error("Microsoft Graph tokenaanvraag gaf geen access_token terug");
  }
  const expiresInMs = (data.expires_in ?? 3600) * 1000;
  cachedToken = { token: data.access_token, expiresAtMs: now + expiresInMs };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Sends one mail via Graph sendMail on behalf of MAIL_FROM to all MAIL_TO
 * addresses. Throws on any failure (caller decides queueing/logging).
 * Throws when the configuration is missing.
 */
export async function sendMailDirect(
  subject: string,
  body: string,
): Promise<void> {
  const config = getMailConfig();
  if (!config) {
    throw new Error(
      "E-mail is niet geconfigureerd: controleer GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, MAIL_FROM en MAIL_TO.",
    );
  }

  const token = await getAccessToken(config);
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.from)}/sendMail`;
  const payload = {
    message: {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: config.to.map((address) => ({
        emailAddress: { address },
      })),
    },
    saveToSentItems: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  // Graph returns 202 Accepted on success.
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // A 401 can mean the cached token was revoked early; drop the cache so
    // the next attempt fetches a fresh one.
    if (res.status === 401) cachedToken = null;
    throw new Error(
      `Microsoft Graph sendMail mislukt (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }
}

/**
 * Outcome of a fanout send:
 *   "sent"   — delivered to Graph right away
 *   "queued" — send failed, but the mail is safely stored in the outbox and
 *              will be retried every monitor cycle (ownership of the retry
 *              moves to the outbox — the caller must NOT resend it)
 *   "off"    — mail channel not configured
 *   "failed" — send failed AND queueing failed: nothing is persisted, the
 *              caller may retry the whole notification
 */
export type MailSendResult = "sent" | "queued" | "off" | "failed";

/**
 * Fanout entry point used by the notification module. Never throws.
 * A failed send is stored in the outbox (deduplicated on subject+body) so
 * the monitor retries it — never silently dropped. Because the outbox owns
 * that retry, "queued" counts as handled for the caller's delivered-state:
 * resending the same notification would produce duplicate mails.
 */
export async function sendMailSafe(
  subject: string,
  body: string,
): Promise<MailSendResult> {
  if (!getMailConfig()) return "off";
  try {
    await sendMailDirect(subject, body);
    logger.info({ subject }, "E-mailmelding verstuurd");
    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, subject }, "E-mail versturen mislukt — in wachtrij gezet");
    const queued = await enqueueMail(subject, body, message);
    return queued ? "queued" : "failed";
  }
}

/**
 * Stores a failed mail in the outbox unless an identical one is already
 * pending. Returns true when the mail is (now) safely persisted.
 */
async function enqueueMail(
  subject: string,
  body: string,
  errorMessage: string,
): Promise<boolean> {
  try {
    const existing = await db
      .select({ id: mailOutbox.id })
      .from(mailOutbox)
      .where(sql`${mailOutbox.subject} = ${subject} AND ${mailOutbox.body} = ${body}`)
      .limit(1);
    if (existing[0]) {
      // Same mail already queued — refresh the error, don't duplicate.
      await db
        .update(mailOutbox)
        .set({ lastError: errorMessage, lastAttemptAt: new Date() })
        .where(eq(mailOutbox.id, existing[0].id));
      return true;
    }
    await db.insert(mailOutbox).values({
      subject,
      body,
      lastError: errorMessage,
      attempts: 1,
    });
    return true;
  } catch (dbErr) {
    // Queueing itself failed: last resort is the loud log line above plus
    // this one — the caller gets "failed" so notify-state is not advanced.
    logger.error({ err: dbErr, subject }, "E-mailwachtrij: wegschrijven mislukt");
    return false;
  }
}

/**
 * Retries every queued mail. Called once per monitor cycle.
 * Successful sends are removed; failures bump the attempt counter. After
 * MAX_OUTBOX_ATTEMPTS the entry is loudly written to the action log and
 * removed — visible in the logboek, never silently dropped.
 */
export async function retryMailOutbox(): Promise<void> {
  if (!getMailConfig()) return;

  let rows;
  try {
    rows = await db.select().from(mailOutbox).orderBy(mailOutbox.id);
  } catch (err) {
    logger.error({ err }, "E-mailwachtrij: ophalen mislukt");
    return;
  }
  if (rows.length === 0) return;

  for (const row of rows) {
    try {
      const acceptedDailyReportDay = DAILY_REPORT_ACCEPTED.exec(row.lastError)?.[1];
      const dailyReportDay = acceptedDailyReportDay
        ?? DAILY_REPORT_SUBJECT.exec(row.subject)?.[1];
      const graphAlreadyAccepted = Boolean(
        acceptedDailyReportDay || mailRowsAwaitingDailyConfirmation.has(row.id),
      );
      if (!graphAlreadyAccepted) {
        await sendMailDirect(row.subject, row.body);
      }
      if (dailyReportDay) {
        if (!graphAlreadyAccepted) {
          mailRowsAwaitingDailyConfirmation.add(row.id);
          await db
            .update(mailOutbox)
            .set({
              lastError: `daily-report-accepted:${dailyReportDay}`,
              lastAttemptAt: new Date(),
            })
            .where(eq(mailOutbox.id, row.id))
            .catch((err) => {
              logger.error(
                { err, day: dailyReportDay },
                "Bezorgd dagbericht kon niet als bevestiging in de wachtrij worden gemarkeerd",
              );
            });
        }
        try {
          await pool.query(
            `INSERT INTO monitor_state (key, value, updated_at) VALUES ('daily-report', $1, now())
             ON CONFLICT (key) DO UPDATE SET
               value = GREATEST(monitor_state.value, EXCLUDED.value),
               updated_at = now()`,
            [dailyReportDay],
          );
        } catch (err) {
          logger.error(
            { err, day: dailyReportDay },
            "Bezorgd dagbericht kon niet als bevestigd worden vastgelegd",
          );
          // Keep the row. Its accepted marker makes the next poll retry only
          // this state write, never the already-successful Graph send.
          continue;
        }
      }
      await db.delete(mailOutbox).where(eq(mailOutbox.id, row.id));
      mailRowsAwaitingDailyConfirmation.delete(row.id);
      logger.info(
        { subject: row.subject, attempts: row.attempts + 1 },
        "E-mail uit wachtrij alsnog bezorgd",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      if (attempts >= MAX_OUTBOX_ATTEMPTS) {
        await logAction({
          kind: "mail_mislukt",
          action: "E-mailmelding definitief niet bezorgd",
          reason: `Versturen is ${attempts} keer mislukt. Laatste fout: ${message.slice(0, 300)}`,
          outcome: `Onderwerp: "${row.subject}" — controleer de Graph-configuratie (GRAPH_* secrets en MAIL_FROM/MAIL_TO)`,
        });
        logger.error(
          { subject: row.subject, attempts, err },
          "E-mail definitief niet bezorgd — vastgelegd in het logboek",
        );
        await db
          .delete(mailOutbox)
          .where(eq(mailOutbox.id, row.id))
          .catch(() => {});
      } else {
        await db
          .update(mailOutbox)
          .set({ attempts, lastError: message, lastAttemptAt: new Date() })
          .where(eq(mailOutbox.id, row.id))
          .catch(() => {});
        logger.warn(
          { subject: row.subject, attempts },
          "E-mail uit wachtrij opnieuw geprobeerd — nog niet gelukt",
        );
      }
    }
  }
}
