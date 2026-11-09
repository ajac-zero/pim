import { describe, expect, it } from "vitest";
import {
  type ChatEntry,
  chatAge,
  codingChats,
  flatChats,
  isInactive,
  nestChats,
} from "~/lib/chat-list";
import type { CodingThreadSummary } from "~/lib/coding";
import type { Session } from "~/lib/pim-api";

const chat = (
  id: string,
  updatedAt: number | null,
  overrides: Partial<Session> = {},
): Session => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt,
  busy: false,
  responseAt: null,
  unread: false,
  agent: { id: "majordomo", name: "Pim" },
  ...overrides,
});
const sessions = [
  chat("older unread", 20, {
    unread: true,
    agent: { id: "coach", name: "Coach" },
  }),
  chat("never used", null),
  chat("newest read", 90),
  chat("newer unread", 50, { unread: true }),
  chat("shared space", 70, {
    agent: null,
    visit: { username: "ada", available: true },
  }),
  chat("legacy default", 40, { agent: undefined }),
];
const ids = (list: readonly ChatEntry[]) => list.map((session) => session.id);

describe("flatChats", () => {
  it("lists every chat, visits included, by activity with unused ones last", () => {
    expect(ids(flatChats(sessions, "", "New chat"))).toEqual([
      "newest read",
      "shared space",
      "newer unread",
      "legacy default",
      "older unread",
      "never used",
    ]);
    expect(sessions[0]?.id).toBe("older unread");
  });

  it("searches titles case-insensitively, including unnamed chats", () => {
    expect(ids(flatChats(sessions, "UNREAD", "New chat"))).toEqual([
      "newer unread",
      "older unread",
    ]);
    expect(
      ids(flatChats([chat("untitled", 5, { title: null })], "New", "New chat")),
    ).toEqual(["untitled"]);
  });
});

describe("chatAge", () => {
  const now = new Date(2026, 9, 22, 0, 30).getTime();
  const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
  it("divides by calendar day, not by hours elapsed", () => {
    expect(chatAge(at(22, 0), now)).toBe("today");
    expect(chatAge(at(21, 23), now)).toBe("yesterday");
    expect(chatAge(at(20), now)).toBe("lastWeek");
    expect(chatAge(at(15, 0), now)).toBe("lastWeek");
    expect(chatAge(at(14, 23), now)).toBe("last14Days");
    expect(chatAge(null, now)).toBe("today");
  });
});

describe("nestChats", () => {
  const started = (from: string, createdAt: number) => ({
    createdAt,
    startedBy: {
      session: from,
      agent: { id: "majordomo", name: "Pim" },
      task: `t-${createdAt}`,
      state: "completed" as const,
    },
  });
  it("puts each chat under the chat it was started from at any depth, oldest first, and keeps the others on their own", () => {
    const { top, children } = nestChats([
      chat("second task", 95, started("trip", 3)),
      chat("trip", 90),
      chat("grandchild", 80, started("first task", 4)),
      chat("great-grandchild", 70, started("grandchild", 5)),
      chat("first task", 60, started("trip", 2)),
      chat("orphan", 50, started("deleted", 1)),
      chat("solo", 40),
    ]);
    expect(ids(top)).toEqual(["trip", "orphan", "solo"]);
    expect(ids(children.get("trip") ?? [])).toEqual([
      "first task",
      "second task",
    ]);
    expect(ids(children.get("first task") ?? [])).toEqual(["grandchild"]);
    expect(ids(children.get("grandchild") ?? [])).toEqual(["great-grandchild"]);
    expect(children.has("orphan")).toBe(false);
  });
  it("shows every chat even when two were started from each other", () => {
    const { top, children } = nestChats([
      chat("a", 2, started("b", 1)),
      chat("b", 1, started("a", 2)),
    ]);
    expect(ids(top)).toEqual(["b"]);
    expect(ids(children.get("b") ?? [])).toEqual(["a"]);
  });
  it("puts the chats an old chat started under the chat that carries it on, which is listed apart", () => {
    const old = chat("trip", 70, { archived: true, createdAt: 1 });
    const second = chat("trip, continued", 80, { continuedFrom: "trip" });
    const third = chat("trip, continued twice", 95, {
      continuedFrom: "trip, continued",
    });
    const task = chat("task", 90, started("trip", 3));
    const open = [third, task, chat("solo", 50)];
    const { top, children } = nestChats(open, [...open, second, old]);
    expect(ids(top)).toEqual(["trip, continued twice", "solo"]);
    expect(ids(children.get("trip, continued twice") ?? [])).toEqual(["task"]);
    // The old chat stands on its own in its own list.
    expect(ids(nestChats([old], [...open, second, old]).top)).toEqual(["trip"]);
  });
  it("keeps a chat under the one it carries on when both are listed", () => {
    const { top, children } = nestChats([
      chat("new", 2, { continuedFrom: "old" }),
      chat("old", 1),
    ]);
    expect(ids(top)).toEqual(["old"]);
    expect(ids(children.get("old") ?? [])).toEqual(["new"]);
  });
});

