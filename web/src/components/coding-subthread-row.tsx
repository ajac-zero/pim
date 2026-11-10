import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { CodingHarnessMark, useCodingApi } from "~/components/coding";
import { CornerDownRight } from "~/components/icons";
import {
  ACTIVE_STATES,
  type CodingThreadSummary,
  codingByChat,
  codingThreadsQuery,
  codingUnread,
  HARNESS_NAMES,
  repoName,
} from "~/lib/coding";
import { cn } from "~/lib/utils";

/** The coding threads started from each chat, kept live while any is queued or running. Archived ones are left out, as the chat list leaves out what is archived. */
export function useCodingByChat() {
  const { data } = useQuery({
    ...codingThreadsQuery(useCodingApi()),
    refetchInterval: (query) =>
      query.state.data?.some((thread) => ACTIVE_STATES.includes(thread.state))
        ? 5000
        : false,
  });
  return useMemo(
    () =>
      codingByChat(
        (data ?? []).filter((thread) => thread.state !== "archived"),
      ),
    [data],
  );
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
        <CodingHarnessMark
          harness={thread.harness}
          state={thread.state}
          unread={codingUnread(thread)}
          className="size-5"
        />
        <span className="min-w-0 flex-1 truncate">
          {subthreadTitle(thread)}
        </span>
      </Link>
    </li>
  );
}
