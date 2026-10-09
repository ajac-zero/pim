// Pim's service worker: shows the notifications Pim pushes while the app is
// closed, and opens the right page when one is tapped.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data?.json();
  } catch {
    // Not JSON: nothing to show.
  }
  if (!message?.title) return;
  event.waitUntil(
    (async () => {
      // The app shows its own toast while it is on screen.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.some((client) => client.visibilityState === "visible")) return;
      await self.registration.showNotification(message.title, {
        body: message.body,
        icon: "/icon-192.png",
        // A notification delivered twice shows once.
        tag: message.id,
        data: { url: message.session ? `/chat/${message.session}` : "/notifications" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/notifications", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => client.url.startsWith(self.location.origin));
      if (open) {
        await open.focus();
        if ("navigate" in open) await open.navigate(url);
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
