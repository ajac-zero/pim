import { useSyncExternalStore } from "react";

/**
 * Pinned chats show as tabs above the transcript, kept in this browser. Any
 * other chat opens in place, replacing the chat shown before it, without a
 * tab of its own. Unpinning only takes a chat off the strip.
 */

export type Tab = { session: string };

/** The drag data type of a chat dragged from the sidebar; its value is the chat's id. */
export const CHAT_DRAG_TYPE = "application/x-pim-chat";

const STORAGE_KEY = "pim-tabs";

let tabs: Tab[] = read();
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

/** Pins a chat as a tab after the others, unless it is pinned. */
export function pinTab(session: string) {
  if (tabs.some((tab) => tab.session === session)) return;
  update([...tabs, { session }]);
}

/** Unpins a chat and returns the pinned chat next to it, if any. */
export function unpinTab(session: string): string | undefined {
  const index = tabs.findIndex((tab) => tab.session === session);
  if (index === -1) return undefined;
  update(tabs.toSpliced(index, 1));
  return (tabs[index] ?? tabs[index - 1])?.session;
}

/** Unpins chats that no longer exist, such as deleted ones. */
export function pruneTabs(sessions: ReadonlySet<string>) {
  if (tabs.every((tab) => sessions.has(tab.session))) return;
  update(tabs.filter((tab) => sessions.has(tab.session)));
}
