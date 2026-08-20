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
import { sendPushToAll, type PushMessage } from "./push.js";
import { sendMailSafe } from "./mail.js";
import { logger } from "./logger.js";

/**
 * Push fanout that never breaks the Slack path: any error is logged and
 * counted as "not delivered". Both channels follow exactly the same policy
 * because the monitor decides WHEN to notify; this module only decides HOW.
 */
async function pushSafe(message: PushMessage): Promise<boolean> {
  try {
    return await sendPushToAll(message);
  } catch (err) {
    logger.error({ err }, "Push: versturen mislukt");
    return false;
  }
}

/**
 * Mail fanout that can never block Slack or push: sendMailSafe already
 * queues failures in the outbox and never throws, but we guard anyway so a
 * programming error in the mail path cannot suppress the other channels.
 *
 * Returns true when the mail channel HANDLED the notification: either it was
 * sent right away ("sent") or it is safely persisted in the outbox
 * ("queued"), which the monitor retries every cycle until delivery or the
 * loud upper bound. Counting "queued" as handled is essential: the outbox
 * owns the retry, so the caller advancing its notified-state prevents the
 * same alert from being resent (and re-queued) on every poll — no duplicate
 * mails. "off" (not configured) and "failed" (not even queueable) return
 * false so the other channels / the next poll decide.
 */
async function mailSafe(subject: string, body: string): Promise<boolean> {
  try {
    const result = await sendMailSafe(subject, body);
    return result === "sent" || result === "queued";
  } catch (err) {
    logger.error({ err }, "E-mail: versturen mislukt");
    return false;
  }
}

/** Generic policy-driven fanout. Monitor code decides timing, this only delivers. */
export async function notifyFinding(
  title: string,
  detail: string,
  level: "NU" | "KAN_WACHTEN",
): Promise<boolean> {
  if (!isEnabled()) return false;
  const prefix = level === "NU" ? "🔴" : "📋";
  const webhookUrl = resolveWebhookUrl();
  const slackDelivered = webhookUrl
    ? await post(webhookUrl, { text: `${prefix} ${title}\n${detail}` })
    : false;
  const pushDelivered = await pushSafe({ title: `${prefix} ${title}`, body: detail, url: "/", tag: `finding-${title}` });
  const mailDelivered = await mailSafe(`${prefix} ${title}`, detail);
  return slackDelivered || pushDelivered || mailDelivered;
}

export async function notifyDailyFindings(
  findings: Array<{ title: string; detail: string }>,
  actions: Array<{ action: string; repo: string | null; outcome: string }> = [],
): Promise<boolean> {
  const findingBody = findings.length > 0
    ? findings.map((finding) => `• ${finding.title}\n  ${finding.detail}`).join("\n\n")
    : "Geen open aandachtspunten.";
  const actionBody = actions.length > 0
    ? `\n\nWat het systeem op mijn servers heeft gedaan:\n${actions
        .map((action) => `• ${action.action}${action.repo ? ` (${action.repo})` : ""}: ${action.outcome}`)
        .join("\n")}`
    : "";
  const body = `${findingBody}${actionBody}`;
  return notifyFinding("Dagbericht: open aandachtspunten", body, "KAN_WACHTEN");
}

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
 * Notify Slack with a single summary message when multiple repositories
 * transition to red in the same poll cycle.
 * Returns true when the message was delivered; false on any failure.
 */
