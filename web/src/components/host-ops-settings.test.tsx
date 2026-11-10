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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostOpsSection } from "~/components/host-ops-settings";
import type { HostOpsAuditRow, HostOpsStatus } from "~/lib/pim-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TOKEN = "pimhostops_Abc123Def456Ghi789Jkl012Mno345Pqr678Stu901V";
const SEEN = Date.UTC(2026, 10, 10, 8, 30);

/** A Pim that answers the host operations' admin routes, recording each request. */
function server(initial: Partial<HostOpsStatus["credential"]>) {
  const state: HostOpsStatus = {
    credential: {
      present: false,
      revoked: false,
      createdAt: null,
      revokedAt: null,
      ...initial,
    },
    agent: { lastSeenAt: SEEN, version: "0.3.1", commit: "4f2a9c1" },
    queue: { queued: 1, running: 2 },
  };
  const audit: HostOpsAuditRow[] = [
    {
      id: 3,
      ts: SEEN + 2000,
      actorKind: "hostd",
      actorId: null,
      action: "result",
      opId: "9b1d2e3f-0000-4000-8000-000000000000",
      args: null,
      outcome: "rolled_back",
      detail: "health check failed; back on 4f2a9c1",
    },
    {
      id: 2,
      ts: SEEN + 1000,
      actorKind: "agent",
      actorId: "owner-1/p_helper",
      action: "enqueue",
      opId: null,
      args: { op: "restart", args: { service: "egress-proxy" } },
      outcome: "rejected",
      detail:
        "Only the admin's majordomo can run operations on this Pim's host.",
    },
    {
      id: 1,
      ts: SEEN,
      actorKind: "agent",
      actorId: "owner-1/p_majordomo",
      action: "enqueue",
      opId: "9b1d2e3f-0000-4000-8000-000000000000",
      args: { op: "deploy", args: { ref: "origin/main" } },
      outcome: "queued",
      detail: null,
    },
  ];
  const requests: string[] = [];
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const route = `${init?.method ?? "GET"} ${input}`;
      requests.push(route);
      if (route === "GET /api/hostops/status") return reply(state);
      if (route === "GET /api/hostops/audit?limit=100") return reply({ audit });
      if (route === "POST /api/hostops/credential") {
        const rotated = state.credential.present;
        state.credential = {
          present: true,
          revoked: false,
          createdAt: Date.now(),
          revokedAt: null,
        };
        return reply({ token: TOKEN, rotated }, 201);
      }
      if (route === "DELETE /api/hostops/credential") {
        state.credential = {
          ...state.credential,
          present: false,
          revoked: true,
          revokedAt: Date.now(),
        };
        return reply({ revoked: true });
      }
      return reply({ error: "Not found" }, 404);
    }),
  );
  return {
    requests,
    writes: () => requests.filter((r) => !r.startsWith("GET")),
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <HostOpsSection />
    </QueryClientProvider>,
  );
}

describe("Settings → Deployment → Host operations", () => {
  let copied: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  /** What the admin answers to the next question the section asks. */
  let confirm: ReturnType<typeof vi.fn<(message?: string) => boolean>>;
  beforeEach(() => {
    confirm = vi.fn<(message?: string) => boolean>(() => false);
    window.confirm = confirm;
    // This Pim, as the installer is told where it is.
    (
      window as unknown as { happyDOM: { setURL(url: string): void } }
    ).happyDOM.setURL("https://pim.example.test/settings");
    copied = vi.fn<(text: string) => Promise<void>>(async () => {});
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(copied);
  });

  it("shows the daemon and the audit log, newest first, with who asked, for what, and how it went", async () => {
    server({ present: true, createdAt: SEEN - 86_400_000 });
    show();
    expect(await screen.findByText("hostopsd 0.3.1")).toBeTruthy();
    expect(screen.getByText("4f2a9c1")).toBeTruthy();
    const line = screen.getByText(/last seen/).textContent ?? "";
    expect(line).toMatch(/credential issued .* · queued: 1 · running: 2$/);

    const rows = within(await screen.findByRole("table")).getAllByRole("row");
    // The header, then the log as the server gave it, newest first.
    expect(rows).toHaveLength(4);
    const cells = (row: HTMLElement | undefined) => {
      if (!row) throw new Error("No such row");
      return within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    };
    expect(cells(rows[1]).slice(1)).toEqual([
      "hostd",
      "result9b1d2e3f",
      "",
      "rolled_backhealth check failed; back on 4f2a9c1",
    ]);
    expect(cells(rows[2]).slice(1)).toEqual([
      "agentowner-1/p_helper",
      "restartenqueue",
      '{"service":"egress-proxy"}',
      "rejectedOnly the admin's majordomo can run operations on this Pim's host.",
    ]);
    expect(cells(rows[3]).slice(1)).toEqual([
      "agentowner-1/p_majordomo",
      "deployenqueue",
      '{"ref":"origin/main"}',
      "queued",
    ]);
    // Read-only: no way to ask for an operation here.
    expect(screen.queryByRole("button", { name: /deploy/i })).toBeNull();
  });

  it("issues a credential, shows it once with the installer for this Pim, and revokes it", async () => {
    const pim = server({});
    show();
    expect((await screen.findByText(/no credential/)).textContent).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Revoke credential" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Issue credential" }));
    expect(await screen.findByText(TOKEN)).toBeTruthy();
    const command =
      "sudo ./sandbox-manager/hostopsd/install.sh --url https://pim.example.test";
    expect(screen.getByText(command)).toBeTruthy();
    expect(pim.writes()).toEqual(["POST /api/hostops/credential"]);

    // The first copy button copies the credential, the second the installer.
    const copies = screen.getAllByRole("button", { name: "Copy" });
    expect(copies).toHaveLength(2);
    for (const copy of copies) fireEvent.click(copy);
    await waitFor(() => expect(copied).toHaveBeenCalledTimes(2));
    expect(copied.mock.calls).toEqual([[TOKEN], [command]]);

    // Once issued, it can be rotated or revoked; revoking asks first, and hides the token.
    const revoke = await screen.findByRole("button", {
      name: "Revoke credential",
    });
    expect(
      screen.getByRole("button", { name: "Rotate credential" }),
    ).toBeTruthy();
    confirm.mockReturnValueOnce(false);
    fireEvent.click(revoke);
    expect(pim.writes()).toEqual(["POST /api/hostops/credential"]);
    confirm.mockReturnValueOnce(true);
    fireEvent.click(revoke);
    await waitFor(() => expect(screen.queryByText(TOKEN)).toBeNull());
    expect(pim.writes()).toEqual([
      "POST /api/hostops/credential",
      "DELETE /api/hostops/credential",
    ]);
    expect(await screen.findByText(/credential revoked/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Issue credential" }),
    ).toBeTruthy();
  });

  it("rotates a credential only once the admin confirms", async () => {
    const pim = server({ present: true, createdAt: SEEN });
    show();
    const rotate = await screen.findByRole("button", {
      name: "Rotate credential",
    });
    fireEvent.click(rotate);
    expect(confirm).toHaveBeenCalledWith(
      "Issue a new credential? The one the daemon has now stops working.",
    );
    expect(pim.writes()).toEqual([]);
    confirm.mockReturnValueOnce(true);
    fireEvent.click(rotate);
    expect(await screen.findByText(TOKEN)).toBeTruthy();
    expect(pim.writes()).toEqual(["POST /api/hostops/credential"]);
  });
});
