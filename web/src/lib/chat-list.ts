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
 * Chats your agents started for tasks under the chat they were started from,
 * however deep the chain goes: the chats with none above them in the list, in
 * its order, and for each chat the ones directly under it, oldest first. A
 * chat whose starting chat isn't in the list, such as one archived, folded
 * away or left out by a search, goes under the nearest chat above it that is;
 * with none, such as when the starting chat was deleted, it stands on its own.
 *
 * A chat that carries on a longer one takes its place: chats the longer one
 * started go under the chat that carries it on, even though the longer one,
 * archived, is listed apart. `all` is every chat, for finding that chat when
 * `list` is only some of them.
 */
export function nestChats(list: readonly Session[], all = list) {
  const byId = new Map(all.map((session) => [session.id, session]));
  const next = new Map<string, Session>();
  for (const session of all) {
    if (session.continuedFrom) next.set(session.continuedFrom, session);
  }
  const latest = (session: Session) => {
    const seen = new Set([session]);
    let last = session;
    for (let more = next.get(last.id); more && !seen.has(more); ) {
      seen.add(more);
      last = more;
      more = next.get(last.id);
    }
    return last;
  };
  const listed = new Set(list);
  // A chat whose own parent is listed elsewhere, such as an archived or folded one, stands under the nearest one above it that is listed.
  const parentFor = (session: Session) => {
    const seen = new Set([session]);
    const above = (chat: Session) => {
      const start = byId.get(chat.startedBy?.session ?? "");
      return start ? latest(start) : byId.get(chat.continuedFrom ?? "");
    };
    let up = above(session);
    while (up && !listed.has(up) && !seen.has(up)) {
      seen.add(up);
      up = above(up) ?? up;
      if (seen.has(up)) break;
    }
    return up;
  };
  const parentOf = new Map<string, Session>();
  const top: Session[] = [];
  const children = new Map<string, Session[]>();
  for (const session of list) {
    const parent = parentFor(session);
    // A link that would close a loop is left out, so every chat is shown.
    let loops = false;
    for (let up = parent; up && !loops; up = parentOf.get(up.id)) {
      loops = up === session;
    }
    if (!parent || !listed.has(parent) || loops) {
      top.push(session);
      continue;
    }
    parentOf.set(session.id, parent);
    children.set(parent.id, [...(children.get(parent.id) ?? []), session]);
  }
  for (const under of children.values()) {
    under.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }
  return { top, children };
}
