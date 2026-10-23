import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatTabs, tabShortcutPosition } from "~/components/chat/tabs";
import { sessionsQuery } from "~/lib/queries";
import { openTab, pruneTabs } from "~/lib/tabs";

it.each([["travel"], ["travel", "work", "weekend"]])(
  "keeps open chats accessible with none selected on a new chat dashboard (%j)",
  async (...sessions) => {
    pruneTabs(new Set());
    for (const session of sessions) openTab(session);
    const client = new QueryClient();
    client.setQueryData(
      sessionsQuery().queryKey,
      sessions.map((id) => ({ id, title: id })) as never,
    );
    const root = createRootRoute({
      component: () => <ChatTabs activeId="" />,
    });
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: "/" }),
        createRoute({ getParentRoute: () => root, path: "/chat/$sessionId" }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    try {
      await router.load();
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      expect(
        [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href),
      ).toEqual(sessions.map((session) => `/chat/${session}`));
      expect(html).not.toContain("aria-current");
    } finally {
      client.clear();
      pruneTabs(new Set());
    }
  },
);

const press = (key: string, extra = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...extra,
});

it.each([
  ["1", 0],
  ["5", 4],
  ["9", 8],
])("maps the number %s to position %i from the left", (key, position) => {
  expect(tabShortcutPosition(press(key, { metaKey: true }), true)).toBe(
    position,
  );
  expect(tabShortcutPosition(press(key, { ctrlKey: true }), false)).toBe(
    position,
  );
});

it.each([
  ["the other platform's modifier", press("2", { ctrlKey: true }), true],
  ["the other platform's modifier", press("2", { metaKey: true }), false],
  ["both modifiers", press("2", { metaKey: true, ctrlKey: true }), true],
  ["Alt", press("2", { metaKey: true, altKey: true }), true],
  ["Shift", press("2", { metaKey: true, shiftKey: true }), true],
  ["composing", press("2", { metaKey: true, isComposing: true }), true],
  [
    "already handled",
    press("2", { metaKey: true, defaultPrevented: true }),
    true,
  ],
  ["no modifier", press("2"), true],
  ["zero", press("0", { metaKey: true }), true],
  ["another key", press("k", { metaKey: true }), true],
  ["a longer key", press("10", { metaKey: true }), true],
])("ignores %s", (_, event, mac) => {
  expect(tabShortcutPosition(event, mac)).toBeUndefined();
});

it("shows each tab's shortcut and none past the ninth", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `chat${i}`);
  pruneTabs(new Set());
  for (const id of ids) openTab(id);
  const client = new QueryClient();
  client.setQueryData(
    sessionsQuery().queryKey,
    ids.map((id) => ({ id, title: id })) as never,
  );
  const root = createRootRoute({ component: () => <ChatTabs activeId="" /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/" }),
      createRoute({ getParentRoute: () => root, path: "/chat/$sessionId" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    await router.load();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const keys = [...html.matchAll(/aria-keyshortcuts="([^"]*)"/g)].map(
      ([, key]) => key?.replace(/^\w+\+/, ""),
    );
    expect(keys).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  } finally {
    client.clear();
    pruneTabs(new Set());
  }
});
