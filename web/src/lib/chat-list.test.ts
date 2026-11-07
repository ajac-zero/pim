import { describe, expect, it } from "vitest";
import { chatAge, flatChats, isInactive, nestChats } from "~/lib/chat-list";
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
const ids = (list: Session[]) => list.map((session) => session.id);

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