describe("coding threads in the list", () => {
  const thread = (
    id: string,
    overrides: Partial<CodingThreadSummary> = {},
  ): CodingThreadSummary => ({
    id,
    url: `/coding/${id}`,
    repo: "https://github.com/acme/widgets",
    ref: "main",
    branch: `pim/${id}`,
    harness: "pi",
    task: `Task ${id}\nWith details`,
    state: "idle",
    stateReason: null,
    queue: null,
    createdBy: { type: "person" },
    parent: null,
    spentUsd: 0,
    budgetUsd: 3,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  });
  const byAgent = (chat: string) => ({
    createdBy: { type: "agent" as const, agent: "coder", chat },
  });

  it("are rows with their harness, status and starting agent, titled by their task's first line", () => {
    const [queued, codex, fresh] = codingChats([
      thread("q", { state: "queued", queue: { position: 1, reason: "x" } }),
      thread("c", { harness: "codex", state: "archived", ...byAgent("trip") }),
      thread("f", { state: "provisioning", updatedAt: 0 }),
    ]);
    expect(queued).toMatchObject({
      id: "q",
      title: "Task q",
      busy: true,
      archived: false,
      coding: { harness: "pi", status: "queued", agent: null, from: null },
    });
    expect(codex).toMatchObject({
      busy: false,
      archived: true,
      coding: {
        harness: "codex",
        status: "done",
        agent: "coder",
        from: "trip",
      },
    });
    // Until it records a change, it was last active when it started.
    expect(fresh).toMatchObject({ busy: true, updatedAt: 10 });
  });

  it("go under the chat an agent started them from, or the thread they continue, and stand on their own when started by you", () => {
    const list: ChatEntry[] = [
      chat("trip", 90),
      ...codingChats([
        thread("from chat", { createdAt: 2, ...byAgent("trip") }),
        thread("yours"),
        thread("follow-up", {
          createdAt: 3,
          parent: "from chat",
          ...byAgent("trip"),
        }),
        thread("from a deleted chat", byAgent("gone")),
      ]),
    ];
    const { top, children } = nestChats(list);
    expect(ids(top)).toEqual(["trip", "yours", "from a deleted chat"]);
    expect(ids(children.get("trip") ?? [])).toEqual(["from chat"]);
    expect(ids(children.get("from chat") ?? [])).toEqual(["follow-up"]);
    // Without the thread it continues listed, it goes under nothing, as a task chat would.
    const followUp = list.filter((entry) => entry.id === "follow-up");
    expect(ids(nestChats(followUp).top)).toEqual(["follow-up"]);
  });
});

describe("isInactive", () => {
  const now = 1_000_000_000_000;
  const hours = (n: number) => now - n * 60 * 60 * 1000;

  it("folds a read, idle chat after 72 hours, not before", () => {
    expect(isInactive(chat("a", hours(73)), now)).toBe(true);
    expect(isInactive(chat("b", hours(71)), now)).toBe(false);
  });

  it("keeps old chats with unread replies, work running, or no activity yet", () => {
    expect(isInactive(chat("a", hours(200), { unread: true }), now)).toBe(
      false,
    );
    expect(isInactive(chat("b", hours(200), { busy: true }), now)).toBe(false);
    expect(isInactive(chat("c", null), now)).toBe(false);
  });

  it("leaves archived chats to Archived", () => {
    expect(isInactive(chat("a", hours(200), { archived: true }), now)).toBe(
      false,
    );
  });
});