export async function notifyMultipleReposRed(
  summaries: RepoSummary[],
): Promise<boolean> {
  if (!isEnabled()) return false;
  const webhookUrl = resolveWebhookUrl();

  const count = summaries.length;
  const repoLines = summaries
    .map((s) => {
      const url = s.htmlUrl ?? `https://github.com/${s.name}`;
      const reason = s.failReason ?? "Controle faalt";
      return `• *<${url}|${s.name}>* — ${reason}`;
    })
    .join("\n");

  const payload = {
    text: `🔴 ${count} codebases zijn tegelijk rood geworden`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔴 *${count} codebases zijn tegelijk rood geworden*`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: repoLines },
      },
    ],
  };

  const mailBody = summaries
    .map((s) => `${s.name}: ${s.failReason ?? "Controle faalt"}`)
    .join("\n");
  const slackDelivered = webhookUrl ? await post(webhookUrl, payload) : false;
  const pushDelivered = await pushSafe({
    title: `🔴 ${count} codebases zijn rood geworden`,
    body: mailBody,
    url: "/",
    tag: "bundel-rood",
  });
  const mailDelivered = await mailSafe(
    `🔴 ${count} codebases zijn tegelijk rood geworden`,
    mailBody,
  );
  const delivered = slackDelivered || pushDelivered || mailDelivered;
  if (delivered) {
    logger.info(
      { repos: summaries.map((s) => s.name), slackDelivered, pushDelivered, mailDelivered },
      "Gebundelde rode-status melding verstuurd",
    );
  }
  return delivered;
}

/**
 * Notify Slack that a repository transitioned from a passing state to red.
 * Returns true when the message was delivered; false on any failure.
 */
export async function notifyRepoRed(summary: RepoSummary): Promise<boolean> {
  if (!isEnabled()) return false;
  const webhookUrl = resolveWebhookUrl();

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

  const slackDelivered = webhookUrl ? await post(webhookUrl, payload) : false;
  const pushDelivered = await pushSafe({
    title: `🔴 ${summary.name} is rood geworden`,
    body: reason,
    url: `/repo/${encodeURIComponent(summary.name)}`,
    tag: `repo-${summary.name}`,
  });
  const mailDelivered = await mailSafe(
    `🔴 ${summary.name} is rood geworden`,
    `${summary.name} is rood geworden.\n\nReden: ${reason}${
      summary.lastCommitTitle ? `\nLaatste commit: ${summary.lastCommitTitle}` : ""
    }\n\nBekijk: ${repoUrl}`,
  );
  const delivered = slackDelivered || pushDelivered || mailDelivered;
  if (delivered)
    logger.info(
      { repo: summary.name, slackDelivered, pushDelivered, mailDelivered },
      "Rode-status melding verstuurd",
    );
  return delivered;
}

// ---------------------------------------------------------------------------
// Reminder helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minuten`;
  const hours = Math.round(minutes / 60);
  return `${hours} uur`;
}

/**
 * Reminder: notify Slack that a single repository has been red for an extended
 * period without recovering.
 * Returns true when the message was delivered; false on any failure.
 */
export async function notifyRepoRedReminder(
  summary: RepoSummary,
  redSinceMs: number,
): Promise<boolean> {
  if (!isEnabled()) return false;
  const webhookUrl = resolveWebhookUrl();

  const repoUrl = summary.htmlUrl ?? `https://github.com/${summary.name}`;
  const reason = summary.failReason ?? "Controle faalt";
  const duration = formatDuration(redSinceMs);

  const payload = {
    text: `🔴 *${summary.name}* is al ${duration} rood`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔴 *<${repoUrl}|${summary.name}>* — nog steeds rood na ${duration}`,
        },
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

  const slackDelivered = webhookUrl ? await post(webhookUrl, payload) : false;
  const pushDelivered = await pushSafe({
    title: `🔴 ${summary.name} is al ${duration} rood`,
    body: reason,
    url: `/repo/${encodeURIComponent(summary.name)}`,
    tag: `repo-${summary.name}`,
  });
  const mailDelivered = await mailSafe(
    `🔴 ${summary.name} is al ${duration} rood`,
    `${summary.name} is nog steeds rood na ${duration}.\n\nReden: ${reason}${
      summary.lastCommitTitle ? `\nLaatste commit: ${summary.lastCommitTitle}` : ""
    }\n\nBekijk: ${repoUrl}`,
  );
  const delivered = slackDelivered || pushDelivered || mailDelivered;
  if (delivered) {
    logger.info(
      { repo: summary.name, durationMs: redSinceMs, slackDelivered, pushDelivered, mailDelivered },
      "Herinnering rode-status verstuurd",
    );
  }
  return delivered;
}

/**
 * Bundled reminder: notify Slack that multiple repositories have been red for
 * an extended period. Each entry carries how long that repo has been red.
 * Returns true when the message was delivered; false on any failure.
 */
export async function notifyMultipleReposRedReminder(
  entries: Array<{ summary: RepoSummary; redSinceMs: number }>,
): Promise<boolean> {
  if (!isEnabled()) return false;
  const webhookUrl = resolveWebhookUrl();

  const count = entries.length;
  const repoLines = entries
    .map(({ summary: s, redSinceMs }) => {
      const url = s.htmlUrl ?? `https://github.com/${s.name}`;
      const reason = s.failReason ?? "Controle faalt";
      const duration = formatDuration(redSinceMs);
      return `• *<${url}|${s.name}>* — ${reason} _(al ${duration})_`;
    })
    .join("\n");

  const payload = {
    text: `🔴 ${count} codebases zijn al langere tijd rood`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔴 *${count} codebases zijn al langere tijd rood*`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: repoLines },
      },
    ],
  };

  const mailBody = entries
    .map(
      ({ summary: s, redSinceMs }) =>
        `${s.name}: ${s.failReason ?? "Controle faalt"} (al ${formatDuration(redSinceMs)})`,
    )
    .join("\n");
  const slackDelivered = webhookUrl ? await post(webhookUrl, payload) : false;
  const pushDelivered = await pushSafe({
    title: `🔴 ${count} codebases zijn al langere tijd rood`,
    body: mailBody,
    url: "/",
    tag: "bundel-herinnering",
  });
  const mailDelivered = await mailSafe(
    `🔴 ${count} codebases zijn al langere tijd rood`,
    mailBody,
  );
  const delivered = slackDelivered || pushDelivered || mailDelivered;
  if (delivered) {
    logger.info(
      { repos: entries.map((e) => e.summary.name), slackDelivered, pushDelivered, mailDelivered },
      "Gebundelde herinnering rode-status verstuurd",
    );
  }
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

  const slackDelivered = webhookUrl ? await post(webhookUrl, payload) : false;
  const pushDelivered = await pushSafe({
    title: `⚠️ Afwijking in ${repoName}`,
    body: `Ongewoon grote wijziging: ${anomaly.fileName} (${anomaly.linesChanged} regels) — ${anomaly.commitTitle}`,
    url: `/repo/${encodeURIComponent(repoName)}`,
    tag: `afwijking-${repoName}`,
  });
  const mailDelivered = await mailSafe(
    `⚠️ Afwijking gedetecteerd in ${repoName}`,
    `Ongewoon grote wijziging in ${repoName}.\n\nBestand: ${anomaly.fileName}\nRegels gewijzigd: ${anomaly.linesChanged}\nCommit: ${anomaly.commitTitle}\n\nBekijk commit: ${anomaly.commitUrl}`,
  );
  const delivered = slackDelivered || pushDelivered || mailDelivered;
  if (delivered)
    logger.info(
      { repo: repoName, sha: anomaly.commitSha, slackDelivered, pushDelivered, mailDelivered },
      "Afwijkingsmelding verstuurd",
    );
  return delivered;
}
