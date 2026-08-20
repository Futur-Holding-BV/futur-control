import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import {
  leesOpgelostIssueKey,
  leesVeiligSentrySignaal,
} from "../lib/sentryPolicy.js";
import {
  markeerSentryIssueOpgelost,
  registreerSentrySignaal,
} from "../lib/sentryRouter.js";
import { logger } from "../lib/logger.js";

export interface SentryWebhookRequest extends Request {
  rawBody?: Buffer;
}

const router: IRouter = Router();

function isGeldigeHandtekening(req: SentryWebhookRequest): boolean {
  const geheim = process.env["SENTRY_WEBHOOK_SECRET"];
  const ontvangen = req.header("sentry-hook-signature");
  if (!geheim || !ontvangen || !req.rawBody) return false;
  const verwacht = createHmac("sha256", geheim)
    .update(req.rawBody)
    .digest("hex");
  const ontvangenBuffer = Buffer.from(ontvangen, "utf8");
  const verwachtBuffer = Buffer.from(verwacht, "utf8");
  return (
    ontvangenBuffer.length === verwachtBuffer.length &&
    timingSafeEqual(ontvangenBuffer, verwachtBuffer)
  );
}

router.post(
  "/webhooks/sentry",
  async (req: SentryWebhookRequest, res): Promise<void> => {
    if (!process.env["SENTRY_WEBHOOK_SECRET"]) {
      res.status(503).json({ error: "Sentry-webhook is niet geconfigureerd" });
      return;
    }
    if (!isGeldigeHandtekening(req)) {
      res.status(401).json({ error: "Ongeldige webhookhandtekening" });
      return;
    }

    const resource = req.header("sentry-hook-resource");
    try {
      if (resource === "event_alert") {
        const signaal = leesVeiligSentrySignaal(req.body);
        if (signaal) await registreerSentrySignaal(signaal);
      } else if (resource === "issue") {
        const issueKey = leesOpgelostIssueKey(req.body);
        if (issueKey) await markeerSentryIssueOpgelost(issueKey);
      }
      // Ook onbekende/irrelevante maar geldig getekende events worden
      // geaccepteerd. Sentry hoeft ze niet eindeloos opnieuw aan te bieden.
      res.status(202).json({ accepted: true });
    } catch (err) {
      logger.error({ err, resource }, "Sentry-webhook verwerken mislukt");
      res.status(503).json({ error: "Webhook tijdelijk niet verwerkt" });
    }
  },
);

export default router;