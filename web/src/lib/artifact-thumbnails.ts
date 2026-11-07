import { type ArtifactFrom, artifactFrameUrl } from "~/lib/pim-api";

/**
 * Freeze frames of apps for their cards, kept as a browser keeps the
 * previews of pages: drawing one means running the app, so it's done once
 * per version, which never changes, and the picture is kept on this device
 * (Cache Storage) for every time after. A frame draws each in turn, behind
 * the page and invisible, with no bridge: the app can't reach Pim or its
 * model while it's drawn. It's a drawing of the page, not the page, so a
 * card shows the app itself once it's hovered.
 */

const CACHE = "artifact-thumbnails";
/** The most pictures kept; the oldest go first. */
const MAX_KEPT = 200;
/** How long an app has to send its picture before it's given up on. */
const TIMEOUT_MS = 10_000;
/** The size of the window an app is laid out in; the thumbnail script crops to it (web/src/artifact-runtime/thumbnail.ts). */
const WINDOW = { width: 1024, height: 640 };

/** Versions that couldn't be drawn, not tried again until the page loads again. */
const failed = new Set<string>();
/** The picture being drawn for each version, so two cards for it share one frame. */
const drawing = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

const keyOf = (id: string, version: number, from?: ArtifactFrom) =>
  `/artifact-thumbnails/${from ? ("host" in from ? `host/${encodeURIComponent(from.host)}` : "published") : "own"}/${encodeURIComponent(id)}/${version}`;

async function cache() {
  return typeof caches === "undefined" ? null : caches.open(CACHE);
}

/** The kept picture of a version, as an address for an image, if there is one. */
async function kept(
  id: string,
  version: number,
  from?: ArtifactFrom,
): Promise<string | null> {
  const found = await (await cache())?.match(keyOf(id, version, from));
  return found ? URL.createObjectURL(await found.blob()) : null;
}

async function keep(
  id: string,
  version: number,
  from: ArtifactFrom | undefined,
  image: string,
) {
  const store = await cache();
  if (!store) return;
  const key = keyOf(id, version, from);
  // An app's older versions' pictures are of no use again, unless one is restored, which makes a new version.
  const prefix = key.slice(0, key.lastIndexOf("/") + 1);
  const pathOf = (request: Request) => new URL(request.url).pathname;
  const all = await store.keys();
  for (const request of all.filter((r) => pathOf(r).startsWith(prefix)))
    await store.delete(request);
  const others = all.filter((r) => !pathOf(r).startsWith(prefix));
  for (const request of others.slice(
    0,
    Math.max(0, others.length - MAX_KEPT + 1),
  ))
    await store.delete(request);
  await store.put(key, await fetch(image));
}

/**
 * Runs the version in a frame until it sends its picture. The frame is
 * invisible but in view, because a browser doesn't draw a frame that's
 * off-screen, and the picture needs it drawn.
 */
function draw(
  id: string,
  version: number,
  from?: ArtifactFrom,
): Promise<string | null> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.referrerPolicy = "no-referrer";
    frame.ariaHidden = "true";
    frame.tabIndex = -1;
    frame.src = `${artifactFrameUrl(id, version, from)}?thumbnail`;
    Object.assign(frame.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "-1",
      opacity: "0",
      width: `${WINDOW.width}px`,
      height: `${WINDOW.height}px`,
      border: "0",
      pointerEvents: "none",
    });
    const done = (image: string | null) => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      frame.remove();
      resolve(image);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if (event.data?.type !== "pim:artifact-thumbnail") return;
      done(typeof event.data.image === "string" ? event.data.image : null);
    };
    const timer = setTimeout(() => done(null), TIMEOUT_MS);
    addEventListener("message", onMessage);
    document.body.append(frame);
  });
}

/**
 * The picture of a version for its card: the kept one, or one drawn now,
 * after those asked for before it, and kept. Null when the app can't be
 * drawn, which isn't tried again.
 */
export async function thumbnail(
  id: string,
  version: number,
  from?: ArtifactFrom,
): Promise<string | null> {
  const found = await kept(id, version, from);
  if (found) return found;
  const key = keyOf(id, version, from);
  if (failed.has(key)) return null;
  let pending = drawing.get(key);
  if (!pending) {
    pending = queue.then(async () => {
      const image = await draw(id, version, from);
      if (!image) {
        failed.add(key);
        return null;
      }
      await keep(id, version, from, image).catch(() => {});
      return image;
    });
    queue = pending;
    drawing.set(key, pending);
    void pending.finally(() => drawing.delete(key));
  }
  return pending;
}
