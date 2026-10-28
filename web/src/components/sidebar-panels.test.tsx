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
import {
  ArtifactsPanel,
  NotificationsPanel,
} from "~/components/sidebar-panels";
import { TooltipProvider } from "~/components/ui/tooltip";
import {
  artifactsQuery,
  notificationsQuery,
  sessionsQuery,
  sharedArtifactsQuery,
} from "~/lib/queries";

it("opens artifacts on their own page even when their originating chat exists", async () => {
  const client = new QueryClient();
  client.setQueryData(sessionsQuery().queryKey, [
    { id: "origin-chat", title: "The originating chat" },
  ] as never);
  client.setQueryData(artifactsQuery().queryKey, {
    artifacts: [
      {
        id: "trip-plan",
        title: "Trip plan",
        kind: "markdown",
        session: "origin-chat",
        version: 3,
        updatedAt: 0,
      },
    ],
    bytes: 0,
  } as never);
  client.setQueryData(sharedArtifactsQuery().queryKey, []);
  const root = createRootRoute({ component: ArtifactsPanel });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/" }),
      createRoute({
        getParentRoute: () => root,
        path: "/artifacts/$artifactId",
      }),
      createRoute({ getParentRoute: () => root, path: "/chat/$sessionId" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(([, href]) => href);
  expect(hrefs).toEqual(["/artifacts/trip-plan?v=3"]);
  client.clear();
});

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
