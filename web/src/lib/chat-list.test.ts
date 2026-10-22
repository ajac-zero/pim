import { describe, expect, it } from "vitest";
import { chatAge, flatChats } from "~/lib/chat-list";
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
