import { Router, type IRouter } from "express";

const router: IRouter = Router();

/**
 * GET /api/notifications/settings
 *
 * Read-only endpoint — returns whether notifications are configured and active.
 * No write endpoint exists: the webhook URL (SLACK_WEBHOOK_URL) and the
 * enabled flag (NOTIFICATIONS_ENABLED) are configured via Replit Secrets /
 * environment variables, not through the API.  This eliminates SSRF risk
 * and ensures that only operators with environment access can change settings.
 */
router.get("/notifications/settings", (_req, res): void => {
  res.json({
    enabled: process.env["NOTIFICATIONS_ENABLED"] !== "false",
    slackWebhookConfigured: Boolean(process.env["SLACK_WEBHOOK_URL"]),
  });
});

export default router;
