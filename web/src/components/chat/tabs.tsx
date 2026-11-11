import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { AgentIcon, swatchClass } from "~/components/agent-icon";
import {
  AwaitingApprovalMark,
  sessionTitle,
  useAwaitingApproval,
} from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { AlertCircle, Loader2, X } from "~/components/icons";
import type { Session } from "~/lib/pim-api";
import { agentsQuery, sessionsQuery } from "~/lib/queries";
import {
  CHAT_DRAG_TYPE,
  pinTab,
  pruneTabs,
  unpinTab,
  useTabs,
} from "~/lib/tabs";
import { cn, MAC } from "~/lib/utils";

/**
 * The position a tab shortcut selects: ⌘1 to ⌘9 on a Mac, Ctrl+1 to Ctrl+9
 * elsewhere, counting from the left (so 9 is the ninth tab, not the last).
 * Undefined for any other key press, including one with a modifier of the
 * other platform, Alt or Shift, one while composing text, or one already
 * handled.
 */
export function tabShortcutPosition(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "metaKey"
    | "ctrlKey"
    | "altKey"
    | "shiftKey"
    | "isComposing"
    | "defaultPrevented"
  >,
  mac: boolean,
) {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.altKey || event.shiftKey) return;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) {
    return;
  }
  return /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : undefined;
}

/** Whether a chat is working or waiting for the person, in a mark. */
function SessionStatus({ session }: { session: Session }) {
  const { t } = useI18n();
  const awaitingApproval = useAwaitingApproval();
  // A run waiting for the person's approval is busy too, but waits on them.
  return awaitingApproval.has(session.id) ? (
    <AwaitingApprovalMark className="ml-0" />
  ) : session.busy ? (
    <Loader2
      className="size-3 shrink-0 text-primary motion-safe:animate-spin"
      role="img"
      aria-label={t("working")}
    />
  ) : session.held ? (
    <AlertCircle
      className="size-3 shrink-0 text-destructive"
      role="img"
      aria-label={t("waitingToTryAgain")}
    />
  ) : null;
}

/** The open chat's agent icon, status and title, for its header. */
export function ChatTitle({ activeId }: { activeId: string }) {
  const { t } = useI18n();
  const { data: sessions } = useQuery(sessionsQuery());
  const { data: agents } = useQuery(agentsQuery());
  const session = sessions?.find((candidate) => candidate.id === activeId);
  if (!session) return null;
  const agent = session.visit
    ? undefined
    : agents?.find((candidate) =>
        session.agent ? candidate.id === session.agent.id : candidate.majordomo,
      );
  return (
    <>
      {agent && (
        <Link
          to="."
          search={(prev) => ({ ...prev, dialog: "agents", agent: agent.id })}
          aria-label={t("editAgent")}
          className="shrink-0 rounded-md"
        >
          <AgentIcon
            agent={agent}
            tile
            className="size-6 shrink-0 rounded-md"
          />
        </Link>
      )}
      <SessionStatus session={session} />
      <span className="truncate">{sessionTitle(session, t)}</span>
    </>
  );
}

/**
 * The pinned chats, as tabs above the chat's header. Each shows its title
 * and whether it is working or waiting for an approval, so chats in
 * the background stay in view with the sidebar collapsed. A chat that is not
 * pinned has no tab.
 */
