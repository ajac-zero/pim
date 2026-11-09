import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useCodingApi } from "~/components/coding";
import { HarnessIcon } from "~/components/harness-icon";
import { useI18n } from "~/components/i18n";
import { CornerDownRight } from "~/components/icons";
import {
  ACTIVE_STATES,
  type CodingThreadSummary,
  codingByChat,
  codingThreadsQuery,
  HARNESS_NAMES,
  repoName,
  type SubthreadStatus,
  subthreadStatus,
} from "~/lib/coding";
import { cn } from "~/lib/utils";

const BADGE_TEXT = {
  queued: "codingBadgeQueued",
  running: "codingBadgeRunning",
  waiting: "codingBadgeWaiting",
  done: "codingBadgeDone",
  failed: "codingBadgeFailed",
} as const;

const BADGE_CLASS: Record<SubthreadStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-primary/10 text-primary motion-safe:animate-pulse",
  waiting: "bg-link/10 text-link",
  done: "bg-success/10 text-success",
  failed: "bg-destructive/10 text-destructive",
};

/** The coding threads started from each chat, kept live while any is queued or running. */
export function useCodingByChat() {
  const { data } = useQuery({
    ...codingThreadsQuery(useCodingApi()),
    refetchInterval: (query) =>
      query.state.data?.some((thread) => ACTIVE_STATES.includes(thread.state))
        ? 5000
        : false,
  });
  return useMemo(() => codingByChat(data ?? []), [data]);
}

/** The row's title: the first line of the task, or the repository when there is none. */
export function subthreadTitle(thread: CodingThreadSummary): string {
  const line = thread.task.trim().split("\n")[0] ?? "";
  return line || repoName(thread.repo);
}

/**
 * A coding thread in the chat list, below the chat it was started from: its
 * harness's mark where a chat has its agent's avatar, its title and its status.
 * It opens the thread's page.
 */
export function CodingSubthreadRow({
  thread,
  depth,
  active = false,
  onNavigate,
}: {
  thread: CodingThreadSummary;
  depth: number;
  active?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const status = subthreadStatus(thread.state);
  return (
    <li
      className="group/row relative"
      style={{ paddingLeft: `${Math.min(depth, 4) * 0.75}rem` }}
    >
      <Link
        to="/coding/$threadId"
        params={{ threadId: thread.id }}
        onClick={onNavigate}
        title={HARNESS_NAMES[thread.harness]}
        className={cn(
          "flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent",
          active && "bg-sidebar-accent",
        )}
      >
        <CornerDownRight className="-ml-1 mr-[2px] size-3.5 shrink-0 text-muted-foreground/70" />
        <HarnessIcon harness={thread.harness} className="size-5" />
        <span className="min-w-0 flex-1 truncate">
          {subthreadTitle(thread)}
        </span>
        <span
          data-status={status}
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none",
            BADGE_CLASS[status],
          )}
        >
          {t(BADGE_TEXT[status])}
        </span>
      </Link>
    </li>
  );
}
