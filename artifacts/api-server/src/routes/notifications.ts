import { Router, type IRouter } from "express";
import { isMailConfigured, sendMailDirect } from "../lib/mail.js";
import { logger } from "../lib/logger.js";
import {
  ListFindingsResponse,
  ListFindingLevelsResponse,
  UpdateFindingLevelBody,
  UpdateFindingLevelParams,
  UpdateFindingLevelResponse,
} from "@workspace/api-zod";
import {
  listFindings,
  listFindingLevels,
  updateFindingLevel,
} from "../lib/findings.js";

const router: IRouter = Router();

/**
 * GET /api/notifications/settings
 *
 * Read-only endpoint — returns whether notifications are configured and active.
 * No write endpoint exists: the webhook URL (SLACK_WEBHOOK_URL), the enabled
 * flag (NOTIFICATIONS_ENABLED) and the Graph mail settings (GRAPH_ and MAIL_ variables)
 * are configured via Replit Secrets / environment variables, not through the
 * API.  This eliminates SSRF risk and ensures that only operators with
 * environment access can change settings.
 */
router.get("/notifications/settings", (_req, res): void => {
  res.json({
    enabled: process.env["NOTIFICATIONS_ENABLED"] !== "false",
    slackWebhookConfigured: Boolean(process.env["SLACK_WEBHOOK_URL"]),
    mailConfigured: isMailConfigured(),
  });
});

router.get("/notifications/findings", async (req, res): Promise<void> => {
  try {
    res.json(ListFindingsResponse.parse(await listFindings()));
  } catch (err) {
    req.log.error({ err }, "Bevindingen ophalen mislukt");
    res.status(502).json({ error: "Kon de bevindingen niet ophalen." });
  }
});

router.get("/notifications/levels", async (req, res): Promise<void> => {
  try {
    res.json(ListFindingLevelsResponse.parse(await listFindingLevels()));
  } catch (err) {
    req.log.error({ err }, "Meldingsniveaus ophalen mislukt");
    res.status(502).json({ error: "Kon de meldingsniveaus niet ophalen." });
  }
});

router.patch("/notifications/levels/:kind", async (req, res): Promise<void> => {
  const params = UpdateFindingLevelParams.safeParse(req.params);
  const body = UpdateFindingLevelBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Ongeldig meldingsniveau." });
    return;
  }
  try {
    const updated = await updateFindingLevel(params.data.kind, body.data.level);
    if (!updated) {
      res.status(404).json({ error: "Onbekende bevindingssoort." });
      return;
    }
    res.json(UpdateFindingLevelResponse.parse(updated));
  } catch (err) {
    req.log.error({ err, kind: params.data.kind }, "Meldingsniveau aanpassen mislukt");
    res.status(502).json({ error: "Kon het meldingsniveau niet aanpassen." });
  }
});

/**
 * POST /api/notifications/test-mail — send a test e-mail via Microsoft Graph
 * so the operator can verify the mail channel end-to-end. Behind requireAuth
 * (mounted after the auth middleware).
 */
router.post("/notifications/test-mail", async (_req, res): Promise<void> => {
  if (!isMailConfigured()) {
    res.status(409).json({
      error:
        "E-mail is niet geconfigureerd. Stel GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, MAIL_FROM en MAIL_TO in via Replit Secrets en herstart de server.",
    });
    return;
  }
  try {
    await sendMailDirect(
      "Proefmail — FPS-Beheercentrum",
      "Dit is een proefmail van het FPS-Beheercentrum.\n\nAls je dit leest, werkt de e-mailkoppeling via Microsoft Graph correct.",
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Proefmail versturen mislukt");
    const detail = err instanceof Error ? err.message : "";
    res.status(502).json({
      error: `Proefmail versturen mislukt. ${detail.includes("token") ? "De aanmelding bij Microsoft Graph werd geweigerd — controleer de GRAPH_*-secrets." : "Microsoft Graph weigerde het bericht — controleer of MAIL_FROM een geldig postvak is waarvoor de app mag versturen."}`,
    });
  }
});

export default router;
