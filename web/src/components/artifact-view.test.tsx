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
import { ArtifactView } from "~/components/artifact-view";
import { artifactQuery } from "~/lib/queries";

it("offers a new-chat draft with the artifact reference instead of a change-request form", async () => {
  const client = new QueryClient();
  client.setQueryData(artifactQuery("trip-plan").queryKey, {
    id: "trip-plan",
    title: "Trip plan",
    kind: "markdown",
    session: "original-chat",
    version: 3,
    versions: 1,
    files: 1,
    size: 10,
    sha256: "abc",
    createdAt: 0,
    updatedAt: 0,
    circles: [],
    history: [
      {
        version: 3,
        source: "agent",
        createdAt: 0,
        size: 10,
        sha256: "abc",
        restoredFrom: null,
      },
    ],
  });
  const root = createRootRoute({
    component: () => (
      <ArtifactView
        artifactId="trip-plan"
        onVersion={() => {}}
        onDeleted={() => {}}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const header = /<header[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
  const link = [
    ...header.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g),
  ].find(([tag]) => tag.includes('aria-label="Chat"'));
  expect(link).toBeDefined();
  expect(link?.[2]?.replace(/<[^>]+>/g, "")).toBe("Chat");
  const url = new URL(link?.[1] ?? "", "https://pim.example");
  expect(url.pathname).toBe("/");
  expect(url.searchParams.get("prompt")).toBe("/artifacts/trip-plan\n\n");
  expect(html).not.toContain("<form");
  client.clear();
});
