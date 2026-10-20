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
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      // A reply shows unless its chat is on screen. Anything else the app
      // shows as its own toast while it is on screen.
      const chat = `/chat/${message.session}`;
      const shown = message.reply
        ? visible.some((client) => new URL(client.url).pathname === chat)
        : visible.length > 0;
      if (shown) return;
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
