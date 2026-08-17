/**
 * Web-push channel for the installed PWA (Android/iOS/desktop).
 *
 * Follows the exact same notification policy as Slack: it is only invoked
 * from notifications.ts, which the monitor calls after the debounce and
 * quiet-window rules have been applied.
 *
 * VAPID keys are generated once and stored in the database (changing them
 * would invalidate every existing subscription). Subscriptions that the
 * push service reports as gone (404/410) are removed automatically.
 */

import webpush from "web-push";
import { db, pushSubscriptions, vapidKeys } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

const VAPID_ROW_ID = "default";
const VAPID_SUBJECT = "mailto:beheer@fps-beheercentrum.local";

let cachedKeys: { publicKey: string; privateKey: string } | null = null;

/** Returns the VAPID key pair, generating and persisting it on first use. */
export async function getVapidKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  if (cachedKeys) return cachedKeys;

  const rows = await db
    .select()
    .from(vapidKeys)
    .where(eq(vapidKeys.id, VAPID_ROW_ID))
    .limit(1);
  const existing = rows[0];
  if (existing) {
    cachedKeys = {
      publicKey: existing.publicKey,
      privateKey: existing.privateKey,
    };
    return cachedKeys;
  }

  const generated = webpush.generateVAPIDKeys();
  // Concurrent first calls: the conflict-do-nothing plus re-select keeps a
  // single canonical pair.
  await db
    .insert(vapidKeys)
    .values({
      id: VAPID_ROW_ID,
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    })
    .onConflictDoNothing();
  const after = await db
    .select()
    .from(vapidKeys)
    .where(eq(vapidKeys.id, VAPID_ROW_ID))
    .limit(1);
  const row = after[0]!;
  cachedKeys = { publicKey: row.publicKey, privateKey: row.privateKey };
  logger.info("VAPID-sleutelpaar voor pushmeldingen aangemaakt");
  return cachedKeys;
}

// ---------------------------------------------------------------------------
// Endpoint allowlist — prevents SSRF via attacker-registered endpoints.
// Web-push endpoints only ever point at the browser vendors' push services.
// ---------------------------------------------------------------------------

const ALLOWED_PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com", // Chrome / Android
  "push.apple.com", // Safari / iOS (web.push.apple.com)
  "push.services.mozilla.com", // Firefox
  "notify.windows.com", // Edge (WNS)
];

/** True when the endpoint is an https URL of a known browser push service. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port !== "" && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_PUSH_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function saveSubscription(
  sub: PushSubscriptionInput,
): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint));
}

export interface PushMessage {
  title: string;
  body: string;
  /** In-app path to open on tap, e.g. "/repo/fps-api". */
  url?: string;
  /** Collapse key so repeated alerts for one repo replace each other. */
  tag?: string;
}

/**
 * Sends a push message to every registered device.
 * Returns true when at least one delivery succeeded (mirrors the Slack
 * contract used by the monitor to advance notified-state), false when there
 * are no subscribers or every delivery failed.
 */
export async function sendPushToAll(message: PushMessage): Promise<boolean> {
  let subs;
  try {
    subs = await db.select().from(pushSubscriptions);
  } catch (err) {
    logger.error({ err }, "Push: abonnementen ophalen mislukt");
    return false;
  }
  if (subs.length === 0) return false;

  const { publicKey, privateKey } = await getVapidKeyPair();
  const payload = JSON.stringify(message);
  let delivered = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload,
        {
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey,
            privateKey,
          },
          TTL: 60 * 60, // stale alerts are useless after an hour
        },
      );
      delivered += 1;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Subscription is gone (app removed / permission revoked) — clean up.
        await deleteSubscription(sub.endpoint).catch(() => {});
        logger.info({ endpoint: sub.endpoint.slice(0, 60) }, "Push: verlopen abonnement opgeruimd");
      } else {
        logger.warn({ err, statusCode }, "Push: bezorging mislukt");
      }
    }
  }

  if (delivered > 0) {
    logger.info({ delivered, total: subs.length }, "Pushmelding verstuurd");
  }
  return delivered > 0;
}

/** Number of registered devices (for the settings UI). */
export async function countSubscriptions(): Promise<number> {
  const rows = await db.select().from(pushSubscriptions);
  return rows.length;
}
