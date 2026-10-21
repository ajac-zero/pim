import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enablePush, pushEnabled } from "~/lib/push";

describe("push registration", () => {
  const key = new Uint8Array([4, 11, 27, 42]);
  const payload = {
    endpoint: "https://push.example/phone",
    keys: { p256dh: "browser-key", auth: "browser-secret" },
  };
  let current: {
    endpoint: string;
    options: { applicationServerKey: ArrayBuffer };
    toJSON: () => typeof payload;
    unsubscribe: () => Promise<boolean>;
  } | null;
  let registered: unknown;
  let permission: NotificationPermission;
  let unavailable: boolean;

  beforeEach(() => {
    registered = null;
    permission = "granted";
    unavailable = false;
    current = {
      endpoint: payload.endpoint,
      options: { applicationServerKey: key.slice().buffer },
      toJSON: () => payload,
      unsubscribe: async () => {
        current = null;
        return true;
      },
    };
    const phone = current;
    vi.stubGlobal("Notification", {
      get permission() {
        return permission;
      },
      requestPermission: () => {
        throw new Error("An existing subscription must not prompt again");
      },
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => current,
            subscribe: async (options: PushSubscriptionOptionsInit) => {
              current = {
                ...phone,
                options: {
                  applicationServerKey: new Uint8Array(
                    options.applicationServerKey as Uint8Array<ArrayBuffer>,
                  ).buffer,
                },
              };
              return current;
            },
          },
        }),
      },
    });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (unavailable)
        return Response.json(
          { error: "Push registration unavailable" },
          { status: 503 },
        );
      if (url === "/api/push/key")
        return Response.json({ publicKey: btoa(String.fromCharCode(...key)) });
      if (url === "/api/push/subscription" && init?.method === "PUT") {
        registered = JSON.parse(init.body as string);
        return Response.json({ subscribed: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("restores the phone's missing server registration before reporting enabled", async () => {
    expect(await pushEnabled()).toBe(true);
    expect(registered).toEqual({ endpoint: payload.endpoint, ...payload.keys });
  });

  it("replaces an old account's key without asking for permission again", async () => {
    if (!current) throw new Error("Missing phone subscription");
    current.options.applicationServerKey = new Uint8Array([
      4, 11, 27, 99,
    ]).buffer;
    expect(await pushEnabled()).toBe(true);
    expect(
      new Uint8Array(current?.options.applicationServerKey as ArrayBuffer),
    ).toEqual(key);
    expect(registered).toEqual({ endpoint: payload.endpoint, ...payload.keys });
  });

  it("does not report enabled when Pim refuses the registration", async () => {
    unavailable = true;
    await expect(pushEnabled()).rejects.toThrow(
      "Push registration unavailable",
    );
    expect(registered).toBeNull();
  });

  it("automatically subscribes a permitted browser even without an existing subscription", async () => {
    current = null;
    expect(await pushEnabled()).toBe(true);
    expect(current).not.toBeNull();
    expect(registered).toEqual({ endpoint: payload.endpoint, ...payload.keys });
  });

  it("registers after the person grants permission through the allow action", async () => {
    current = null;
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: async () => "granted",
    });
    await enablePush();
    expect(registered).toEqual({ endpoint: payload.endpoint, ...payload.keys });
  });

  it.each(["default", "denied"] as const)(
    "does not prompt or register when permission is %s",
    async (value) => {
      permission = value;
      expect(await pushEnabled()).toBe(false);
      expect(registered).toBeNull();
    },
  );

  it.each(["default", "denied"] as const)(
    "does not subscribe when the person leaves permission %s in the prompt",
    async (value) => {
      current = null;
      vi.stubGlobal("Notification", {
        permission: "default",
        requestPermission: async () => value,
      });
      await expect(enablePush()).rejects.toThrow("notifications-blocked");
      expect(current).toBeNull();
      expect(registered).toBeNull();
    },
  );
});
