import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { AgentIcon } from "~/components/agent-icon";
import {
  AwaitingApprovalMark,
  PimMark,
  sessionTitle,
  useAwaitingApproval,
} from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import type { Session } from "~/lib/pim-api";
import { agentsQuery, sessionsQuery } from "~/lib/queries";
import { closeTab, pruneTabs, showTab, useTabs } from "~/lib/tabs";
import { cn } from "~/lib/utils";

/**
 * The open chats, as tabs in the chat's header. Each shows its agent, its
 * title, and whether it is working or waiting for an approval, so chats in
 * the background stay in view with the sidebar collapsed. With only one
 * open, it shows that chat's title instead.
 */
export function ChatTabs({ activeId }: { activeId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const tabs = useTabs();
  const { data: sessions } = useQuery(sessionsQuery());
  const { data: agents } = useQuery(agentsQuery());
  const awaitingApproval = useAwaitingApproval();
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (sessions) pruneTabs(new Set(sessions.map((session) => session.id)));
  }, [sessions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new active tab, or more tabs, may push it out of view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  const close = (session: string) => {
    const next = closeTab(session);
    if (session !== activeId) return;
    navigate(
      next
        ? { to: "/chat/$sessionId", params: { sessionId: next } }
        : { to: "/" },
    );
  };

  const agentOf = (session: Session) =>
    session.visit
      ? undefined
      : agents?.find((candidate) =>
          session.agent ? candidate.id === session.agent.id : candidate.majordomo,
        );
  const iconOf = (session: Session, circle: string) => {
    const agent = agentOf(session);
    return session.visit ? (
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full font-medium text-[11px] uppercase",
          circle,
        )}
      >
        {session.visit.username.slice(0, 1)}
      </span>
    ) : agent ? (
      <AgentIcon agent={agent} tile className="size-5 shrink-0 rounded-md" />
    ) : (
      <PimMark className="h-3 w-6 shrink-0" />
    );
  };
  const statusOf = (session: Session) =>
    session.busy ? (
      <span
        className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
        role="img"
        aria-label={t("working")}
      />
    ) : awaitingApproval.has(session.id) ? (
      <AwaitingApprovalMark className="ml-0" />
    ) : null;

  // With one chat open there is nothing to switch between: its title, not a tab.
  const open = tabs.filter((tab) =>
    sessions?.some((session) => session.id === tab.session),
  );
  if (open.length <= 1) {
    const session = sessions?.find((candidate) => candidate.id === activeId);
    if (!session) return <div className="flex-1" />;
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-4 text-[15px]">
        {iconOf(session, "bg-muted")}
        <span className="truncate">{sessionTitle(session, t)}</span>
        {statusOf(session)}
      </div>
    );
  }

  return (
    <nav
      aria-label={t("openChats")}
      className="h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
    >
      {/* The padding leaves room for the open tab's flared corners. */}
      <ul className="flex h-full items-end gap-1 px-2">
        {tabs.map((tab) => {
          const session = sessions?.find(
            (candidate) => candidate.id === tab.session,
          );
          if (!session) return null;
          const active = session.id === activeId;
          const title = sessionTitle(session, t);
          const status = statusOf(session);
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
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Link
                to="/chat/$sessionId"
                params={{ sessionId: session.id }}
                aria-current={active ? "page" : undefined}
                title={[
                  title,
                  session.agent?.name ?? session.visit?.username,
                  !tab.kept && t("keepTabOpen"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onDoubleClick={() => showTab(session.id, true)}
                onAuxClick={(event) => {
                  // A middle click closes the tab, as in a browser.
                  if (event.button !== 1) return;
                  event.preventDefault();
                  close(session.id);
                }}
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-xl pr-8 pl-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {iconOf(session, "bg-background")}
                <span className={cn("truncate", !tab.kept && "italic")}>
                  {title}
                </span>
              </Link>
              {status && (
                <span className="pointer-events-none absolute right-2 flex size-6 items-center justify-center transition-opacity group-hover/tab:opacity-0 group-has-[button:focus-visible]/tab:opacity-0">
                  {status}
                </span>
              )}
              <button
                type="button"
                onClick={() => close(session.id)}
                aria-label={t("closeTab")}
                className={cn(
                  "absolute right-2 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/tab:opacity-100",
                  active && !status && "opacity-100",
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
