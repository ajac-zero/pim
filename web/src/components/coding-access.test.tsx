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
import { CodingAccessSection } from "~/components/coding-access";
import type { CodingAccess, CodingGrant } from "~/lib/pim-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const access = (): CodingAccess => ({
  harnesses: [
    { id: "pi", runsIn: "sandbox", available: false, reason: "No pool." },
    { id: "amp", runsIn: "orb", available: true, reason: null },
  ],
  pools: [],
});

const grant: CodingGrant = {
  grantId: "cg_1",
  ownerId: "o_ann",
  username: "ann",
  permissions: ["coding:start", "coding:push"],
  pools: [],
  repositories: ["github.com/acme/*"],
  grantedAt: "2026-11-01T00:00:00.000Z",
};

const member = (username: string, role: string) => ({
  ownerId: `o_${username}`,
  username,
  role,
  status: "active",
  createdAt: 0,
  activatedAt: 0,
  statusReason: null,
});

function server(grants: CodingGrant[]) {
  const writes: { route: string; body: unknown }[] = [];
  const reply = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const route = `${init?.method ?? "GET"} ${input}`;
      if (route === "GET /api/admin/coding-access") return reply(access());
      if (route === "GET /api/admin/coding-grants") return reply({ grants });
      if (route.startsWith("GET /api/admin/accounts"))
        return reply({
          accounts: [
            member("ann", "member"),
            member("guest1", "guest"),
            member("bo", "admin"),
          ],
        });
      writes.push({
        route,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return reply({ ok: true });
    }),
  );
  return writes;
}

const show = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CodingAccessSection />
    </QueryClientProvider>,
  );

describe("Settings → Coding access", () => {
  it("shows what can run and revokes a grant", async () => {
    const writes = server([grant]);
    show();
    const harnesses = within(
      await screen.findByRole("list", { name: "Where coding runs" }),
    );
    expect(harnesses.getByText("No pool.")).toBeTruthy();
    expect(harnesses.getByText("Runs in an Amp orb")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke ann's coding access" }),
    );
    await waitFor(() =>
      expect(writes).toEqual([
        { route: "DELETE /api/admin/coding-grants/o_ann/cg_1", body: null },
      ]),
    );
  });

  it("gives access with start, steer, push and pull requests by default, never offering a guest", async () => {
    const writes = server([]);
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Give someone access" }),
    );
    const person = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...person.options].map((o) => o.text)).toEqual(["ann", "bo"]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "acme/*" },
    });
    expect(
      (screen.getByRole("checkbox", { name: "Merge" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Give access" }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          route: "POST /api/admin/coding-grants",
          body: {
            ownerId: "o_ann",
            permissions: [
              "coding:start",
              "coding:steer",
              "coding:push",
              "coding:pr",
            ],
            repositories: ["acme/*"],
          },
        },
      ]),
    );
  });
});
