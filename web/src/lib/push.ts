import { pim } from "~/lib/pim-api";

/** Whether this browser can get pushes. On iPhones that takes the app being added to the Home Screen. */
export const pushSupported = () =>
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

export function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

const subscription = async () =>
  (await navigator.serviceWorker.ready).pushManager.getSubscription();

export const pushEnabled = async () =>
  Notification.permission === "granted" && (await subscription()) !== null;

/** Asks for permission, subscribes this browser, and tells Pim. */
export async function enablePush() {
  if ((await Notification.requestPermission()) !== "granted") {
    throw new Error("notifications-blocked");
  }
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const current =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(await pim.pushKey()),
    }));
  const { endpoint, keys } = current.toJSON();
  await pim.subscribePush({
    endpoint: endpoint as string,
    p256dh: keys?.p256dh as string,
    auth: keys?.auth as string,
  });
}

export async function disablePush() {
  const current = await subscription();
  if (!current) return;
  await pim.unsubscribePush(current.endpoint);
  await current.unsubscribe();
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
