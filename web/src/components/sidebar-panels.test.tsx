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
import { SidebarPanelContent } from "~/components/app-sidebar";
import { NotificationsPanel } from "~/components/sidebar-panels";
import { TooltipProvider } from "~/components/ui/tooltip";
import {
  type CodingThreadSummary,
  codingApi,
  codingThreadsQuery,
} from "~/lib/coding";
import type { Agent } from "~/lib/pim-api";
import { agentsQuery, notificationsQuery, sessionsQuery } from "~/lib/queries";

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

it("lists coding threads with their harness's logo and status, under the chat an agent started them from", async () => {
  const client = new QueryClient();
  const agent = (id: string, name: string, majordomo = false) => ({
    id,
    name,
    icon: null,
    symbol: null,
    color: null,
    majordomo,
  });
  client.setQueryData(agentsQuery().queryKey, [
    agent("majordomo", "Pim", true),
    agent("coder", "Coder"),
  ] as Agent[]);
  const now = Date.now();
  client.setQueryData(sessionsQuery().queryKey, [
    {
      id: "trip-chat",
      title: "Plan the trip",
      busy: false,
      createdAt: now - 10,
      updatedAt: now - 10,
      responseAt: null,
      unread: false,
      agent: { id: "coder", name: "Coder" },
    },
  ]);
  const thread = {
    url: "",
    repo: "https://github.com/acme/widgets",
    ref: "main",
    branch: "pim/x",
    stateReason: null,
    queue: null,
    parent: null,
    spentUsd: 0,
    budgetUsd: 3,
    createdAt: now,
    updatedAt: now,
  };
  client.setQueryData(codingThreadsQuery(codingApi).queryKey, [
    {
      ...thread,
      id: "under-chat",
      harness: "claude-code",
      task: "Fix the date test",
      state: "running",
      createdBy: { type: "agent", agent: "coder", chat: "trip-chat" },
    },
    {
      ...thread,
      id: "yours",
      harness: "codex",
      task: "Write the docs",
      state: "failed",
      createdBy: { type: "person" },
      updatedAt: now - 20,
    },
  ] satisfies CodingThreadSummary[]);
  const root = createRootRoute({
    component: () => <SidebarPanelContent awaitingApproval={new Set()} />,
  });
  const router = createRouter({
    routeTree: root.addChildren(
      ["/", "/chat/$sessionId", "/coding/$threadId"].map((path) =>
        createRoute({ getParentRoute: () => root, path }),
      ),
    ),
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
  // Rows in list order: the chat, the thread its agent started under it, then the thread you started on its own.
  const rows = html.split("<li").slice(1);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain('href="/chat/trip-chat"');
  expect(rows[1]).toContain('href="/coding/under-chat"');
  expect(rows[1]).toContain('aria-label="Claude Code"');
  expect(rows[1]).toContain('aria-label="Working"');
  expect(rows[1]).toContain('aria-label="Started by Coder"');
  expect(rows[1]).toContain("Fix the date test");
  expect(rows[2]).toContain('href="/coding/yours"');
  expect(rows[2]).toContain('aria-label="Codex"');
  expect(rows[2]).toContain('aria-label="Didn&#x27;t finish"');
  expect(rows[2]).not.toContain("Started by");
  // Only the thread under the chat is indented, and the chat counts it among its tasks, at work.
  expect(rows[1]).toContain("padding-left:0.75rem");
  expect(rows[2]).toContain("padding-left:0rem");
  expect(rows[0]).toContain("0/1");
  client.clear();
});
