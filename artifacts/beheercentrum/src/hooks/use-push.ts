import { useCallback, useEffect, useState } from "react";
import {
  getPushPublicKey,
  subscribePush,
  unsubscribePush,
} from "@workspace/api-client-react";

/**
 * Push-notification state for this device.
 *
 * iOS particulars: web push only works when the app is installed on the
 * home screen (iOS 16.4+) and opened from there — `standalone` display mode.
 */

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export type PushSupport =
  | "supported"
  | "needs-install" // iOS Safari in the browser: install first
  | "unsupported";

export function detectPushSupport(): PushSupport {
  const hasApis =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (hasApis) return "supported";
  if (isIos() && !isStandalone()) return "needs-install";
  return "unsupported";
}

interface UsePushResult {
  support: PushSupport;
  /** Push permission was granted and this device is registered. */
  enabled: boolean;
  busy: boolean;
  error: string | null;
  /** Permission is permanently denied in browser/OS settings. */
  denied: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

export function usePush(): UsePushResult {
  const [support] = useState<PushSupport>(() => detectPushSupport());
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(
    () => "Notification" in window && Notification.permission === "denied",
  );

  useEffect(() => {
    if (support !== "supported") return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setEnabled(Boolean(sub));
        // Reconcile: the server may have dropped this subscription (e.g.
        // after a 404/410 cleanup). Re-registering is an idempotent upsert.
        if (sub) {
          const json = sub.toJSON();
          if (json.endpoint && json.keys?.["p256dh"] && json.keys?.["auth"]) {
            await subscribePush({
              endpoint: json.endpoint,
              keys: { p256dh: json.keys["p256dh"], auth: json.keys["auth"] },
            }).catch(() => {});
          }
        }
      } catch {
        /* leave disabled */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [support]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setDenied(Notification.permission === "denied");
        setError(
          "Toestemming voor meldingen is niet gegeven. Zet meldingen aan in de browserinstellingen en probeer opnieuw.",
        );
        return;
      }
      const { publicKey } = await getPushPublicKey();
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        }));
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.["p256dh"] || !json.keys?.["auth"]) {
        throw new Error("Onvolledig pushabonnement van de browser ontvangen.");
      }
      await subscribePush({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys["p256dh"], auth: json.keys["auth"] },
      });
      setEnabled(true);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? `Aanmelden voor pushmeldingen mislukt: ${err.message}`
          : "Aanmelden voor pushmeldingen mislukt.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribePush({ endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      setEnabled(false);
    } catch {
      setError("Afmelden mislukt. Probeer het opnieuw.");
    } finally {
      setBusy(false);
    }
  }, []);

  return { support, enabled, busy, error, denied, enable, disable };
}
