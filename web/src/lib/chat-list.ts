import type { Session } from "~/lib/pim-api";

/** Chats matching a search, most recently active first; one never used goes last. */
export function flatChats(
  sessions: readonly Session[],
  search: string,
  untitled: string,
) {
  const query = search.toLowerCase();
  return sessions
    .filter((session) =>
      (session.title ?? untitled).toLowerCase().includes(query),
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

const INACTIVE_AFTER_MS = 72 * 60 * 60 * 1000;

/**
 * A chat that has gone 72 hours without activity, with nothing unread or
 * running: folded away before it is archived. Sending it a message brings it
 * back.
 */
export function isInactive(session: Session, now = Date.now()) {
  return (
    !session.archived &&
    !session.busy &&
    !session.unread &&
    session.updatedAt !== null &&
    session.updatedAt < now - INACTIVE_AFTER_MS
  );
}

export type ChatAge = "today" | "yesterday" | "lastWeek" | "last14Days";

/**
 * Which divider a chat sits under, by calendar days in the browser's time
 * zone: today, yesterday, the week before that, then the rest of the 14 days
 * before it is archived. A chat never used counts as today.
 */
export function chatAge(updatedAt: number | null, now = Date.now()): ChatAge {
  const day = (daysAgo: number) => {
    const date = new Date(now);
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() - daysAgo,
    ).getTime();
  };
  const at = updatedAt ?? now;
  if (at >= day(0)) return "today";
  if (at >= day(1)) return "yesterday";
  if (at >= day(7)) return "lastWeek";
  return "last14Days";
}

/** Consecutive chats under the same age divider, in the order given. */
export function groupByAge(sessions: readonly Session[], now = Date.now()) {
  const groups: { age: ChatAge; sessions: Session[] }[] = [];
  for (const session of sessions) {
    const age = chatAge(session.updatedAt, now);
    const last = groups.at(-1);
    if (last?.age === age) last.sessions.push(session);
    else groups.push({ age, sessions: [session] });
  }
  return groups;
}

/**
 * Chats your agents started for tasks, and chats that carry on a longer
 * one, under the chat they were started from or carry on: the chats with none above them in the list, in its order, and for
 * each, every chat started from it or from one under it, oldest first. A
 * chat whose starting chat isn't in the list, such as one deleted or left
 * out by a search, stands on its own.
 */
export function nestChats(list: readonly Session[]) {
  const byId = new Map(list.map((session) => [session.id, session]));
  const above = (session: Session) =>
    session.startedBy?.session ?? session.continuedFrom ?? "";
  const topOf = (session: Session) => {
    let top = session;
    const seen = new Set([session.id]);
    for (
      let parent = byId.get(above(session));
      parent && !seen.has(parent.id);
      parent = byId.get(above(parent))
    ) {
      seen.add(parent.id);
      top = parent;
    }
    return top;
  };
  const top: Session[] = [];
  const children = new Map<string, Session[]>();
  for (const session of list) {
    const above = topOf(session);
    if (above === session) top.push(session);
    else children.set(above.id, [...(children.get(above.id) ?? []), session]);
  }
  for (const under of children.values()) {
    under.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }
  return { top, children };
}
