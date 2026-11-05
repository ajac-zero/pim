import { pim } from "~/lib/pim-api";

/** Whether this browser can get pushes. On iPhones that takes the app being added to the Home Screen. */
export const pushSupported = () =>
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

/** How long after opening a page it still reloads into a newer app, before the person is likely busy with it. */
const FRESH_PAGE_MS = 10_000;

/**
 * Registers the service worker, which shows pushes and keeps the app on this
 * device. When it finds a newer app than the one it just opened, the page
 * reloads into it; a page open longer gets it on its next visit.
 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "pim-updated" && performance.now() < FRESH_PAGE_MS)
      location.reload();
  });
}

/** Registers this browser automatically only when permission is already granted. */
export async function pushEnabled() {
  if (Notification.permission !== "granted") return false;
  // Permission is the person's choice; there is no separate in-app opt-in.
  // Register even if this browser has never subscribed or Pim lost its record.
  await enablePush();
  return true;
}

/** Asks for permission, subscribes this browser, and tells Pim. */
export async function enablePush() {
  if (
    Notification.permission !== "granted" &&
    (await Notification.requestPermission()) !== "granted"
  ) {
    throw new Error("notifications-blocked");
  }
  const registration = await navigator.serviceWorker.ready;
  const key = base64UrlToBytes(await pim.pushKey());
  let existing = await registration.pushManager.getSubscription();
  // A subscription made with another key, such as another account's on this
  // browser, is refused by the push service for every message: replace it.
  if (existing && !sameBytes(existing.options.applicationServerKey, key)) {
    await existing.unsubscribe();
    existing = null;
  }
  const current =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  const { endpoint, keys } = current.toJSON();
  await pim.subscribePush({
    endpoint: endpoint as string,
    p256dh: keys?.p256dh as string,
    auth: keys?.auth as string,
  });
}

function sameBytes(buffer: ArrayBuffer | null, bytes: Uint8Array) {
  if (!buffer || buffer.byteLength !== bytes.length) return false;
  const view = new Uint8Array(buffer);
  return view.every((byte, index) => byte === bytes[index]);
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
