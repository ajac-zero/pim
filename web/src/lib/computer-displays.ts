import type { ComputerDisplay, ComputerDisplays } from "~/lib/pim-api";

/** Every display in the list the Computer view shows: those in use, then the chats waiting for one in their queue order. */
export function allDisplays(
  data: ComputerDisplays | undefined,
): ComputerDisplay[] {
  return data ? [...data.displays, ...data.queue] : [];
}

/** The display a chat holds or waits for, if any. */
export function displayOf(
  data: ComputerDisplays | undefined,
  chat: string | undefined,
): ComputerDisplay | undefined {
  return chat
    ? allDisplays(data).find((one) => one.threadId === chat)
    : undefined;
}

/**
 * What the Computer view shows first: the display of the chat you have open
 * when it holds one that can be shown, else the primary desktop (null).
 */
export function defaultDisplay(
  data: ComputerDisplays | undefined,
  chat: string | undefined,
): string | null {
  const own = displayOf(data, chat);
  return own && (own.state === "active" || own.state === "idle")
    ? own.threadId
    : null;
}

/** How long a display has been idle, in the shortest words: 45s, 4m, 2h 5m. */
export function idleFor(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest
    ? `${Math.floor(minutes / 60)}h ${rest}m`
    : `${Math.floor(minutes / 60)}h`;
}

/** Whether a display's picture can be shown: not while it waits in the queue or starts. */
export function showable(display: ComputerDisplay): boolean {
  return display.state === "active" || display.state === "idle";
}
