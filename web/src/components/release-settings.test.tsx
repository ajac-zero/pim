// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseSection } from "~/components/release-settings";
import type { Release } from "~/lib/pim-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const release: Release = {
  version: "sha-820ac64e484c",
  revision: "820ac64e484ce1",
  channel: "edge",
  check: "on",
  checkedAt: Date.UTC(2026, 10, 22, 17, 32),
  error: null,
  available: false,
  latest: null,
  daemon: { online: true },
  update: {
    id: "op-1",
    state: "succeeded",
    createdAt: Date.UTC(2026, 10, 22, 17, 30),
    summary: "the stack is up.",
    args: {},
  },
};

function show() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(release), {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSection />
    </QueryClientProvider>,
  );
}

describe("Settings → Deployment → Version", () => {
  it("offers a reload after an update, and stops once the admin has reloaded", async () => {
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const first = show();
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
    first.unmount();

    // The server still reports that update for an hour, but this page is already on its result.
    show();
    await screen.findByText(/Pim sha-820ac64e484c/);
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});
