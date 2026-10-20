import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import {
  ArrowDownIcon,
  Check,
  ChevronRight,
  Loader2,
  ShieldAlert,
  Wrench,
  X,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { type AgentTask, pim } from "~/lib/pim-api";
import { cn } from "~/lib/utils";

/** How often a chat with tasks at work looks again, besides the server's `tasks` message. */
export const TASK_POLL_MS = 5_000;

const OPEN_STATES = new Set<AgentTask["state"]>(["working", "auth-required"]);

/** A task with its depth in the tree, in the order to show: each under the task it was handed out for. */
type Row = { task: AgentTask; depth: number };

/** The tasks as a tree, flattened depth first; tasks whose parent isn't listed sit at the top. */
export function taskRows(tasks: readonly AgentTask[]): Row[] {
  const ids = new Set(tasks.map((task) => task.id));
  const children = new Map<string | null, AgentTask[]>();
  for (const task of tasks) {
    const parent =
      task.parent !== null && ids.has(task.parent) ? task.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const task of children.get(parent) ?? []) {
      rows.push({ task, depth });
      walk(task.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** A handoff stays where it happened, with each task's current state and a link to its later answer. */
export function TaskCard({
  tasks,
  completions,
  onView,
}: {
  tasks: readonly AgentTask[];
  completions: ReadonlyMap<string, string>;
  onView: (id: string) => void;
}) {
  const { t, formatDate } = useI18n();
  return (
    <section className="rounded-2xl bg-muted p-2" aria-label={t("tasks")}>
      <ul className="space-y-1">
        {taskRows(tasks).map(({ task, depth }) => {
          const completion = completions.get(task.id);
          const delegatedAt = new Date(task.createdAt);
          return (
            <li
              key={task.id}
              id={`task-start-${task.id}`}
              tabIndex={-1}
              style={{ marginLeft: `${depth * 1.25}rem` }}
              className="rounded-xl outline-none"
            >
              <button
                type="button"
                onClick={() => onView(task.id)}
                aria-label={t("viewTaskBy", { agent: task.agent.name })}
                className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="shrink-0">
                  <TaskState state={task.state} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-1 text-[15px]">
                    <span className="max-w-full truncate font-medium">
                      {task.agent.name}
                    </span>
                    <span className="text-muted-foreground">
                      {t(activityKey[task.state])}
                    </span>
                  </span>
                  <span
                    className="mt-0.5 block truncate text-[13px] text-muted-foreground"
                    title={task.task}
                  >
                    {task.task}
                  </span>
                </span>
                <time
                  className="shrink-0 text-muted-foreground text-xs tabular-nums"
                  dateTime={delegatedAt.toISOString()}
                  title={t("taskDelegated", {
                    time: formatDate(delegatedAt, {
                      dateStyle: "full",
                      timeStyle: "short",
                    }),
                  })}
                >
                  {formatDate(delegatedAt, { timeStyle: "short" })}
                </time>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
              {completion && (
                <div className="pb-2 pl-[2.375rem] text-xs">
                  <TaskJump target={`task-update-${completion}`}>
                    {t("jumpToCompletion")}
                    <ArrowDownIcon className="size-3" />
                  </TaskJump>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A transcript link releases the bottom lock and moves focus to the other end of the task's history. */
export function TaskJump({
  target,
  children,
}: {
  target: string;
  children: ReactNode;
}) {
  const { stopScroll, contentRef } = useStickToBottomContext();
  return (
    <a
      href={`#${target}`}
      className="inline-flex items-center gap-1 rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      onClick={(event) => {
        const element = contentRef.current?.querySelector<HTMLElement>(
          `#${CSS.escape(target)}`,
        );
        if (!element) return;
        event.preventDefault();
        stopScroll();
        const reduced = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        element.scrollIntoView({
          block: "center",
          behavior: reduced ? "instant" : "smooth",
        });
        element.focus({ preventScroll: true });
        if (!reduced)
          element.animate(
            [
              { outline: "2px solid var(--ring)", outlineOffset: "4px" },
              { outline: "2px solid transparent", outlineOffset: "4px" },
            ],
            { duration: 1200, easing: "ease-out" },
          );
      }}
    >
      {children}
    </a>
  );
}

/** A task card opens its read-only conversation. */
export function TaskSheet({
  sessionId,
  task,
  onClose,
}: {
  sessionId: string;
  task: AgentTask | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={task !== null} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-full sm:max-w-lg">
        {task && <TaskTranscript sessionId={sessionId} task={task} />}
      </SheetContent>
    </Sheet>
  );
}

const stateKey = {
  working: "taskWorking",
  "auth-required": "taskWaiting",
  completed: "taskDone",
  failed: "taskDidntFinish",
  canceled: "taskCanceled",
} as const;

const activityKey = {
  working: "taskActivityWorking",
  "auth-required": "taskActivityWaiting",
  completed: "taskActivityDone",
  failed: "taskActivityDidntFinish",
  canceled: "taskActivityCanceled",
} as const;

function TaskState({ state }: { state: AgentTask["state"] }) {
  if (state === "working") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (state === "auth-required") {
    return <ShieldAlert className="size-3.5 shrink-0 text-link" />;
  }
  if (state === "completed") {
    return <Check className="size-3.5 shrink-0 text-success" />;
  }
  return (
    <X
      className={cn(
        "size-3.5 shrink-0",
        state === "failed" ? "text-destructive" : "text-muted-foreground",
      )}
    />
  );
}

/** A task's conversation: what it was asked, and what its agent did; and Cancel while it isn't done. */
function TaskTranscript({
  sessionId,
  task,
}: {
  sessionId: string;
  task: AgentTask;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["tasks", sessionId, task.id],
    queryFn: () => pim.task(sessionId, task.id),
    refetchInterval: OPEN_STATES.has(task.state) ? TASK_POLL_MS : false,
  });
  const cancel = useMutation({
    mutationFn: () => pim.cancelTask(sessionId, task.id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["tasks", sessionId] }),
  });
  const state = data?.state ?? task.state;
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <TaskState state={state} />
          {task.agent.name}
          <span className="font-normal text-[13px] text-muted-foreground">
            {t(stateKey[state])}
          </span>
        </SheetTitle>
        <SheetDescription>
          {t("taskReadOnly", { agent: task.agent.name, from: task.from.name })}
        </SheetDescription>
        {OPEN_STATES.has(state) && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-2 self-start"
            disabled={cancel.isPending}
            onClick={() => {
              if (window.confirm(t("cancelTaskConfirm"))) cancel.mutate();
            }}
          >
            {t("cancelTask")}
          </Button>
        )}
      </SheetHeader>
      <ol className="flex-1 space-y-3 overflow-y-auto px-4 pb-6 text-sm">
        {(data?.messages ?? []).flatMap((message) =>
          message.parts.flatMap((part, index) => {
            const key = `${message.id}:${index}`;
            if (part.type === "text" && part.text.trim() !== "") {
              // The requester's messages are an agent's, not the person's: no user bubble.
              const fromRequester = message.role === "user";
              return [
                <li key={key} className={fromRequester ? "ml-8" : "mr-8"}>
                  <p
                    className={cn(
                      "mb-1 px-1 text-muted-foreground text-xs",
                      fromRequester && "text-right",
                    )}
                  >
                    {fromRequester ? task.from.name : task.agent.name}
                  </p>
                  <div
                    className={cn(
                      "rounded-2xl px-4 py-3",
                      fromRequester ? "bg-secondary" : "bg-muted",
                    )}
                  >
                    <Markdown text={part.text} untrusted />
                  </div>
                </li>,
              ];
            }
            if (part.type === "tool-call") {
              return [
                <li
                  key={key}
                  className="flex items-center gap-1.5 px-1 text-muted-foreground text-xs"
                >
                  <Wrench className="size-3.5" />
                  {t("usedTool", { tool: part.name })}
                </li>,
              ];
            }
            return [];
          }),
        )}
      </ol>
    </>
  );
}
