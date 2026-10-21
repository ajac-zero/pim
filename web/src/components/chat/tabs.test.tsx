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
import { ChatTabs } from "~/components/chat/tabs";
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
