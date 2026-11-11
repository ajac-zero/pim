// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerDialog } from "~/components/computer-dialog";
import { ComputerDisplayChip } from "~/components/computer-display-chip";
import type { ComputerDisplay, ComputerDisplays } from "~/lib/pim-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const display = (
  threadId: string,
  overrides: Partial<ComputerDisplay> = {},
): ComputerDisplay => ({
  threadId,
  title: `Chat ${threadId}`,
  state: "active",
  control: "agent",
  idleSec: 0,
  ...overrides,
});

const online = {
  state: "online",
  managed: true,
  pairedAt: 1,
  error: null,
  computer: { screen: true, desktop: true },
};

/** A Pim whose computer is online with these displays; the posts it gets are returned. */
function pim(displays: ComputerDisplays | "none") {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/computer") return Response.json(online);
      if (input === "/api/computer/displays")
        return displays === "none"
          ? Response.json({ error: "no displayd" }, { status: 500 })
          : Response.json(displays);
      if (input === "/api/computer/displays/control") {
        posts.push(JSON.parse(String(init?.body)));
        return Response.json({ control: "user" });
      }
      return Response.json({});
    }),
  );
  return posts;
}

function mount(ui: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("the Computer view's displays", () => {
  it("lists the primary desktop first, then each display with its state, and opens on the chat's own", async () => {
    pim({
      displays: [
        display("a", { title: "Plan the trip", idleSec: 245, state: "idle" }),
        display("b", { title: null, control: "user" }),
      ],
      queue: [display("c", { title: "Book it", state: "queued", position: 2 })],
    });
    mount(<ComputerDialog open chat="a" onOpenChange={() => {}} />);
    const list = await screen.findByRole("navigation", { name: "Displays" });
    const buttons = [...list.querySelectorAll("button")].map((button) => [
      button.textContent,
      button.getAttribute("aria-label"),
    ]);
    expect(buttons).toEqual([
      ["", "Primary desktop"],
      ["1", "Plan the trip: Idle 4m"],
      ["2", "Untitled chat: You"],
      ["3#2", "Book it: Queued #2"],
    ]);
    // The chat you're in is shown, to watch only until you take it over.
    expect(
      screen
        .getByRole("button", { name: /Plan the trip/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText(/Watching only/)).toBeTruthy();
  });

  it("takes a display over, and the primary desktop has nothing to take over", async () => {
    const posts = pim({ displays: [display("a")], queue: [] });
    mount(<ComputerDialog open chat="a" onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
    await vi.waitFor(() =>
      expect(posts).toEqual([{ thread: "a", mode: "user" }]),
    );
    fireEvent.click(screen.getByRole("button", { name: /Primary desktop/ }));
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("shows only the desktop where the computer has no displays", async () => {
    pim("none");
    mount(<ComputerDialog open chat="a" onOpenChange={() => {}} />);
    await vi.waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Displays" })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });
});

describe("the chat header's computer chip", () => {
  it("says how the chat's display is doing, and nothing for a chat without one", async () => {
    pim({
      displays: [],
      queue: [display("c", { state: "queued", position: 2 })],
    });
    mount(<ComputerDisplayChip sessionId="c" />);
    expect(await screen.findByText("Computer: Queued #2")).toBeTruthy();
    cleanup();
    mount(<ComputerDisplayChip sessionId="other" />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/Computer:/)).toBeNull();
  });
});
