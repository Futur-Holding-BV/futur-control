/**
 * Push-subscription endpoints for the installed PWA.
 * All routes sit behind requireAuth (mounted after the auth middleware).
 */

import { Router, type IRouter } from "express";
import {
  isAllowedPushEndpoint,
  getVapidKeyPair,
  saveSubscription,
  deleteSubscription,
  countSubscriptions,
  sendPushToAll,
} from "../lib/push.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/** GET /api/push/public-key — VAPID public key + device count. */
router.get("/push/public-key", async (_req, res): Promise<void> => {
  try {
    const { publicKey } = await getVapidKeyPair();
    const devices = await countSubscriptions();
    res.json({ publicKey, devices });
  } catch (err) {
    logger.error({ err }, "Push: publieke sleutel ophalen mislukt");
    res.status(500).json({ error: "Pushconfiguratie is niet beschikbaar." });
  }
});

/** POST /api/push/subscribe — register this device. */
router.post("/push/subscribe", async (req, res): Promise<void> => {
  const body = req.body as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";

  if (!p256dh || !auth || !isAllowedPushEndpoint(endpoint)) {
    // Only https endpoints of known browser push services are accepted;
    // anything else could be abused to make the server call arbitrary URLs.
    res.status(400).json({ error: "Ongeldig pushabonnement." });
    return;
  }
  if (endpoint.length > 2048 || p256dh.length > 512 || auth.length > 512) {
    res.status(400).json({ error: "Pushabonnement is te groot." });
    return;
  }

  try {
    await saveSubscription({ endpoint, keys: { p256dh, auth } });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Push: abonnement opslaan mislukt");
    res.status(500).json({ error: "Abonnement opslaan mislukt." });
  }
});

/** POST /api/push/unsubscribe — remove this device. */
router.post("/push/unsubscribe", async (req, res): Promise<void> => {
  const endpoint =
    typeof (req.body as { endpoint?: unknown }).endpoint === "string"
      ? ((req.body as { endpoint: string }).endpoint)
      : "";
  if (!endpoint) {
    res.status(400).json({ error: "Endpoint ontbreekt." });
    return;
  }
  try {
    await deleteSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Push: abonnement verwijderen mislukt");
    res.status(500).json({ error: "Abonnement verwijderen mislukt." });
  }
});

/** POST /api/push/test — send a test notification to all devices. */
router.post("/push/test", async (_req, res): Promise<void> => {
  try {
    const delivered = await sendPushToAll({
      title: "FPS-Beheercentrum",
      body: "Testmelding — pushmeldingen werken op dit apparaat.",
      url: "/",
      tag: "test",
    });
    if (delivered) {
      res.json({ ok: true });
    } else {
      res.status(409).json({
        error: "Geen enkel apparaat kon worden bereikt.",
      });
    }
  } catch (err) {
    logger.error({ err }, "Push: testmelding mislukt");
    res.status(500).json({ error: "Testmelding versturen mislukt." });
  }
});

export default router;
