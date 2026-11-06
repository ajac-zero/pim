// Pim's service worker: shows the notifications Pim pushes while the app is
// closed, and opens the right page when one is tapped. It also keeps the app
// on this device, so it opens without waiting on the network.

/** The app kept on this device: its page, the files the page starts with, and those loaded since. */
const APP_CACHE = "pim-app-v1";
/** Every page of the app is the same page; it's kept as this one. */
const APP_PAGE = "/";
/** What the Worker answers itself (`run_worker_first` in wrangler.jsonc and wrangler.preview.jsonc): never the app's page. */
const WORKER_FIRST = ["/api", "/api/*", "/install.sh", "/auth/*", "/health", "/mcp", "/oauth/*", "/.well-known/*", "/authorize", "/mcp/callback/*", "/mcp/client/*", "/mcp/events/*", "/images/*", "/shared/*", "/app-pages/*", "/__dev/*", "/p/*"];

const workerFirst = (path) =>
  WORKER_FIRST.some((rule) => (rule.endsWith("/*") ? path.startsWith(rule.slice(0, -1)) : path === rule));

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // Kept now, the app opens from here on the next visit.
  event.waitUntil(caches.open(APP_CACHE).then((cache) => updateApp(cache, null)).catch(() => {}));
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith("pim-app-") && name !== APP_CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // A page of the app; a file such as an icon, or what the Worker answers, comes from the network.
  if (request.mode === "navigate" && !workerFirst(url.pathname) && !url.pathname.split("/").pop().includes(".")) {
    event.respondWith(openApp(event));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(appFile(event));
  } else if (url.pathname === "/api/themes.css") {
    // The page waits on the colors before it draws: the kept ones, refreshed for the next visit.
    event.respondWith(keptThenRefreshed(event));
  }
});

/** The kept page at once, while a newer one is looked for; the network's, the first time. */
async function openApp(event) {
  const cache = await caches.open(APP_CACHE);
  const kept = await cache.match(APP_PAGE);
  if (kept) {
    event.waitUntil(kept.clone().text().then((page) => updateApp(cache, page)).catch(() => {}));
    return kept;
  }
  const response = await fetch(event.request);
  event.waitUntil(updateApp(cache, null, response.clone()).catch(() => {}));
  return response;
}

/**
 * Keeps the network's page in place of `kept` when it differs, but only once
 * every file it starts with is kept too, so the two never disagree. Files of
 * the older app are dropped; the open pages hear that a newer one is here.
 */
async function updateApp(cache, kept, response) {
  response ??= await fetch(APP_PAGE, { cache: "no-cache" });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return;
  const page = await response.text();
  if (page === kept) return;
  const files = [...new Set([...page.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]))];
  // Only a built app is kept: the development server's page loads its code from elsewhere.
  if (!files.some((file) => file.endsWith(".js"))) return;
  await cache.addAll(files);
  await cache.put(APP_PAGE, new Response(page, { headers: response.headers }));
  for (const request of await cache.keys()) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/assets/") && !files.includes(pathname)) await cache.delete(request);
  }
  if (kept === null) return;
  for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "pim-updated" });
}

/** A built file never changes under its name: the kept one, or the network's, kept. */
async function appFile(event) {
  const cache = await caches.open(APP_CACHE);
  const kept = await cache.match(event.request);
  if (kept) return kept;
  const response = await fetch(event.request);
  if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
  return response;
}

async function keptThenRefreshed(event) {
  const cache = await caches.open(APP_CACHE);
  const kept = await cache.match(event.request);
  const fresh = fetch(event.request).then(async (response) => {
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  });
  if (!kept) return fresh;
  event.waitUntil(fresh.catch(() => {}));
  return kept;
}

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

/** The small monochrome mark some devices show in their status bar, in place of a generic bell. */
const BADGE = "/badge-96.png";
const chatTag = (session) => `pim-chat-${session}`;

/**
 * Shows a chat's reply. Replies from one chat share an alert that says how
 * many messages are new, so a burst stays one alert; each message delivered
 * twice counts once.
 */
async function showReply(message) {
  const existing = (await self.registration.getNotifications()).find((alert) => alert.tag === chatTag(message.session));
  const ids = existing?.data?.ids ?? [];
  if (ids.includes(message.id)) return;
  const count = (existing?.data?.count ?? 0) + 1;
  await self.registration.showNotification(message.title, {
    body: count === 1 ? message.body : `${count} new messages: ${message.body}`,
    badge: BADGE,
    icon: await notificationIcon(message.agent),
    tag: chatTag(message.session),
    renotify: true,
    data: { url: `/chat/${message.session}`, count, ids: [...ids, message.id].slice(-50) },
  });
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
      if (message.kind === "reply" && message.session) return showReply(message);
      // Anything else, such as a mention, an approval or a limit notice, stands alone and opens its chat.
      await self.registration.showNotification(message.title, {
        body: message.body,
        badge: BADGE,
        icon: await notificationIcon(message.agent),
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
