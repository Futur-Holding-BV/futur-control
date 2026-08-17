/**
 * Service worker for the FPS-Beheercentrum PWA.
 *
 * Responsibilities:
 *   • Receive web-push messages and show them as system notifications.
 *   • Open (or focus) the app at the right page when a notification is
 *     tapped.
 *   • Minimal fetch passthrough — no offline caching, so the preview and
 *     deployments never serve stale assets.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Network passthrough (required for installability on some platforms).
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "FPS-Beheercentrum", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "FPS-Beheercentrum";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || "/" },
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    lang: "nl",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// The push service can rotate/expire a subscription. Re-subscribe with the
// same VAPID key and inform the server so this device keeps receiving alerts.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const oldSub = event.oldSubscription;
      const key = oldSub && oldSub.options ? oldSub.options.applicationServerKey : null;
      if (!key) return;
      try {
        const newSub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
        const json = newSub.toJSON();
        await fetch(new URL("api/push/subscribe", self.registration.scope), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
        });
        if (oldSub && oldSub.endpoint !== newSub.endpoint) {
          await fetch(new URL("api/push/unsubscribe", self.registration.scope), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ endpoint: oldSub.endpoint }),
          }).catch(() => {});
        }
      } catch {
        /* next app open re-registers via the settings page */
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetPath = (event.notification.data && event.notification.data.url) || "/";
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client && client.url !== targetUrl) {
            try {
              await client.navigate(targetUrl);
            } catch {
              /* ignore — app stays focused on its current page */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
