// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionCostMenu } from "~/components/chat/session-cost";
import { I18nProvider } from "~/components/i18n";
import { pim, type SessionCost } from "~/lib/pim-api";
import { sessionsQuery } from "~/lib/queries";

const cost = (cacheHitRatio: number | null): SessionCost => ({
  total: 0.5,
  cacheHitRatio,
  models: [
    {
      provider: "p",
      model: "m",
      input: 100,
      output: 10,
      cacheRead: 300,
      cacheWrite: 0,
      cost: 0.5,
    },
  ],
});

function open(sessionCost: SessionCost) {
  vi.spyOn(pim, "sessionCost").mockResolvedValue(sessionCost);
  const turns = vi.spyOn(pim, "sessionTurns").mockResolvedValue([
    {
      id: "a",
      at: "2026-01-01T10:00:00Z",
      model: "m",
      input: 100,
      cacheRead: 300,
      cacheWrite: 0,
      output: 10,
      hitRatio: 0.75,
      cost: 0.5,
    },
  ]);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(sessionsQuery().queryKey, [{ id: "chat" }] as never);
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <SessionCostMenu sessionId="chat" />
      </I18nProvider>
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole("button");
  fireEvent.keyDown(trigger, { key: "Enter" });
  return turns;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => "en",
    setItem: () => {},
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows the cache hit rate and asks for the turn history only when it is opened", async () => {
  const turns = open(cost(0.75));
  expect(await screen.findByText(/Cache hit rate: 75%/)).toBeTruthy();
  expect(turns).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Turn history"));
  expect(await screen.findByText(/100 new, 300 cache read/)).toBeTruthy();
  expect(turns).toHaveBeenCalledTimes(1);
});

it("says the hit rate is not reported when the provider reports no cache", async () => {
  open(cost(null));
  expect(await screen.findByText("Cache hit rate: not reported")).toBeTruthy();
});
