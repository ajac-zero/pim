import { describe, expect, it } from "vitest";
import { flatChats } from "~/lib/chat-list";
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

describe("flat conversation views", () => {
  it("orders the inbox by activity, or puts unread replies first and orders each group by activity", () => {
    expect(
      ids(flatChats(sessions, "majordomo", "inbox", "recent", "", "New chat")),
    ).toEqual([
      "newest read",
      "shared space",
      "newer unread",
      "legacy default",
      "older unread",
      "never used",
    ]);
    expect(
      ids(flatChats(sessions, "majordomo", "inbox", "unread", "", "New chat")),
    ).toEqual([
      "newer unread",
      "older unread",
      "newest read",
      "shared space",
      "legacy default",
      "never used",
    ]);
    expect(sessions[0]?.id).toBe("older unread");
  });

  it("shows only the majordomo's chats, in activity order regardless of the inbox's sort", () => {
    expect(
      ids(
        flatChats(sessions, "majordomo", "majordomo", "unread", "", "New chat"),
      ),
    ).toEqual(["newest read", "newer unread", "legacy default", "never used"]);
    expect(
      flatChats(sessions, undefined, "majordomo", "recent", "", "New chat"),
    ).toEqual([]);
  });

  it("searches only the selected view, case-insensitively, including unnamed chats", () => {
    expect(
      ids(
        flatChats(
          sessions,
          "majordomo",
          "inbox",
          "recent",
          "UNREAD",
          "New chat",
        ),
      ),
    ).toEqual(["newer unread", "older unread"]);
    expect(
      flatChats(
        sessions,
        "majordomo",
        "majordomo",
        "recent",
        "shared",
        "New chat",
      ),
    ).toEqual([]);
    expect(
      ids(
        flatChats(
          [chat("untitled", 5, { title: null })],
          "majordomo",
          "majordomo",
          "recent",
          "New",
          "New chat",
        ),
      ),
    ).toEqual(["untitled"]);
  });
});
