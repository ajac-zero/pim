import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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

describe("push alerts", () => {
  const worker = readFileSync(
    new URL("../../public/sw.js", import.meta.url),
    "utf8",
  );

  async function push(
    agent: unknown,
    fetchImage: typeof fetch,
    visible = false,
  ) {
    let receive: (event: unknown) => void = () => {};
    let finished: Promise<void> | undefined;
    let alert: { title: string; options: NotificationOptions } | undefined;
    runInNewContext(worker, {
      self: {
        addEventListener: (type: string, listener: typeof receive) => {
          if (type === "push") receive = listener;
        },
        clients: {
          matchAll: async () =>
            visible ? [{ visibilityState: "visible" }] : [],
        },
        registration: {
          getNotifications: async () => [],
          showNotification: async (
            title: string,
            options: NotificationOptions,
          ) => {
            alert = { title, options };
          },
        },
      },
      fetch: fetchImage,
      Uint8Array,
      btoa,
    });
    receive({
      data: {
        json: () => ({
          id: "notice",
          session: "trip",
          title: "Price drop",
          body: "$80 cheaper",
          agent,
        }),
      },
      waitUntil: (promise: Promise<void>) => {
        finished = promise;
      },
    });
    await finished;
    return alert;
  }

  it("shows the agent's private uploaded image and keeps the chat destination", async () => {
    const image = vi.fn<typeof fetch>();
    const alert = await push({ id: "planner", icon: 42 }, image);
    expect(alert).toEqual({
      title: "Price drop",
      options: {
        body: "$80 cheaper",
        icon: "/api/agents/planner/icon?v=42",
        tag: "pim-chat-trip",
        renotify: true,
        data: { url: "/chat/trip", chats: { trip: 1 }, ids: ["notice"] },
      },
    });
  });

  it.each(["plane", "🏃", null, "constructor"])(
    "shows the agent's symbol %s as an SVG",
    async (symbol) => {
      const image = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          symbols: {
            plane: '<svg data-symbol="plane"/>',
            bot: '<svg data-symbol="bot"/>',
          },
          colors: { teal: "#118c74", primary: "#2e6bd6" },
        }),
      );
      const alert = await push(
        { id: "planner", icon: null, symbol, color: "teal" },
        image,
      );
      const icon = alert?.options.icon ?? "";
      const svg = decodeURIComponent(icon.slice(icon.indexOf(",") + 1));
      expect(icon).toMatch(/^data:image\/svg\+xml,/);
      expect(svg).toContain('color="#118c74"');
      expect(svg).toContain(
        symbol === "🏃"
          ? "🏃</text>"
          : `data-symbol="${symbol === "plane" ? "plane" : "bot"}"`,
      );
    },
  );

  it("keeps system and older pushes working with Pim's icon", async () => {
    const image = vi.fn<typeof fetch>();
    expect((await push(null, image))?.options.icon).toBe("/icon-192.png");
    expect((await push(undefined, image))?.options.icon).toBe("/icon-192.png");
    expect(image).not.toHaveBeenCalled();
  });

  it("still alerts when its icon cannot be loaded", async () => {
    const image = vi.fn<typeof fetch>().mockRejectedValue(new Error("Offline"));
    expect(
      (await push({ id: "planner", icon: null }, image))?.options.icon,
    ).toBe("/icon-192.png");
  });

  it("does not load an icon or show a duplicate alert while the app is visible", async () => {
    const image = vi.fn<typeof fetch>();
    expect(
      await push({ id: "planner", icon: 42 }, image, true),
    ).toBeUndefined();
    expect(image).not.toHaveBeenCalled();
  });
});

describe("grouped push alerts", () => {
  const worker = readFileSync(
    new URL("../../public/sw.js", import.meta.url),
    "utf8",
  );

  /** A service worker that keeps the alerts on screen, as a browser does, keyed by tag. */
  function device() {
    let receive: (event: unknown) => void = () => {};
    const screen = new Map<
      string,
      { title: string; body: string; tag: string; data: unknown; close(): void }
    >();
    runInNewContext(worker, {
      self: {
        addEventListener: (type: string, listener: typeof receive) => {
          if (type === "push") receive = listener;
        },
        clients: { matchAll: async () => [] },
        registration: {
          getNotifications: async () => [...screen.values()],
          showNotification: async (
            title: string,
            options: { body: string; tag: string; data: unknown },
          ) => {
            screen.set(options.tag, {
              title,
              ...options,
              close: () => screen.delete(options.tag),
            });
          },
        },
      },
      fetch: async () => new Response(null, { status: 404 }),
      Uint8Array,
      btoa,
    });
    return {
      async push(id: string, session: string, title: string, body: string) {
        let finished: Promise<void> | undefined;
        receive({
          data: { json: () => ({ id, session, title, body }) },
          waitUntil: (promise: Promise<void>) => {
            finished = promise;
          },
        });
        await finished;
      },
      alerts: () =>
        [...screen.values()].map(({ title, body }) => ({ title, body })),
    };
  }

  it("counts replies from one chat in that chat's alert", async () => {
    const phone = device();
    await phone.push("a", "trip", "Trip", "First");
    await phone.push("b", "trip", "Trip", "Second");
    await phone.push("c", "trip", "Trip", "Third");
    expect(phone.alerts()).toEqual([
      { title: "Trip", body: "3 new messages: Third" },
    ]);
  });

  it("replaces chat alerts with one summary once a second chat speaks", async () => {
    const phone = device();
    await phone.push("a", "trip", "Trip", "First");
    await phone.push("b", "trip", "Trip", "Second");
    await phone.push("c", "work", "Work", "Hello");
    expect(phone.alerts()).toEqual([
      { title: "Pim", body: "3 new messages in 2 chats" },
    ]);
    await phone.push("d", "work", "Work", "Again");
    expect(phone.alerts()).toEqual([
      { title: "Pim", body: "4 new messages in 2 chats" },
    ]);
  });

  it("counts a message delivered twice once", async () => {
    const phone = device();
    await phone.push("a", "trip", "Trip", "First");
    await phone.push("a", "trip", "Trip", "First");
    expect(phone.alerts()).toEqual([{ title: "Trip", body: "First" }]);
  });
});
