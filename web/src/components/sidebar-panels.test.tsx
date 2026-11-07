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
import { NotificationsPanel } from "~/components/sidebar-panels";
import { TooltipProvider } from "~/components/ui/tooltip";
import { notificationsQuery } from "~/lib/queries";

it("shows only unseen notification titles, without their body previews", async () => {
  const client = new QueryClient();
  client.setQueryData(notificationsQuery().queryKey, [
    {
      id: "new",
      kind: "general",
      session: "trip-chat",
      agent: { id: "planner", icon: 42, symbol: null, color: null },
      title: "Your trip is ready",
      body: "A long preview that belongs in the chat instead.",
      createdAt: 0,
      readAt: null,
    },
    {
      id: "old",
      kind: "general",
      session: null,
      agent: null,
      title: "Already seen",
      body: "Old preview",
      createdAt: 0,
      readAt: 1,
    },
    {
      id: "system",
      kind: "general",
      session: null,
      agent: null,
      title: "Account notice",
      body: "A system notice.",
      createdAt: 0,
      readAt: null,
    },
  ]);
  const root = createRootRoute({ component: NotificationsPanel });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/" }),
      createRoute({ getParentRoute: () => root, path: "/chat/$sessionId" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  expect(html).toContain("Your trip is ready");
  expect(html).toContain('href="/chat/trip-chat"');
  expect(html).toContain('src="/api/agents/planner/icon?v=42"');
  expect(html).toContain('src="/icon-192.png"');
  expect(html).not.toContain("A long preview");
  expect(html).not.toContain("Already seen");
  client.clear();
});
