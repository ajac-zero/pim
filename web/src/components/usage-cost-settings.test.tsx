// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageCostSection } from "~/components/usage-cost-settings";
import type { CostReport } from "~/lib/pim-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const report = (overrides: Partial<CostReport> = {}): CostReport => ({
  days: 30,
  since: "2026-10-12",
  priceVersion: "1",
  totalCostUsd: 12.5,
  unpricedCalls: 0,
  calls: 340,
  errors: 2,
  costPer1kOutputTokens: 0.0123,
  cacheHitRatio: 0.62,
  byDay: [
    {
      day: "2026-11-09",
      costUsd: 12.5,
      calls: 340,
      cacheHitRatio: 0.62,
      byAgent: [
        { key: "a1", costUsd: 10 },
        { key: null, costUsd: 2.5 },
      ],
      byModel: [{ key: "gpt-x", costUsd: 12.5 }],
      byRunKind: [{ key: null, costUsd: 12.5 }],
    },
  ],
  topChats: [
    { id: "c1", costUsd: 4.2, calls: 20, turns: 7, avgPromptBytes: 20480 },
  ],
  topCodingThreads: [
    { id: "t1", costUsd: 1, calls: 3, turns: 2, avgPromptBytes: 1024 },
  ],
  ...overrides,
});

/** A Pim that answers the usage cost, agents and chats routes; the cost request fails when `costs` is null. */
function mount(costs: CostReport | null | "pending") {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requests.push(input);
      if (input.startsWith("/api/usage/costs")) {
        if (costs === "pending") return new Promise(() => {});
        if (costs === null)
          return Response.json({ error: "boom" }, { status: 500 });
        return Response.json(costs);
      }
      if (input === "/api/agents")
        return Response.json({ agents: [{ id: "a1", name: "Ada" }] });
      if (input === "/api/sessions")
        return Response.json({
          sessions: [{ id: "c1", title: "Plan the trip" }],
        });
      return Response.json({});
    }),
  );
  const root = createRootRoute({ component: UsageCostSection });
  const router = createRouter({
    routeTree: root.addChildren(
      ["/chat/$sessionId", "/coding/$threadId"].map((path) =>
        createRoute({ getParentRoute: () => root, path }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return requests;
}

describe("UsageCostSection", () => {
  it("shows the summary, series by agent name, and linked tables", async () => {
    mount(report());
    expect(await screen.findByText("$12.50")).toBeTruthy();
    expect(screen.getByText("340")).toBeTruthy();
    expect(screen.getByText("$0.0123")).toBeTruthy();
    expect(screen.getByText("62%")).toBeTruthy();
    expect(screen.queryByText(/without a price/)).toBeNull();
    // The legend resolves the agent id to its name, and a null key to untagged.
    expect(await screen.findByText("Ada")).toBeTruthy();
    expect(screen.getByText("untagged")).toBeTruthy();
    const chat = await screen.findByRole("link", { name: "Plan the trip" });
    expect(chat.getAttribute("href")).toBe("/chat/c1");
    const row = chat.closest("tr") as HTMLElement;
    expect(within(row).getByText("$4.20")).toBeTruthy();
    expect(within(row).getByText("7")).toBeTruthy();
    expect(within(row).getByText("20 KB")).toBeTruthy();
    expect(screen.getByRole("link", { name: "t1" }).getAttribute("href")).toBe(
      "/coding/t1",
    );
  });

  it("falls back to the id for an agent it doesn't know, and splits by run kind", async () => {
    const { byDay } = report();
    mount(
      report({
        byDay: byDay.map((day) => ({
          ...day,
          byAgent: [{ key: "gone", costUsd: 12.5 }],
        })),
      }),
    );
    expect(await screen.findByText("gone")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run kind" }));
    expect(screen.queryByText("gone")).toBeNull();
    expect(screen.getByText("untagged")).toBeTruthy();
  });

  it("warns about unpriced calls", async () => {
    mount(report({ unpricedCalls: 5 }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "5 calls on models without a price",
    );
  });

  it("asks again for another range", async () => {
    const requests = mount(report());
    await screen.findByText("$12.50");
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    await screen.findByText("$12.50");
    expect(requests).toContain("/api/usage/costs?days=90");
  });

  it("says so when there are no calls yet", async () => {
    mount(report({ calls: 0, byDay: [], topChats: [], topCodingThreads: [] }));
    expect(
      await screen.findByText("No model calls in this period yet."),
    ).toBeTruthy();
  });

  it("shows loading and error states", async () => {
    mount("pending");
    expect(await screen.findByRole("status")).toBeTruthy();
    cleanup();
    mount(null);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't load",
    );
  });
});
