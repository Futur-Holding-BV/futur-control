/**
 * Slack notification sender.
 *
 * Configuration is read exclusively from environment variables:
 *   SLACK_WEBHOOK_URL    — Incoming Webhook URL (set via Replit Secrets)
 *   NOTIFICATIONS_ENABLED — Set to "false" to disable all notifications
 *                           (any other value, or absent, means enabled)
 *
 * The webhook URL is NEVER accepted through the API or stored in the
 * database, eliminating any SSRF risk from user-supplied URLs.
 *
 * Return value: true when the Slack POST was delivered, false otherwise.
 * Callers use the return value to decide whether to advance the "notified"
 * state in the database.  A false return means the delivery should be
 * retried on the next poll.
 *
 * GitHub access remains strictly read-only.
 */

import type { RepoSummary, Anomaly } from "./github.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Allowed webhook host — strict allowlist to prevent SSRF
// ---------------------------------------------------------------------------

const SLACK_WEBHOOK_HOST = "hooks.slack.com";

function validateSlackWebhookUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !(
        parsed.hostname === SLACK_WEBHOOK_HOST ||
        parsed.hostname.endsWith(`.${SLACK_WEBHOOK_HOST}`)
      )
    ) {
      logger.error(
        { hostname: parsed.hostname },
        "SLACK_WEBHOOK_URL is geen geldig hooks.slack.com-adres — meldingen uitgeschakeld",
      );
      return null;
    }
    return url;
  } catch {
    logger.error("SLACK_WEBHOOK_URL is geen geldige URL — meldingen uitgeschakeld");
    return null;
  }
}

// Resolved once per process so we don't re-validate on every call.
function resolveWebhookUrl(): string | null {
  const raw = process.env["SLACK_WEBHOOK_URL"];
  if (!raw) return null;
  return validateSlackWebhookUrl(raw);
}

function isEnabled(): boolean {
  return process.env["NOTIFICATIONS_ENABLED"] !== "false";
}

// Maximum time to wait for a Slack response.  A bounded timeout ensures the
// advisory lock in the monitor is always released; without it a hung
// connection would hold the lock indefinitely and suppress all future polls.
const SLACK_TIMEOUT_MS = 10_000;

async function post(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(
        { status: res.status, body },
        "Slack webhook antwoordde met een fout",
      );
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      logger.error(
        { timeoutMs: SLACK_TIMEOUT_MS },
        "Slack POST time-out — zal het volgende poll opnieuw proberen",
      );
    } else {
      logger.error({ err }, "Slack POST mislukt (netwerk- of DNS-fout)");
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Notify Slack that a repository transitioned from a passing state to red.
 * Returns true when the message was delivered; false on any failure.
 */
export async function notifyRepoRed(summary: RepoSummary): Promise<boolean> {
  if (!isEnabled()) return false;
  const webhookUrl = resolveWebhookUrl();
  if (!webhookUrl) return false;

  const repoUrl = summary.htmlUrl ?? `https://github.com/${summary.name}`;
  const reason = summary.failReason ?? "Controle faalt";

  const payload = {
    text: `🔴 *${summary.name}* is rood geworden`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `🔴 *<${repoUrl}|${summary.name}>* — controle mislukt` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Reden*\n${reason}` },
          ...(summary.lastCommitTitle
            ? [{ type: "mrkdwn", text: `*Laatste commit*\n${summary.lastCommitTitle}` }]
            : []),
        ],
      },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Bekijk repository" }, url: repoUrl },
        ],
      },
    ],
  };

  const delivered = await post(webhookUrl, payload);
  if (delivered) logger.info({ repo: summary.name }, "Rode-status melding verstuurd");
  return delivered;
}

/**
 * Notify Slack that an anomaly (large-file commit) was detected.
 * Returns true when the message was delivered; false on any failure.
 */
export async function notifyAnomaly(
  repoName: string,
  anomaly: Anomaly,
  repoUrl: string | null,
): Promise<boolean> {
  if (!isEnabled()) return false;
  const webhookUrl = resolveWebhookUrl();
  if (!webhookUrl) return false;

  const url = repoUrl ?? `https://github.com/${repoName}`;

  const payload = {
    text: `⚠️ Afwijking gedetecteerd in *${repoName}*`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `⚠️ *<${url}|${repoName}>* — ongewoon grote wijziging` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Bestand*\n\`${anomaly.fileName}\`` },
          { type: "mrkdwn", text: `*Regels gewijzigd*\n${anomaly.linesChanged}` },
          { type: "mrkdwn", text: `*Commit*\n${anomaly.commitTitle}` },
        ],
      },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Bekijk commit" }, url: anomaly.commitUrl },
        ],
      },
    ],
  };

  const delivered = await post(webhookUrl, payload);
  if (delivered) logger.info({ repo: repoName, sha: anomaly.commitSha }, "Afwijkingsmelding verstuurd");
  return delivered;
}
