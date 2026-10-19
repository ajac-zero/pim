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
import { ArtifactsPanel } from "~/components/sidebar-panels";
import {
  artifactsQuery,
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
