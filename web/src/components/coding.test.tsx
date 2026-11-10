// @vitest-environment happy-dom
import type { EntryRecord } from "@earendil-works/pi-durable";
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
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodingApiProvider,
  CodingPage,
  CodingThreadPage,
  SIGN_IN_POLL_MS,
} from "~/components/coding";
import {
  CodingSubthreadRow,
  useCodingByChat,
} from "~/components/coding-subthread-row";
import type {
  CodingApi,
  CodingStreamMessage,
  CodingThreadSummary,
  CodingThreadView,
  HarnessLoginStatus,
  HarnessSignIn,
  TranscriptMessage,
} from "~/lib/coding";
import { ApiError } from "~/lib/pim-api";
import { approvalsQuery } from "~/lib/queries";
import { HARNESS_DISCLOSURES } from "../../../src/coding/vault/harnesses";

afterEach(cleanup);

/** One opening of the live stream, which the test feeds and closes. */
class Connection {
  readonly #queue: CodingStreamMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  send(message: CodingStreamMessage) {
    this.#queue.push(message);
    this.#wake?.();
  }
  close() {
    this.#closed = true;
    this.#wake?.();
  }
  async *read(signal: AbortSignal): AsyncGenerator<CodingStreamMessage> {
    for (;;) {
      const next = this.#queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#closed || signal.aborted) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        signal.addEventListener("abort", () => resolve());
      });
      this.#wake = null;
    }
  }
}

const view = (overrides: Partial<CodingThreadView> = {}): CodingThreadView => ({
  id: "t1",
  threadId: "t1",
  url: "/coding/t1",
  task: "Fix the flaky date test",
  status: "idle",
  state: "idle",
  stateReason: null,
  stateDetail: null,
  repo: {
    url: "https://github.com/acme/widgets",
    ref: "main",
    branch: "pim/fix-date-test-t1",
    baseSha: "abc",
  },
  profile: { providerId: "p", model: "m" },
  harness: "pi",
  workspaceProvider: "manager",
  slot: "held",
  queue: null,
  budgetUsd: 3,
  spentUsd: 0.42,
  currentOperation: null,
  inbox: 0,
  checkpoint: null,
  createdBy: { type: "person" },
  parentThread: null,
  createdAt: Date.UTC(2026, 10, 9, 10),
  updatedAt: Date.UTC(2026, 10, 9, 10),
  ...overrides,
  ...(overrides.state ? { status: overrides.state } : {}),
});

const notConnected = (): HarnessLoginStatus => ({
  harness: "claude-code",
  connected: false,
  updatedAt: null,
  byteLength: null,
});

const SIGN_IN_URL = "https://claude.ai/oauth/authorize?code=true&state=s";

const signIn = (state: HarnessSignIn["state"]): HarnessSignIn => ({
  harness: "claude-code",
  state,
  url: state === "waiting_code" ? SIGN_IN_URL : null,
  userCode: null,
  error: null,
});

const DEVICE_URL = "https://auth.openai.com/codex/device";

/** Codex's device-code sign-in, as the API says it. */
const deviceSignIn = (state: HarnessSignIn["state"]): HarnessSignIn => ({
  harness: "codex",
  state,
  url: state === "waiting_code" ? DEVICE_URL : null,
  userCode: state === "waiting_code" ? "K7QM-4XT9P" : null,
  error: null,
});

/** A fake of the API: every route answers from what the test sets, and every live stream is a `Connection`. */
function fakeApi(thread = view(), messages: TranscriptMessage[] = []) {
  const connections: Connection[] = [];
  const api = {
    list: vi.fn<CodingApi["list"]>(async () => ({
      threads: [] as CodingThreadSummary[],
    })),
    start: vi.fn<CodingApi["start"]>(async () => view({ id: "t2" })),
    thread: vi.fn<CodingApi["thread"]>(async () => thread),
    transcript: vi.fn<CodingApi["transcript"]>(async () => ({ messages })),
    diff: vi.fn<CodingApi["diff"]>(async () => ({
      since: "abc",
      head: null,
      diff: "",
      truncated: false,
    })),
    tests: vi.fn<CodingApi["tests"]>(async () => ({ runs: [] })),
    steer: vi.fn<CodingApi["steer"]>(async () => thread),
    abort: vi.fn<CodingApi["abort"]>(async () =>
      view({ state: "idle", stateReason: "aborted" }),
    ),
    continue: vi.fn<CodingApi["continue"]>(async () =>
      view({ state: "running" }),
    ),
    cancel: vi.fn<CodingApi["cancel"]>(async () =>
      view({ state: "idle", stateReason: "cancelled" }),
    ),
    archive: vi.fn<CodingApi["archive"]>(async () =>
      view({ state: "archived" }),
    ),
    push: vi.fn<CodingApi["push"]>(async () => ({
      approval: "a1",
      status: "pending" as const,
      branch: thread.repo.branch,
      head: "def",
      bytes: 100,
      summary: "",
    })),
    events: vi.fn<CodingApi["events"]>((_id, signal) => {
      const connection = new Connection();
      connections.push(connection);
      return connection.read(signal);
    }),
    vault: {
      status: vi.fn<CodingApi["vault"]["status"]>(async () => notConnected()),
      disconnect: vi.fn<CodingApi["vault"]["disconnect"]>(async () =>
        notConnected(),
      ),
      signIn: vi.fn<CodingApi["vault"]["signIn"]>(async () =>
        signIn("waiting_code"),
      ),
      signInStatus: vi.fn<CodingApi["vault"]["signInStatus"]>(async () =>
        signIn("waiting_code"),
      ),
      sendCode: vi.fn<CodingApi["vault"]["sendCode"]>(async () =>
        signIn("connected"),
      ),
      cancelSignIn: vi.fn<CodingApi["vault"]["cancelSignIn"]>(async () =>
        signIn("none"),
      ),
      saveApiKey: vi.fn<CodingApi["vault"]["saveApiKey"]>(async (harness) => ({
        harness,
        connected: true,
        updatedAt: 1,
        byteLength: null,
      })),
    },
  } satisfies CodingApi;
  return { api, connections };
}

