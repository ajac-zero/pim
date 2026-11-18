// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { artifactReference } from "~/components/artifact";
import { ArtifactView } from "~/components/artifact-view";
import type { ArtifactBackend } from "~/lib/pim-api";
import { artifactBackendQuery, artifactQuery } from "~/lib/queries";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
  const url = new URL(
    (link?.[1] ?? "").replaceAll("&amp;", "&"),
    "https://pim.example",
  );
  // It opens New chat over the page it's on, with the artifact attached.
  expect(url.pathname).toBe("/");
  expect(url.searchParams.get("dialog")).toBe("new-chat");
  expect(url.searchParams.get("prompt")).toBe("/artifacts/trip-plan\n\n");
  expect(html).not.toContain("<form");
  client.clear();
});

/** An app with a backend, shown with what its computer last said about it. */
async function renderBackendApp(backend: ArtifactBackend) {
  const client = new QueryClient();
  client.setQueryData(artifactQuery("notes").queryKey, {
    id: "notes",
    title: "Notes",
    kind: "hosted",
    session: null,
    version: 3,
    versions: 3,
    files: 2,
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
  client.setQueryData(artifactBackendQuery("notes").queryKey, backend);
  const root = createRootRoute({
    component: () => (
      <ArtifactView
        artifactId="notes"
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
  client.clear();
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

it("shows how an app's backend is doing, and offers to run the latest version only when it isn't the one running", async () => {
  const running = await renderBackendApp({
    version: 3,
    status: { state: "running", restarts: 2, since: 1 },
    computer: "online",
    access: "owner",
    address: null,
  });
  expect(running).toContain("Running Version 3 · Restarts: 2");
  expect(running).toContain("Stop");
  expect(running).not.toContain("Run version");

  // An older version running, or none running, can be replaced by the latest.
  const older = await renderBackendApp({
    version: 2,
    status: { state: "running", restarts: 0, since: 1 },
    computer: "online",
    access: "owner",
    address: null,
  });
  expect(older).toContain("Run version 3");
  const stopped = await renderBackendApp({
    version: 3,
    status: { state: "stopped", restarts: 0, since: 1 },
    computer: "online",
    access: "owner",
    address: null,
  });
  expect(stopped).toContain("Stopped Version 3");
  expect(stopped).toContain("Run version 3");
  expect(stopped).not.toMatch(/Stop(?!ped)/);

  // With the computer away there is nothing to run it on, and sharing isn't offered for a backend.
  const offline = await renderBackendApp({
    version: 3,
    status: null,
    computer: "offline",
    access: "owner",
    address: null,
  });
  expect(offline).toContain("Your computer is offline");
  expect(offline).not.toContain("Run version");
  expect(offline).not.toContain("Share");

  // Where the app has an address of its own, it can be opened there, and says who may.
  const shared = await renderBackendApp({
    version: 3,
    status: { state: "running", restarts: 0, since: 1 },
    computer: "online",
    access: "circles",
    address: "https://abc.apps.example.com/",
  });
  expect(shared).toContain("Open");
  expect(shared).toContain("Your circles");
  expect(running).not.toContain("Your circles");
});

it("draws the answer of V2's note tools as a note card", () => {
  const answer = JSON.stringify({
    artifact: {
      id: "n_1",
      title: "Plan",
      kind: "markdown",
      version: 2,
      sha256: "a".repeat(64),
      size: 17,
    },
    note: "Saved version 2.",
  });
  expect(artifactReference(answer)).toMatchObject({
    id: "n_1",
    kind: "markdown",
    version: 2,
  });
  expect(artifactReference("No such note")).toBeNull();
});

/** An artifact at version 280 whose history lists only its latest, opened from a link to version 2. */
function oldPin(kind: "markdown" | "hosted") {
  return {
    id: "a1",
    title: "Old pin",
    kind,
    session: null,
    version: 280,
    versions: 1,
    files: 1,
    size: 10,
    sha256: "abc",
    createdAt: 0,
    updatedAt: 0,
    circles: [],
    history: [
      {
        version: 280,
        source: "person" as const,
        createdAt: 0,
        size: 10,
        sha256: "abc",
        restoredFrom: null,
      },
    ],
  };
}

async function openAtOldVersion(kind: "markdown" | "hosted") {
  const client = new QueryClient();
  client.setQueryData(artifactQuery("a1").queryKey, oldPin(kind));
  const root = createRootRoute({
    component: () => (
      <ArtifactView
        artifactId="a1"
        version={2}
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
  return { client, router };
}

it("opens a note pinned at a version its history lacks as the live latest", async () => {
  const { client, router } = await openAtOldVersion("markdown");
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(html).not.toContain("no version");
  expect(html).toContain("Write");
  client.clear();
});

it("still reports a missing version of an app", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(oldPin("hosted"))),
  );
  const { client, router } = await openAtOldVersion("hosted");
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/no version 2/)).toBeDefined();
  client.clear();
});