export function ChatTabs({ activeId }: { activeId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const tabs = useTabs();
  const { data: sessions } = useQuery(sessionsQuery());
  const { data: agents } = useQuery(agentsQuery());
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (sessions) pruneTabs(new Set(sessions.map((session) => session.id)));
  }, [sessions]);

  // The chats shown, left to right: open tabs whose chat still exists.
  const open = tabs.filter((tab) =>
    sessions?.some((session) => session.id === tab.session),
  );
  const shown = open.map((tab) => tab.session);
  const shownKey = shown.join("\n");

  // ⌘1 to ⌘9 (Ctrl+1 to Ctrl+9 away from a Mac) opens the chat in that
  // position. Browsers may keep these keys for their own tabs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: shownKey stands for the list shown.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const position = tabShortcutPosition(event, MAC);
      const target = position === undefined ? undefined : shown[position];
      if (!target) return;
      event.preventDefault();
      if (target !== activeId) {
        navigate({ to: "/chat/$sessionId", params: { sessionId: target } });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shownKey, activeId, navigate]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new active tab, or more tabs, may push it out of view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <nav
      aria-label={t("openChats")}
      className="h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
    >
      {/* The padding leaves room for the open tab's flared corners. */}
      <ul className="flex h-full items-end gap-1 px-2">
        {tabs.map((tab) => {
          const position = shown.indexOf(tab.session);
          const session = sessions?.find(
            (candidate) => candidate.id === tab.session,
          );
          if (!session) return null;
          const active = session.id === activeId;
          const title = sessionTitle(session, t);
          const color = swatchClass(
            agents?.find((agent) => agent.id === session.agent?.id)?.color ??
              null,
          );
          const status = <SessionStatus session={session} />;
          const shortcut =
            position < 9 ? `${MAC ? "⌘" : "Ctrl+"}${position + 1}` : undefined;
          return (
            <li
              key={session.id}
              ref={active ? activeRef : undefined}
              className={cn(
                "group/tab relative flex h-10 w-56 min-w-28 shrink items-center rounded-t-xl transition-colors",
                // The open tab is part of the canvas below it, like a folder's tab:
                // its bottom corners flare out into the shelf.
                active
                  ? "z-10 bg-background text-foreground before:absolute before:bottom-0 before:-left-2 before:size-2 before:bg-[radial-gradient(circle_at_0_0,transparent_8px,var(--background)_8.5px)] after:absolute after:-right-2 after:bottom-0 after:size-2 after:bg-[radial-gradient(circle_at_100%_0,transparent_8px,var(--background)_8.5px)]"
                  : "bg-sidebar-accent/50 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              )}
            >
              {color && (
                // A strip in the agent's color tells tabs of different agents
                // apart; the tab's rounded corners clip it so it follows them.
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden rounded-t-xl"
                >
                  <span
                    className={cn(
                      "block h-0.5 transition-opacity",
                      color,
                      active
                        ? "opacity-100"
                        : "opacity-50 group-hover/tab:opacity-100",
                    )}
                  />
                </span>
              )}
              <Link
                to="/chat/$sessionId"
                params={{ sessionId: session.id }}
                // Clicking the open chat's tab keeps its files and apps open.
                search={active ? (prev) => prev : undefined}
                aria-current={active ? "page" : undefined}
                aria-keyshortcuts={
                  shortcut
                    ? `${MAC ? "Meta" : "Control"}+${position + 1}`
                    : undefined
                }
                title={[
                  title,
                  session.agent?.name ?? session.visit?.username,
                  shortcut,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onAuxClick={(event) => {
                  // A middle click closes the tab, as in a browser.
                  if (event.button !== 1) return;
                  event.preventDefault();
                  unpinTab(session.id);
                }}
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-xl pr-8 pl-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {status}
                <span className="truncate">{title}</span>
              </Link>
              <button
                type="button"
                onClick={() => unpinTab(session.id)}
                aria-label={t("unpinTab")}
                className={cn(
                  "absolute right-2 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/tab:opacity-100",
                  active && "opacity-100",
                )}
              >
                <X className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * A page other than a chat's, with the pinned chats as tabs above it so they
 * stay in view; none is open, so none is selected. Without pinned chats the
 * page has the room to itself.
 */
export function WithChatTabs({ children }: { children: ReactNode }) {
  const pinned = useTabs();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {pinned.length > 0 && (
        <header className="hidden h-11 shrink-0 bg-sidebar md:flex">
          <ChatTabs activeId="" />
        </header>
      )}
      {children}
    </div>
  );
}

/**
 * Lets a chat dragged from the sidebar be dropped on an element to pin it
 * as a tab: spread `dropZone` on it. `dropping` is true while one is over it.
 */
export function useChatDrop() {
  const navigate = useNavigate();
  const [dropping, setDropping] = useState(false);
  // Entering a child fires its dragenter before the parent's dragleave, so
  // counting them tells when the chat has left the element altogether.
  const depth = useRef(0);
  // An element removed under the pointer never sends its dragleave; the
  // drag's end, wherever it lands, clears what is left.
  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setDropping(false);
    };
    window.addEventListener("dragend", reset);
    return () => window.removeEventListener("dragend", reset);
  }, []);
  const carriesChat = (event: DragEvent) =>
    event.dataTransfer.types.includes(CHAT_DRAG_TYPE);
  const dropZone = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesChat(event)) return;
      depth.current++;
      setDropping(true);
    },
    onDragOver: (event: DragEvent) => {
      if (carriesChat(event)) event.preventDefault();
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesChat(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDropping(false);
    },
    onDrop: (event: DragEvent) => {
      depth.current = 0;
      setDropping(false);
      const session = event.dataTransfer.getData(CHAT_DRAG_TYPE);
      if (!session) return;
      event.preventDefault();
      pinTab(session);
      navigate({ to: "/chat/$sessionId", params: { sessionId: session } });
    },
  };
  return { dropping, dropZone };
}