function renderWith(api: CodingApi, page: () => ReactNode, at = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // A push asks for an approval; the approvals Pim has are none here.
  client.setQueryData(approvalsQuery().queryKey, []);
  const root = createRootRoute({ component: page });
  const router = createRouter({
    routeTree: root.addChildren(
      ["/coding", "/coding/$threadId", "/chat/$sessionId"].map((path) =>
        createRoute({ getParentRoute: () => root, path }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  render(
    <QueryClientProvider client={client}>
      <CodingApiProvider api={api}>
        <RouterProvider router={router} />
      </CodingApiProvider>
    </QueryClientProvider>,
  );
  return router;
}

const threadPage = (api: CodingApi) =>
  renderWith(api, () => <CodingThreadPage id="t1" />);

const summary = (
  overrides: Partial<CodingThreadSummary> = {},
): CodingThreadSummary => ({
  id: "t1",
  url: "/coding/t1",
  repo: "https://github.com/acme/widgets",
  ref: "main",
  branch: "pim/fix-date-test-t1",
  task: "Fix the flaky date test",
  state: "idle",
  stateReason: null,
  queue: null,
  createdBy: { type: "person" },
  parent: null,
  chat: null,
  harness: "pi",
  spentUsd: 0.42,
  budgetUsd: 3,
  createdAt: Date.UTC(2026, 10, 9, 10),
  updatedAt: Date.UTC(2026, 10, 9, 10),
  ...overrides,
});

describe("the list", () => {
  it("shows each thread's repository, branch, state, place in the queue, spend and link", async () => {
    const { api } = fakeApi();
    api.list.mockResolvedValue({
      threads: [
        summary({
          id: "t2",
          repo: "https://github.com/acme/gadgets",
          branch: "pim/gadgets-t2",
          state: "queued",
          queue: { position: 2, reason: "slots_full" },
          spentUsd: 0,
          budgetUsd: 5,
        }),
        summary(),
      ],
    });
    renderWith(api, CodingPage);
    const rows = await screen.findAllByRole("link", { name: /acme\// });
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "/coding/t2",
      "/coding/t1",
    ]);
    const queued = within(rows[0] as HTMLElement);
    expect(queued.getByText("acme/gadgets")).toBeTruthy();
    expect(queued.getByText("pim/gadgets-t2")).toBeTruthy();
    expect(queued.getByText("Queued")).toBeTruthy();
    expect(queued.getByText("#2 in the queue")).toBeTruthy();
    expect(queued.getByText("$0.00 of $5.00")).toBeTruthy();
    const idle = within(rows[1] as HTMLElement);
    expect(idle.getByText("Idle")).toBeTruthy();
    expect(idle.queryByText(/in the queue/)).toBeNull();
    expect(idle.getByText("$0.42 of $3.00")).toBeTruthy();
  });

  it("says when there are none", async () => {
    const { api } = fakeApi();
    renderWith(api, CodingPage);
    expect(await screen.findByText("No coding threads yet")).toBeTruthy();
  });
});

describe("the start form", () => {
  const field = (name: RegExp) =>
    screen.getByRole("textbox", { name }) as HTMLInputElement;

  it("says what's missing or wrong and sends nothing until it's right", async () => {
    const { api } = fakeApi();
    renderWith(api, CodingPage);
    const start = await screen.findByRole("button", { name: "Start" });
    fireEvent.click(start);
    expect(screen.getByText("Enter the repository's address.")).toBeTruthy();
    expect(screen.getByText("Say what the thread should do.")).toBeTruthy();
    expect(field(/Repository/).getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(field(/Repository/), {
      target: { value: "https://gitlab.com/acme/widgets" },
    });
    fireEvent.change(field(/Task/), { target: { value: "Fix it" } });
    fireEvent.change(field(/Budget/), { target: { value: "0" } });
    fireEvent.click(start);
    expect(screen.getByText(/Use a GitHub address/)).toBeTruthy();
    expect(screen.getByText("Enter an amount above zero.")).toBeTruthy();
    expect(screen.queryByText("Say what the thread should do.")).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("starts the thread with what was given and opens its page", async () => {
    const { api } = fakeApi();
    const router = renderWith(api, CodingPage, "/coding");
    fireEvent.change(
      await screen.findByRole("textbox", { name: /Repository/ }),
      {
        target: { value: "https://github.com/acme/widgets" },
      },
    );
    fireEvent.change(field(/Task/), { target: { value: " Fix it " } });
    fireEvent.change(field(/Budget/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]).toEqual([
      {
        repo: "https://github.com/acme/widgets",
        task: "Fix it",
        budgetUsd: 5,
        operationId: expect.any(String),
      },
    ]);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/coding/t2"),
    );
  });

  it("says when the deployment doesn't allow the repository", async () => {
    const { api } = fakeApi();
    api.start.mockRejectedValue(
      new ApiError(403, "Not allowed", { code: "forbidden" }),
    );
    renderWith(api, CodingPage);
    fireEvent.change(
      await screen.findByRole("textbox", { name: /Repository/ }),
      {
        target: { value: "https://github.com/acme/secret" },
      },
    );
    fireEvent.change(field(/Task/), { target: { value: "Fix it" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This Pim doesn't let coding threads use that repository.",
    );
  });
});

const entry = (id: string, message: unknown) =>
  ({
    id,
    conversationId: "c",
    kind: "pi.message",
    model: [message],
  }) as unknown as EntryRecord;
const userEntry = (id: string, text: string) =>
  entry(id, { role: "user", content: text, timestamp: 1 });
const assistantEntry = (id: string, content: unknown[]) =>
  entry(id, {
    role: "assistant",
    content,
    stopReason: "stop",
    timestamp: 2,
    usage: {},
  });
const snapshot = (entries: EntryRecord[]): CodingStreamMessage =>
  ({
    type: "snapshot",
    entries,
    tools: [],
    inbox: [],
  }) as unknown as CodingStreamMessage;

describe("a thread's page", () => {
  it("shows a queued thread's place and why it waits, and cancels it", async () => {
    const { api } = fakeApi(
      view({
        state: "queued",
        slot: "queued",
        queue: { position: 2, reason: "slots_full" },
      }),
    );
    threadPage(api);
    expect(await screen.findByText("Queued, position 2")).toBeTruthy();
    expect(
      screen.getByText(/Every workspace slot of your space is in use/),
    ).toBeTruthy();
    // Nothing to push before it starts.
    expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("t1"));
    expect(
      await screen.findByText("Cancelled before it started."),
    ).toBeTruthy();
  });

  it("words the other queue reasons plainly", async () => {
    const { api } = fakeApi(
      view({
        state: "queued",
        queue: {
          position: 1,
          reason: "low_disk",
          detail: "9% of the disk free",
        },
      }),
    );
    threadPage(api);
    expect(
      await screen.findByText(/low on disk space.*\(9% of the disk free\)/),
    ).toBeTruthy();
  });

  it("stops a running thread, and steers it with or without interrupting", async () => {
    const { api } = fakeApi(view({ state: "running", currentOperation: "op" }));
    threadPage(api);
    const steer = await screen.findByRole("textbox", {
      name: "Steer the thread",
    });
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(steer, { target: { value: "Only touch src/date.ts" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Interrupt/ }));
    fireEvent.click(send);
    await waitFor(() => expect(api.steer).toHaveBeenCalledTimes(1));
    expect(api.steer.mock.calls[0]).toEqual([
      "t1",
      {
        text: "Only touch src/date.ts",
        interrupt: true,
        operationId: expect.any(String),
      },
    ]);
    await waitFor(() => expect((steer as HTMLTextAreaElement).value).toBe(""));

    fireEvent.change(steer, { target: { value: "Also run lint" } });
    fireEvent.keyDown(steer, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.steer).toHaveBeenCalledTimes(2));
    expect(api.steer.mock.calls[1]?.[1]).toEqual({
      text: "Also run lint",
      operationId: expect.any(String),
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.abort).toHaveBeenCalledWith("t1"));
  });

  it("says a failed thread has no workspace backend and who must set one up", async () => {
    const { api } = fakeApi(
      view({
        state: "failed",
        stateReason: "no_backend",
        stateDetail: "Set PIM_CODING_MANAGER_URL and PIM_CODING_MANAGER_TOKEN.",
      }),
    );
    threadPage(api);
    expect(
      await screen.findByText(/has no workspace backend set up/),
    ).toBeTruthy();
    expect(screen.getByText(/The Pim's owner must set one up/)).toBeTruthy();
    expect(screen.getByText(/PIM_CODING_MANAGER_URL/)).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    // Steering a failed thread does nothing; continuing it does.
    expect(
      screen.queryByRole("textbox", { name: "Steer the thread" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(api.continue).toHaveBeenCalledWith("t1", {
        operationId: expect.any(String),
      }),
    );
  });

  it("shows a budget stop in the transcript and continues with a bigger budget", async () => {
    const { api } = fakeApi(
      view({
        state: "failed",
        stateReason: "budget",
        spentUsd: 3,
        budgetUsd: 3,
      }),
      [
        {
          id: "1",
          role: "user",
          parts: [{ type: "text", text: "Fix it" }],
          timestamp: 1,
        },
        {
          id: "9",
          role: "notice",
          parts: [
            {
              type: "text",
              text: "Stopped: the thread spent $3.00 of its $3 budget.",
            },
          ],
          timestamp: 0,
        },
      ],
    );
    threadPage(api);
    expect(
      await screen.findByText(
        /Stopped at its budget: it spent \$3\.00 of \$3\.00/,
      ),
    ).toBeTruthy();
    const notice = await screen.findByText(
      "Stopped: the thread spent $3.00 of its $3 budget.",
    );
    expect(notice.getAttribute("data-kind")).toBe("notice");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.continue).not.toHaveBeenCalled();
    const budget = screen.getByRole("textbox", { name: /New budget/ });
    expect((budget as HTMLInputElement).value).toBe("6");
    fireEvent.change(budget, { target: { value: "2" } });
    expect(
      screen.getByText("Enter more than it has spent already."),
    ).toBeTruthy();
    fireEvent.change(budget, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(api.continue).toHaveBeenCalledWith("t1", {
        budgetUsd: 10,
        operationId: expect.any(String),
      }),
    );
  });

  it("says plainly, not as an error, that pushing needs the GitHub App", async () => {
    const { api } = fakeApi(
      view({
        checkpoint: {
          seq: 1,
          sha: "def",
          message: "Fix",
          operationId: null,
          createdAt: 1,
        },
      }),
    );
    api.push.mockRejectedValue(
      new ApiError(
        409,
        "GitHub App not configured: ask the Pim owner to set it up",
        {
          code: "github_app_not_configured",
        },
      ),
    );
    threadPage(api);
    const push = await screen.findByRole("button", { name: "Push" });
    fireEvent.click(push);
    await waitFor(() => expect(api.push).toHaveBeenCalledWith("t1"));
    const status = await screen.findByText(/GitHub App not configured/);
    expect(status.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((push as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a push waiting for approval", async () => {
    const { api } = fakeApi(
      view({
        checkpoint: {
          seq: 1,
          sha: "def",
          message: "Fix",
          operationId: null,
          createdAt: 1,
        },
      }),
    );
    threadPage(api);
    fireEvent.click(await screen.findByRole("button", { name: "Push" }));
    expect(
      await screen.findByText("Push pim/fix-date-test-t1 to GitHub"),
    ).toBeTruthy();
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("archives only once confirmed, and an archived thread can only be read", async () => {
    const { api } = fakeApi();
    threadPage(api);
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    expect(api.archive).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group");
    fireEvent.click(within(confirm).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith("t1"));
    expect(
      await screen.findByText(/Archived: its workspace was deleted/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Steer the thread" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("folds tool calls by default and shows test runs apart", async () => {
    const { api } = fakeApi(view(), [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "Fix it" }],
        timestamp: 1,
      },
      {
        id: "2",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "c1",
            name: "bash",
            arguments: { command: "ls src" },
          },
          {
            type: "tool-call",
            id: "c2",
            name: "test",
            arguments: { command: "pnpm test" },
          },
        ],
        timestamp: 2,
      },
      {
        id: "3",
        role: "tool",
        parts: [
          {
            type: "tool-result",
            id: "c1",
            name: "bash",
            content: [{ type: "text", text: "date.ts" }],
            error: false,
          },
        ],
        timestamp: 3,
      },
      {
        id: "4",
        role: "tool",
        parts: [
          {
            type: "tool-result",
            id: "c2",
            name: "test",
            content: [{ type: "text", text: "1 failed, 12 passed" }],
            error: true,
          },
        ],
        timestamp: 4,
      },
    ]);
    threadPage(api);
    const bash = (await screen.findByText("ls src")).closest("details");
    expect(bash?.getAttribute("data-kind")).toBe("tool");
    expect(bash?.open).toBe(false);
    const test = screen.getByText("pnpm test").closest("details");
    expect(test?.getAttribute("data-kind")).toBe("test");
    expect(test?.open).toBe(false);
    // A test's outcome shows on its folded row.
    expect(
      within(test as HTMLElement).getAllByText("1 failed, 12 passed")[0],
    ).toBeTruthy();
  });

  it("follows the live stream, opening it again when it ends, without repeating rows", async () => {
    const task = userEntry("1", "Fix the flaky date test");
    const looking = assistantEntry("2", [
      { type: "text", text: "Looking at the test." },
    ]);
    const done = assistantEntry("3", [{ type: "text", text: "Fixed it." }]);
    const { api, connections } = fakeApi(
      view({ state: "running", currentOperation: "op" }),
      [
        {
          id: "1",
          role: "user",
          parts: [{ type: "text", text: "Fix the flaky date test" }],
          timestamp: 1,
        },
        {
          id: "2",
          role: "assistant",
          parts: [{ type: "text", text: "Looking at the test." }],
          timestamp: 2,
        },
      ],
    );
    threadPage(api);
    expect(await screen.findByText("Looking at the test.")).toBeTruthy();
    await waitFor(() => expect(connections).toHaveLength(1));
    const first = connections[0] as Connection;
    first.send(snapshot([task, looking]));
    first.send({
      type: "events",
      events: [
        { type: "message_end", entry: done },
        { type: "message_end", entry: done },
      ],
    } as unknown as CodingStreamMessage);
    expect(await screen.findByText("Fixed it.")).toBeTruthy();

    first.close();
    await waitFor(() => expect(connections).toHaveLength(2));
    (connections[1] as Connection).send(snapshot([task, looking, done]));
    await waitFor(() => expect(api.events).toHaveBeenCalledTimes(2));

    await waitFor(() => {
      expect(screen.getAllByText("Fix the flaky date test")).toHaveLength(2); // the header and the task
      expect(screen.getAllByText("Looking at the test.")).toHaveLength(1);
      expect(screen.getAllByText("Fixed it.")).toHaveLength(1);
    });
  });

  it("says a thread that isn't in the space doesn't exist", async () => {
    const { api } = fakeApi();
    api.thread.mockRejectedValue(
      new ApiError(404, "No such thread", { code: "not_found" }),
    );
    threadPage(api);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "There's no such coding thread in your space.",
    );
  });
});

describe("the harness", () => {
  it("is named with its mark in the thread's header", async () => {
    const { api } = fakeApi(view({ harness: "claude-code" }));
    threadPage(api);
    const header = (await screen.findByRole("banner")) as HTMLElement;
    expect(within(header).getByText("Claude Code")).toBeTruthy();
    expect(
      header.querySelector("svg[data-harness='claude-code']"),
    ).toBeTruthy();
  });

  it("is chosen in the start form, which then offers to connect Claude Code", async () => {
    const { api } = fakeApi();
    renderWith(api, CodingPage, "/coding");
    const pi = await screen.findByRole("radio", { name: "Pi" });
    expect(pi.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.queryByRole("region", { name: "Connect Claude Code" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Claude Code" }));
    expect(
      await screen.findByRole("region", { name: "Connect Claude Code" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /Repository/ }), {
      target: { value: "https://github.com/acme/widgets" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Task/ }), {
      target: { value: "Fix it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]?.[0]).toMatchObject({
      repo: "https://github.com/acme/widgets",
      task: "Fix it",
      harness: "claude-code",
    });
  });

  it("asks a Claude Code thread waiting for a login to connect, then continues it", async () => {
    const { api } = fakeApi(
      view({
        harness: "claude-code",
        state: "waiting_input",
        stateReason: "login_required",
      }),
    );
    threadPage(api);
    expect(
      await screen.findByText("Claude Code needs you to connect your account."),
    ).toBeTruthy();
    const panel = await screen.findByRole("region", {
      name: "Connect Claude Code",
    });
    expect(within(panel).getByText("Not connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("shows the text a Claude Code turn is writing as it arrives", async () => {
    const { api, connections } = fakeApi(
      view({
        harness: "claude-code",
        state: "running",
        currentOperation: "op",
      }),
    );
    threadPage(api);
    await waitFor(() => expect(connections).toHaveLength(1));
    const live = connections[0] as Connection;
    live.send({ type: "partial", kind: "text", text: "Reading the " });
    live.send({ type: "partial", kind: "text", text: "date test." });
    // The streaming text is split into words as it is shown.
    await waitFor(() =>
      expect(document.body.textContent).toContain("Reading the date test."),
    );
  });
});

describe("connecting Claude Code", () => {
  const openPanel = async (api: CodingApi) => {
    renderWith(api, CodingPage, "/coding");
    fireEvent.click(await screen.findByRole("radio", { name: "Claude Code" }));
    return screen.findByRole("region", { name: "Connect Claude Code" });
  };

  it("says what connecting means, then relays the CLI's sign-in page and code until it's connected", async () => {
    const { api } = fakeApi();
    const panel = within(await openPanel(api));
    expect(await panel.findByText("Not connected")).toBeTruthy();
    const disclosure = HARNESS_DISCLOSURES["claude-code"];
    expect(panel.getByText(disclosure.title)).toBeTruthy();
    for (const paragraph of disclosure.paragraphs) {
      expect(panel.getByText(paragraph)).toBeTruthy();
    }

    fireEvent.click(panel.getByRole("button", { name: "Connect Claude Code" }));
    const link = (await panel.findByRole("link", {
      name: /Sign in to Claude Code/,
    })) as HTMLAnchorElement;
    expect(link.href).toBe(SIGN_IN_URL);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");

    const send = panel.getByRole("button", { name: "Connect" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(api.vault.status).mockResolvedValue({
      ...notConnected(),
      connected: true,
      updatedAt: 1,
      byteLength: 10,
    });
    fireEvent.change(panel.getByRole("textbox", { name: "Code" }), {
      target: { value: "  code#state  " },
    });
    fireEvent.click(send);
    await waitFor(() =>
      expect(api.vault.sendCode).toHaveBeenCalledWith(
        "claude-code",
        "code#state",
      ),
    );
    expect(await panel.findByText("Connected")).toBeTruthy();
    expect(panel.queryByRole("textbox", { name: "Code" })).toBeNull();

    fireEvent.click(panel.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(api.vault.disconnect).toHaveBeenCalledWith("claude-code"),
    );
    expect(await panel.findByText("Not connected")).toBeTruthy();
  });

  it("says why a code didn't work and offers to start the sign-in again", async () => {
    const { api } = fakeApi();
    vi.mocked(api.vault.sendCode).mockResolvedValue({
      ...signIn("waiting_code"),
      state: "failed",
      error: "Claude Code didn't accept that code.",
    });
    const panel = within(await openPanel(api));
    fireEvent.click(
      await panel.findByRole("button", { name: "Connect Claude Code" }),
    );
    fireEvent.change(await panel.findByRole("textbox", { name: "Code" }), {
      target: { value: "wrong" },
    });
    fireEvent.click(panel.getByRole("button", { name: "Connect" }));
    expect((await panel.findByRole("alert")).textContent).toBe(
      "Claude Code didn't accept that code.",
    );
    expect(panel.getByText("Not connected")).toBeTruthy();
    expect(
      panel.getByRole("button", { name: "Connect Claude Code" }),
    ).toBeTruthy();
  });

  it("cancels a sign-in", async () => {
    const { api } = fakeApi();
    const panel = within(await openPanel(api));
    fireEvent.click(
      await panel.findByRole("button", { name: "Connect Claude Code" }),
    );
    fireEvent.click(await panel.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(api.vault.cancelSignIn).toHaveBeenCalledWith("claude-code"),
    );
    expect(
      await panel.findByRole("button", { name: "Connect Claude Code" }),
    ).toBeTruthy();
  });
});

describe("connecting Codex", () => {
  const openPanel = async (api: CodingApi) => {
    renderWith(api, CodingPage, "/coding");
    fireEvent.click(await screen.findByRole("radio", { name: "Codex" }));
    return screen.findByRole("region", { name: "Connect Codex" });
  };
  const codexApi = (thread?: CodingThreadView) => {
    const { api } = fakeApi(thread);
    vi.mocked(api.vault.status).mockResolvedValue({
      ...notConnected(),
      harness: "codex",
    });
    vi.mocked(api.vault.signIn).mockResolvedValue(deviceSignIn("waiting_code"));
    vi.mocked(api.vault.signInStatus).mockResolvedValue(
      deviceSignIn("waiting_code"),
    );
    return api;
  };

  it("is chosen in the start form, says what connecting means, and starts a Codex thread", async () => {
    const api = codexApi();
    const panel = within(await openPanel(api));
    expect(await panel.findByText("Not connected")).toBeTruthy();
    const disclosure = HARNESS_DISCLOSURES.codex;
    expect(panel.getByText(disclosure.title)).toBeTruthy();
    for (const paragraph of disclosure.paragraphs) {
      expect(panel.getByText(paragraph)).toBeTruthy();
    }
    expect(
      screen.queryByRole("region", { name: "Connect Claude Code" }),
    ).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: /Repository/ }), {
      target: { value: "https://github.com/acme/widgets" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Task/ }), {
      target: { value: "Fix it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]?.[0]).toMatchObject({ harness: "codex" });
  });

  it("shows the page and the code to enter there, with nothing to paste, and polls until Codex is connected", async () => {
    const api = codexApi();
    const panel = within(await openPanel(api));
    fireEvent.click(
      await panel.findByRole("button", { name: "Connect Codex" }),
    );
    const link = (await panel.findByRole("link", {
      name: /Sign in to Codex/,
    })) as HTMLAnchorElement;
    expect(link.href).toBe(DEVICE_URL);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(panel.getByText("K7QM-4XT9P")).toBeTruthy();
    expect(panel.getByText("Waiting for you to enter the code…")).toBeTruthy();
    expect(panel.queryByRole("textbox")).toBeNull();
    expect(api.vault.sendCode).not.toHaveBeenCalled();

    // The first time it is asked, the sign-in still waits; the next, the CLI has finished.
    await waitFor(() =>
      expect(api.vault.signInStatus).toHaveBeenCalledWith("codex"),
    );
    vi.mocked(api.vault.status).mockResolvedValue({
      ...notConnected(),
      harness: "codex",
      connected: true,
      updatedAt: 1,
      byteLength: 10,
    });
    vi.mocked(api.vault.signInStatus).mockResolvedValue(
      deviceSignIn("connected"),
    );
    expect(
      await panel.findByText("Connected", undefined, {
        timeout: SIGN_IN_POLL_MS * 2,
      }),
    ).toBeTruthy();
    expect(panel.queryByText("K7QM-4XT9P")).toBeNull();
    expect(
      vi.mocked(api.vault.signInStatus).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);

    fireEvent.click(panel.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(api.vault.disconnect).toHaveBeenCalledWith("codex"),
    );
  });

  it("says why the sign-in failed, offers to start again, and cancels one", async () => {
    const api = codexApi();
    vi.mocked(api.vault.signInStatus).mockResolvedValue({
      ...deviceSignIn("failed"),
      error: "Codex's sign-in didn't finish (it exited 1): start again",
    });
    const panel = within(await openPanel(api));
    fireEvent.click(
      await panel.findByRole("button", { name: "Connect Codex" }),
    );
    expect((await panel.findByRole("alert")).textContent).toBe(
      "Codex's sign-in didn't finish (it exited 1): start again",
    );
    expect(panel.queryByText("K7QM-4XT9P")).toBeNull();

    vi.mocked(api.vault.signInStatus).mockResolvedValue(
      deviceSignIn("waiting_code"),
    );
    fireEvent.click(panel.getByRole("button", { name: "Connect Codex" }));
    await panel.findByText("K7QM-4XT9P");
    fireEvent.click(panel.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(api.vault.cancelSignIn).toHaveBeenCalledWith("codex"),
    );
    expect(
      await panel.findByRole("button", { name: "Connect Codex" }),
    ).toBeTruthy();
  });

  it("asks a Codex thread waiting for a login to connect", async () => {
    threadPage(
      codexApi(
        view({
          harness: "codex",
          state: "waiting_input",
          stateReason: "login_required",
        }),
      ),
    );
    expect(
      await screen.findByText("Codex needs you to connect your account."),
    ).toBeTruthy();
    expect(
      await screen.findByRole("region", { name: "Connect Codex" }),
    ).toBeTruthy();
  });
});

describe("a coding subthread in the chat list", () => {
  const row = (overrides: Partial<CodingThreadSummary> = {}) =>
    renderWith(fakeApi().api, () => (
      <ul>
        <CodingSubthreadRow thread={summary(overrides)} depth={1} />
      </ul>
    ));

  it("shows the harness mark, the task's first line, a status badge and a link to its page", async () => {
    row({
      harness: "codex",
      task: "Fix the flaky date test\nIt fails on Sundays.",
      state: "running",
    });
    const link = await screen.findByRole("link");
    expect(link.getAttribute("href")).toBe("/coding/t1");
    expect(within(link).getByText("Fix the flaky date test")).toBeTruthy();
    expect(link.querySelector("svg[data-harness='codex']")).toBeTruthy();
    expect(within(link).getByText("Running")).toBeTruthy();
  });

  it("falls back to the repository for a title, and names each state's badge", async () => {
    row({ task: "  ", state: "waiting_input" });
    const link = await screen.findByRole("link");
    expect(within(link).getByText("acme/widgets")).toBeTruthy();
    expect(within(link).getByText("Waiting")).toBeTruthy();
  });

  it("is listed under the chat it was started from, by the list's own query", async () => {
    const { api } = fakeApi();
    api.list.mockResolvedValue({
      threads: [
        summary({ id: "a", chat: "chat-1" }),
        summary({ id: "b", chat: "chat-2" }),
        summary({ id: "c", chat: null }),
      ],
    });
    const Under = () => {
      const under = useCodingByChat().get("chat-1") ?? [];
      return (
        <ul>
          {under.map((thread) => (
            <CodingSubthreadRow key={thread.id} thread={thread} depth={1} />
          ))}
        </ul>
      );
    };
    renderWith(api, Under);
    const links = await screen.findAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/coding/a",
    ]);
  });
});

describe("connecting with an API key", () => {
  const VIBE_KEY = "mistral-SECRET-0123456789abcdef";
  const AMP_KEY = "sgamp_user_SECRET_0123456789";
  const keyApi = (
    harness: "mistral-vibe" | "amp",
    thread?: CodingThreadView,
  ) => {
    const { api } = fakeApi(thread);
    vi.mocked(api.vault.status).mockResolvedValue({
      ...notConnected(),
      harness,
    });
    return api;
  };

  it("offers Mistral Vibe in the start form, saves its key from a masked field, and says it's connected at once, never showing the key again", async () => {
    const api = keyApi("mistral-vibe");
    renderWith(api, CodingPage, "/coding");
    fireEvent.click(await screen.findByRole("radio", { name: "Mistral Vibe" }));
    const region = await screen.findByRole("region", {
      name: "Connect Mistral Vibe",
    });
    const panel = within(region);
    expect(await panel.findByText("Not connected")).toBeTruthy();
    expect(
      region.querySelector("svg[data-harness='mistral-vibe']"),
    ).toBeTruthy();
    const disclosure = HARNESS_DISCLOSURES["mistral-vibe"];
    expect(panel.getByText(disclosure.title)).toBeTruthy();
    for (const paragraph of disclosure.paragraphs) {
      expect(panel.getByText(paragraph)).toBeTruthy();
    }
    // Where to make a key, opening apart from Pim.
    const link = panel.getByRole("link", {
      name: /console\.mistral\.ai/,
    }) as HTMLAnchorElement;
    expect(link.href).toBe("https://console.mistral.ai/api-keys");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    // No subscription sign-in to start here.
    expect(panel.queryByRole("button", { name: /^Connect/ })).toBeNull();

    const field = panel.getByLabelText("API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    const save = panel.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: `  ${VIBE_KEY}  ` } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.vault.saveApiKey).toHaveBeenCalledWith(
        "mistral-vibe",
        VIBE_KEY,
      ),
    );
    // Connected straight from the answer, without the page loading again or the status being asked.
    expect(await panel.findByText("Connected")).toBeTruthy();
    expect(
      panel.getByText(
        "Coding threads that use Mistral Vibe run with your key. Pim won't show it again.",
      ),
    ).toBeTruthy();
    expect(panel.queryByLabelText("API key")).toBeNull();
    expect(document.body.innerHTML).not.toContain("SECRET");

    // A thread can be started on it.
    fireEvent.change(screen.getByRole("textbox", { name: /Repository/ }), {
      target: { value: "https://github.com/acme/widgets" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Task/ }), {
      target: { value: "Fix it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]?.[0]).toMatchObject({
      harness: "mistral-vibe",
    });
  });

  it("saves the key with Save or Enter without submitting the start form, and nests no form in a form", async () => {
    const api = keyApi("mistral-vibe");
    renderWith(api, CodingPage, "/coding");
    fireEvent.click(await screen.findByRole("radio", { name: "Mistral Vibe" }));
    const panel = within(
      await screen.findByRole("region", { name: "Connect Mistral Vibe" }),
    );
    expect(document.querySelector("form form")).toBeNull();
    const startForm = document.querySelector("form") as HTMLFormElement;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    startForm.addEventListener("submit", submitted);

    const field = await panel.findByLabelText("API key");
    fireEvent.change(field, { target: { value: VIBE_KEY } });
    fireEvent.click(panel.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.vault.saveApiKey).toHaveBeenCalledTimes(1));
    expect(await panel.findByText("Connected")).toBeTruthy();
    expect(submitted).not.toHaveBeenCalled();

    fireEvent.click(panel.getByRole("button", { name: "Disconnect" }));
    const again = await panel.findByLabelText("API key");
    fireEvent.change(again, { target: { value: VIBE_KEY } });
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() => expect(api.vault.saveApiKey).toHaveBeenCalledTimes(2));
    expect(submitted).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("asks an Amp thread waiting for its token to connect, goes on with it once saved, and disconnects", async () => {
    const api = keyApi(
      "amp",
      view({
        harness: "amp",
        state: "waiting_input",
        stateReason: "login_required",
      }),
    );
    threadPage(api);
    expect(
      await screen.findByText("Amp needs you to connect your account."),
    ).toBeTruthy();
    const panel = within(
      await screen.findByRole("region", { name: "Connect Amp" }),
    );
    expect(await panel.findByText("Not connected")).toBeTruthy();
    expect(
      (panel.getByRole("link", { name: /ampcode\.com/ }) as HTMLAnchorElement)
        .href,
    ).toBe("https://ampcode.com/settings");
    const field = panel.getByLabelText("Access token") as HTMLInputElement;
    expect(field.type).toBe("password");
    const threadCalls = vi.mocked(api.thread).mock.calls.length;
    fireEvent.change(field, { target: { value: AMP_KEY } });
    fireEvent.click(panel.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.vault.saveApiKey).toHaveBeenCalledWith("amp", AMP_KEY),
    );
    expect(await panel.findByText("Connected")).toBeTruthy();
    // The thread, which goes on now, is asked for again.
    await waitFor(() =>
      expect(vi.mocked(api.thread).mock.calls.length).toBeGreaterThan(
        threadCalls,
      ),
    );
    expect(document.body.innerHTML).not.toContain("SECRET");

    vi.mocked(api.vault.disconnect).mockResolvedValue({
      ...notConnected(),
      harness: "amp",
    });
    fireEvent.click(panel.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(api.vault.disconnect).toHaveBeenCalledWith("amp"),
    );
    expect(await panel.findByText("Not connected")).toBeTruthy();
    expect(
      (panel.getByLabelText("Access token") as HTMLInputElement).value,
    ).toBe("");
  });

  it("says why a key was refused, keeping the field to fix it", async () => {
    const api = keyApi("amp");
    vi.mocked(api.vault.saveApiKey).mockRejectedValue(
      new ApiError(400, "This key should start with sgamp_", null),
    );
    renderWith(api, CodingPage, "/coding");
    fireEvent.click(await screen.findByRole("radio", { name: "Amp" }));
    const panel = within(
      await screen.findByRole("region", { name: "Connect Amp" }),
    );
    fireEvent.change(await panel.findByLabelText("Access token"), {
      target: { value: VIBE_KEY },
    });
    fireEvent.click(panel.getByRole("button", { name: "Save" }));
    expect((await panel.findByRole("alert")).textContent).toBe(
      "This key should start with sgamp_",
    );
    expect(panel.getByText("Not connected")).toBeTruthy();
    expect(panel.getByLabelText("Access token")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET");
  });
});
