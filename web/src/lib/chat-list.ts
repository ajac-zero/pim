import { useSyncExternalStore } from "react";
import type { Session } from "~/lib/pim-api";

export type ChatView = "agents" | "inbox" | "majordomo";
export type InboxOrder = "recent" | "unread";

const STORAGE_KEY = "pim-chat-list";
const DEFAULT = { view: "agents", order: "recent" } as const;

/** The same choice in the desktop sidebar and mobile chats panel, kept in this browser. */
export function useChatListPreferences() {
  const stored = useSyncExternalStore(
    (listener) => {
      window.addEventListener("storage", listener);
      return () => window.removeEventListener("storage", listener);
    },
    () => localStorage.getItem(STORAGE_KEY),
    () => null,
  );
  let view: ChatView = DEFAULT.view;
  let order: InboxOrder = DEFAULT.order;
  try {
    const saved = JSON.parse(stored ?? "null");
    if (saved?.view === "inbox" || saved?.view === "majordomo")
      view = saved.view;
    if (saved?.order === "unread") order = saved.order;
  } catch {
    // A preference from an older browser session can be discarded.
  }
  const set = (next: { view?: ChatView; order?: InboxOrder }) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ view, order, ...next }));
    window.dispatchEvent(new Event("storage"));
  };
  return { view, order, set };
}

/** Flat conversation lists: the inbox includes visits; the majordomo view includes only its chats. */
export function flatChats(
  sessions: readonly Session[],
  majordomo: string | undefined,
  view: "inbox" | "majordomo",
  order: InboxOrder,
  search: string,
  untitled: string,
) {
  const query = search.toLowerCase();
  return sessions
    .filter(
      (session) =>
        (view === "inbox" ||
          (!session.visit &&
            (session.agent ? session.agent.id === majordomo : !!majordomo))) &&
        (session.title ?? untitled).toLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        (view === "inbox" && order === "unread"
          ? Number(b.unread) - Number(a.unread)
          : 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );
}
