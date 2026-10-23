// Pim's service worker: shows the notifications Pim pushes while the app is
// closed, and opens the right page when one is tapped.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Device alerts use the agent's image, or an SVG of its symbol in the default palette. */
async function notificationIcon(agent) {
  if (!agent) return "/icon-192.png";
  if (agent.icon !== null) {
    return `/api/agents/${encodeURIComponent(agent.id)}/icon?v=${agent.icon}`;
  }
  try {
    const response = await fetch("/notification-symbols.json");
    if (!response.ok) return "/icon-192.png";
    const { symbols, colors } = await response.json();
    const color = colors[agent.color] ?? colors.primary;
    const glyph = agent.symbol && !/^[a-z][a-z0-9-]*$/.test(agent.symbol)
      ? `<text x="96" y="104" font-size="112" text-anchor="middle" dominant-baseline="central">${agent.symbol.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</text>`
      : Object.hasOwn(symbols, agent.symbol) ? symbols[agent.symbol] : symbols.bot;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192" color="${color}"><rect width="192" height="192" fill="white"/><rect width="192" height="192" fill="${color}" fill-opacity="0.15"/>${glyph}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {
    // A failed icon request must not hide the alert.
    return "/icon-192.png";
  }
}

const SUMMARY_TAG = "pim-summary";
const chatTag = (session) => `pim-chat-${session}`;

/**
 * Shows a chat's alert, folding into what is already on screen so a burst
 * stays a few alerts: one chat shows its name and how many messages are new;
 * a second chat replaces the chat alerts with one "N new messages in M chats".
 * Each alert remembers its chats' counts and the message ids it counted, so a
 * message delivered twice counts once.
 */
async function showGrouped(message) {
  const existing = (await self.registration.getNotifications()).filter((n) => n.tag === SUMMARY_TAG || n.tag.startsWith("pim-chat-"));
  const chats = {};
  const ids = [];
  for (const { data } of existing) {
    for (const [session, count] of Object.entries(data?.chats ?? {})) chats[session] = count;
    ids.push(...(data?.ids ?? []));
  }
  if (ids.includes(message.id)) return;
  chats[message.session] = (chats[message.session] ?? 0) + 1;
  ids.push(message.id);
  const sessions = Object.keys(chats);
  const total = Object.values(chats).reduce((sum, count) => sum + count, 0);
  const options = { renotify: true, data: { chats, ids: ids.slice(-50) } };
  if (sessions.length === 1) {
    const count = chats[message.session];
    await self.registration.showNotification(message.title, {
      ...options,
      body: count === 1 ? message.body : `${count} new messages: ${message.body}`,
      icon: await notificationIcon(message.agent),
      tag: chatTag(message.session),
      data: { ...options.data, url: `/chat/${message.session}` },
    });
    return;
  }
  await self.registration.showNotification("Pim", {
    ...options,
    body: `${total} new messages in ${sessions.length} chats`,
    icon: "/icon-192.png",
    tag: SUMMARY_TAG,
    data: { ...options.data, url: "/notifications" },
  });
  for (const alert of existing) if (alert.tag !== SUMMARY_TAG) alert.close();
}

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
      // An alert about no chat, such as a limit notice, stands alone.
      if (!message.session) {
        await self.registration.showNotification(message.title, {
          body: message.body,
          icon: await notificationIcon(message.agent),
          tag: message.id,
          data: { url: "/notifications" },
        });
        return;
      }
      await showGrouped(message);
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
