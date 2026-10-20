import { useSyncExternalStore } from "react";

/**
 * The chats open as tabs above the transcript, kept in this browser. They
 * work like a browser's tabs: a chat opened from the sidebar shows in the
 * current tab, in place of the chat it showed, and only "Open in new tab"
 * gives a chat a tab of its own. Closing a tab only takes it off the strip.
 */

export type Tab = { session: string };

const STORAGE_KEY = "pim-tabs";

let tabs: Tab[] = read();
/** The chat this window showed last, whose tab is the current one. */
let current: string | undefined;
const listeners = new Set<() => void>();

function read(): Tab[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(stored)
      ? stored.map(({ session }: Tab) => ({ session }))
      : [];
  } catch {
    return [];
  }
}

function update(next: Tab[]) {
  tabs = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Without storage the tabs last until the page reloads.
  }
  for (const listener of listeners) listener();
}

export function getTabs() {
  return tabs;
}

export function useTabs() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getTabs,
    getTabs,
  );
}

/**
 * Shows a chat: in its own tab when it has one, otherwise in the current
 * tab, in place of the chat shown there. With no current tab, it gets a new one.
 */
export function showTab(session: string) {
  const previous = current;
  current = session;
  if (tabs.some((tab) => tab.session === session)) return;
  const index = tabs.findIndex((tab) => tab.session === previous);
  update(index === -1 ? [...tabs, { session }] : tabs.with(index, { session }));
}

/** Gives a chat a tab of its own, after the others, unless it has one. */
export function openTab(session: string) {
  if (tabs.some((tab) => tab.session === session)) return;
  update([...tabs, { session }]);
}

/** Takes a chat's tab off the strip and returns the chat to show in its place, if any. */
export function closeTab(session: string): string | undefined {
  const index = tabs.findIndex((tab) => tab.session === session);
  if (index === -1) return undefined;
  update(tabs.toSpliced(index, 1));
  return (tabs[index] ?? tabs[index - 1])?.session;
}

/** Closes the tabs of chats that no longer exist, such as deleted ones. */
export function pruneTabs(sessions: ReadonlySet<string>) {
  if (tabs.every((tab) => sessions.has(tab.session))) return;
  update(tabs.filter((tab) => sessions.has(tab.session)));
}
