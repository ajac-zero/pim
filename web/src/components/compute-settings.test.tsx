// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputeSection } from "~/components/compute-settings";
import type { ComputeOverview, SandboxPool } from "~/lib/pim-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const overview = (): ComputeOverview => ({
  providers: [
    {
      id: "compose",
      kind: "compose",
      name: "Team sandboxes",
      settings: { managerUrl: "https://manager.example.test" },
      credentialsSet: { token: true },
      codingSandbox: true,
      agentComputer: false,
    },
  ],
  kinds: [
    { kind: "cloudflare-sandbox", name: "Cloudflare Sandbox", fields: [] },
    {
      kind: "compose",
      name: "Sandbox manager",
      fields: [
        { name: "managerUrl", secret: false, required: true },
        { name: "token", secret: true, required: true },
      ],
    },
  ],
  quota: {
    maxConcurrentWorkspaces: 3,
    monthlySandboxMinutes: 3000,
    maxSessionMinutes: 120,
  },
  usage: {
    month: "2026-11",
    minutes: 95.5,
    running: 1,
    byProvider: [{ provider: "compose", minutes: 95.5, running: 1 }],
    top: [{ username: "ann", minutes: 95.5, running: 1 }],
  },
});

const pools = (): SandboxPool[] => [
  {
    id: "compose",
    provider: "compose",
    size: 2,
    priority: 1,
    enabled: true,
    config: {},
    providerAvailable: true,
    slots: { held: 1, free: 1 },
    queued: 0,
    breaker: { state: "healthy", retryAt: null },
  },
  {
    id: "cloudflare",
    provider: "cloudflare",
    size: 4,
    priority: 2,
    enabled: true,
    config: {},
    providerAvailable: true,
    slots: { held: 0, free: 4 },
    queued: 3,
    breaker: { state: "open", retryAt: Date.now() + 245_000 },
  },
];

/** A Pim that answers the admin's compute routes, recording each request and its body. */
function server() {
  const writes: { route: string; body: unknown }[] = [];
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const route = `${init?.method ?? "GET"} ${input}`;
      if (route === "GET /api/admin/compute") return reply(overview());
      if (route === "GET /api/admin/coding/pools")
        return reply({ pools: pools() });
      writes.push({
        route,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (route === "POST /api/admin/compute/providers/compose/validate")
        return reply({
          health: {
            ok: true,
            message: "Reachable: 1 of 4 workspaces running.",
            ms: 12,
          },
        });
      if (
        route.startsWith("PATCH /api/admin/coding/pools/") ||
        route === "POST /api/admin/coding/pools"
      )
        return reply({ pool: pools()[0] });
      if (route === "DELETE /api/admin/coding/pools/cloudflare")
        return reply({ deleted: true });
      if (route === "PUT /api/admin/compute/quota")
        return reply({ quota: overview().quota });
      return reply({ error: "Not found" }, 404);
    }),
  );
  return writes;
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ComputeSection />
    </QueryClientProvider>,
  );
}

describe("Settings → Compute", () => {
  it("lists providers by whether their credentials are set, checks one, and shows the month's usage", async () => {
    const writes = server();
    show();
    const providers = within(
      await screen.findByRole("list", { name: "Compute providers" }),
    );
    expect(providers.getByText("Team sandboxes")).toBeTruthy();
    expect(
      providers.getByText(/Sandbox manager · https:\/\/manager\.example\.test/),
    ).toBeTruthy();
    expect(providers.getByText(/Token: set/)).toBeTruthy();
    // Only one provider of each kind: the kind that is set up isn't offered again.
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    expect(
      screen.queryByRole("button", { name: "Sandbox manager" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Check Team sandboxes" }),
    );
    expect(
      await screen.findByText("Reachable: 1 of 4 workspaces running."),
    ).toBeTruthy();
    expect(writes).toEqual([
      {
        route: "POST /api/admin/compute/providers/compose/validate",
        body: {},
      },
    ]);

    expect(screen.getByText("Usage in 2026-11")).toBeTruthy();
    expect(screen.getAllByText(/1 running · 95\.5 min/)).toHaveLength(2);
  });

  it("saves a quota with an empty field as no limit, and never takes a credential back from the server", async () => {
    const writes = server();
    show();
    const monthly = await screen.findByLabelText("Sandbox minutes a month");
    fireEvent.change(monthly, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      route: "PUT /api/admin/compute/quota",
      body: {
        quota: {
          maxConcurrentWorkspaces: 3,
          monthlySandboxMinutes: null,
          maxSessionMinutes: 120,
        },
      },
    });

    // Editing a provider asks for the credential again: its field is empty, a password field, and leaving it keeps what is kept.
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Team sandboxes" }),
    );
    const token = screen.getByLabelText("Token");
    expect((token as HTMLInputElement).type).toBe("password");
    expect((token as HTMLInputElement).value).toBe("");
  });

  it("shows each pool's live state, and changes its switch, size and priority, adds and removes pools", async () => {
    const writes = server();
    show();
    const list = within(
      await screen.findByRole("list", { name: "Sandbox pools" }),
    );
    expect(list.getByText("1/2 in use")).toBeTruthy();
    expect(list.getByText("3 queued")).toBeTruthy();
    expect(list.getByText(/Unhealthy, retry in 4:0\d/)).toBeTruthy();

    fireEvent.click(list.getByRole("switch", { name: "Use compose" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      route: "PATCH /api/admin/coding/pools/compose",
      body: { enabled: false },
    });

    // Size and priority save together, and only once changed.
    expect(list.queryByRole("button", { name: "Save cloudflare" })).toBeNull();
    fireEvent.change(list.getByLabelText("Size of cloudflare"), {
      target: { value: "6" },
    });
    fireEvent.change(list.getByLabelText("Priority of cloudflare"), {
      target: { value: "0" },
    });
    fireEvent.click(list.getByRole("button", { name: "Save cloudflare" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({
      route: "PATCH /api/admin/coding/pools/cloudflare",
      body: { size: 6, priority: 0 },
    });

    fireEvent.click(list.getByRole("button", { name: "Remove cloudflare" }));
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.route).toBe("DELETE /api/admin/coding/pools/cloudflare");

    fireEvent.click(screen.getByRole("button", { name: "Add a pool" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "burst" },
    });
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "compose" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Add a pool" }).at(-1)!,
    );
    await waitFor(() => expect(writes).toHaveLength(4));
    expect(writes[3]).toEqual({
      route: "POST /api/admin/coding/pools",
      body: { id: "burst", provider: "compose", size: 2, priority: 10 },
    });
  });
});
