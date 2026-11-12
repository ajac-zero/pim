// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Activity } from "../../../src/activity-types";
import { ChatRunActivity, RunActivity } from "./run-activity";

const activity: Activity = {
  running: true,
  lastActivityAt: Date.now() - 4000,
  current: [
    {
      name: "test",
      summary: "command=vitest run",
      startedAt: Date.now() - 12000,
      elapsedMs: 12000,
      timeoutMs: 900000,
    },
  ],
  steps: [
    {
      kind: "model",
      at: 100,
      ms: 2000,
      model: "test-model",
      stop: "toolUse",
      error: null,
    },
    {
      kind: "tool",
      id: "a",
      at: 2100,
      ms: 3000,
      name: "read",
      summary: "path=README.md",
      exitCode: 0,
      outputBytes: 42,
      timeoutMs: null,
      error: false,
      approval: null,
    },
  ],
  stalls: [],
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows current redacted command, elapsed time and expandable per-step durations", () => {
  vi.useFakeTimers();
  render(<RunActivity activity={activity} />);
  expect(screen.getByRole("status").textContent).toContain(
    "Now running: test command=vitest run",
  );
  expect(screen.getByRole("status").textContent).toContain("12 s");
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.getByRole("status").textContent).toContain("14 s");
  expect(screen.getByText(/Last activity/)).toBeTruthy();
  const summary = screen.getByText("Step timeline");
  fireEvent.click(summary);
  expect(screen.getByRole("list").textContent).toContain("test-model · 2 s");
  expect(screen.getByRole("list").textContent).toContain(
    "read path=README.md · 3 s · Exit 0 · 42 B",
  );
});

it("shows a stalled badge using the server's verdict, not a browser heuristic", () => {
  render(
    <RunActivity
      activity={{
        ...activity,
        stalls: [{ key: "a", reason: "past declared timeout", since: 100 }],
      }}
    />,
  );
  expect(screen.getByText("Stalled").title).toBe("past declared timeout");
});

it("reads live activity from the chat API and isolates cached records by chat", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(activity), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ChatRunActivity chat="chat-1" />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByText(/command=vitest run/)).toBeTruthy(),
  );
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/sessions/chat-1/activity");
  view.unmount();
  client.clear();
});

it("renders nothing when a list row has no activity", () => {
  const { container } = render(
    <RunActivity activity={undefined} timeline={false} />,
  );
  expect(container.childElementCount).toBe(0);
  expect(screen.queryByRole("status")).toBeNull();
});
