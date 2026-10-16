import { useSyncExternalStore } from "react";

/**
 * The chats open as tabs above the transcript, kept in this browser. A chat
 * opened from the sidebar takes over the preview tab, so browsing chats
 * doesn't pile up tabs; it keeps its own tab once you send a message in it
 * or double-click the tab. Closing a tab only takes it off the strip.
 */

export type Tab = {
  session: string;
  /** Kept tabs stay; the one tab that isn't is the preview tab. */
  kept: boolean;
};

const STORAGE_KEY = "pim-tabs";

let tabs: Tab[] = read();
const listeners = new Set<() => void>();

function read(): Tab[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored : [];
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
 * Shows a chat in a tab: its own tab when it has one, otherwise the preview
 * tab, which it takes over. With `keep`, the chat keeps its tab.
 */
export function showTab(session: string, keep = false) {
  const index = tabs.findIndex((tab) => tab.session === session);
  if (index !== -1) {
    if (keep && !tabs[index]?.kept) {
      update(tabs.with(index, { session, kept: true }));
    }
    return;
  }
  const preview = tabs.findIndex((tab) => !tab.kept);
  if (keep || preview === -1) {
    update([...tabs, { session, kept: keep }]);
  } else {
    update(tabs.with(preview, { session, kept: false }));
  }
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
