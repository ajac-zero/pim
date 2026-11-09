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
  TranscriptMessage,
} from "~/lib/coding";
import { ApiError } from "~/lib/pim-api";
import { approvalsQuery } from "~/lib/queries";

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
