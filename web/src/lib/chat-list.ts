import {
  type CodingHarness,
  type CodingStatus,
  type CodingThreadSummary,
  codingStatus,
} from "~/lib/coding";
import type { Session } from "~/lib/pim-api";

/**
 * A row of the chat list: a chat, or a coding thread, which the list shows
 * as a chat of its own kind, with its harness's logo and its status.
 */
export type ChatEntry = Session & { coding?: CodingEntry };

export type CodingEntry = {
  harness: CodingHarness;
  status: CodingStatus;
  /** The agent that started it, whose icon marks its logo; null for one you started. */
  agent: string | null;
  /** What it is listed under: the thread it continues from, or else the chat an agent started it from. */
  from: string | null;
};

/**
 * Coding threads as rows of the chat list. Each is at work while queued or
 * running, archived once archived, and active when it last changed.
 */
export function codingChats(
  threads: readonly CodingThreadSummary[],
): ChatEntry[] {
  return threads.map((thread) => {
    const status = codingStatus(thread);
    const agent = thread.createdBy.type === "agent" ? thread.createdBy : null;
    return {
      id: thread.id,
      title: thread.task.split("\n")[0] || null,
      busy: status === "queued" || status === "running",
      createdAt: thread.createdAt,
      // The list has no change of its own until the thread first records one.
      updatedAt: thread.updatedAt || thread.createdAt,
      responseAt: null,
      unread: false,
      archived: thread.state === "archived",
      coding: {
        harness: thread.harness,
        status,
        agent: agent?.agent ?? null,
        from: thread.parent ?? agent?.chat ?? null,
      },
    };
  });
}

/** Chats matching a search, most recently active first; one never used goes last. */
export function flatChats<T extends ChatEntry>(
  sessions: readonly T[],
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
export function groupByAge<T extends ChatEntry>(
  sessions: readonly T[],
  now = Date.now(),
) {
  const groups: { age: ChatAge; sessions: T[] }[] = [];
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
 * chat whose starting chat isn't in the list, such as one deleted or left out
 * by a search, stands on its own, and so does a chat that carries on one that
 * isn't in the list.
 *
 * A chat that carries on a longer one takes its place: chats the longer one
 * started go under the chat that carries it on, even though the longer one,
 * archived, is listed apart. `all` is every chat, for finding that chat when
 * `list` is only some of them.
 *
 * Coding threads go under the thread they continue from, or else the chat an
 * agent started them from, as task chats do; one you started stands on its
 * own.
 */
export function nestChats<T extends ChatEntry>(
  list: readonly T[],
  all: readonly T[] = list,
) {
  const byId = new Map(all.map((session) => [session.id, session]));
  const next = new Map<string, T>();
  for (const session of all) {
    if (session.continuedFrom) next.set(session.continuedFrom, session);
  }
  const latest = (session: T) => {
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
  const parentOf = new Map<string, T>();
  const top: T[] = [];
  const children = new Map<string, T[]>();
  for (const session of list) {
    const start = byId.get(
      session.startedBy?.session ?? session.coding?.from ?? "",
    );
    const from = byId.get(session.continuedFrom ?? "");
    const parent = start ? latest(start) : from;
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
