import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import {
  ArrowDownIcon,
  Check,
  ChevronRight,
  CornerDownRight,
  Loader2,
  ShieldAlert,
  Workflow,
  Wrench,
  X,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { type AgentTask, pim, type StartedBy } from "~/lib/pim-api";
import { sessionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** How often a chat with tasks at work looks again, besides the server's `tasks` message. */
export const TASK_POLL_MS = 5_000;

const OPEN_STATES = new Set<AgentTask["state"]>(["working", "auth-required"]);

/** A task with its depth in the tree, in the order to show: each under the task it was handed out for. */
type Row = { task: AgentTask; depth: number };

/** The tasks handed out for each task, in order; those whose parent isn't listed are under null, at the top. */
function childrenOf(tasks: readonly AgentTask[]) {
  const ids = new Set(tasks.map((task) => task.id));
  const children = new Map<string | null, AgentTask[]>();
  for (const task of tasks) {
    const parent =
      task.parent !== null && ids.has(task.parent) ? task.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  return children;
}

/** The tasks as a tree, flattened depth first; tasks whose parent isn't listed sit at the top. */
export function taskRows(tasks: readonly AgentTask[]): Row[] {
  const children = childrenOf(tasks);
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

/**
 * A handoff stays where it happened, as a compact line like the notice its
 * answers come in: the agents it went to, with how many of its tasks are
 * done. It opens to each task's current state, its chat, and a link to its
 * later answer.
 */
export function TaskCard({
  id,
  sessionId,
  tasks,
  completions,
}: {
  /** The anchor the notices of its answers jump back to. */
  id: string;
  sessionId: string;
  tasks: readonly AgentTask[];
  completions: ReadonlyMap<string, string>;
}) {
  const { t, locale, formatDate } = useI18n();
  const [open, setOpen] = useState(false);
  const agents = [...new Set(tasks.map((task) => task.agent.name))];
  const done = tasks.filter((task) => !OPEN_STATES.has(task.state)).length;
  // The line's mark says how the work as a whole is going.
  const state: AgentTask["state"] = tasks.some(
    (task) => task.state === "working",
  )
    ? "working"
    : tasks.some((task) => task.state === "auth-required")
      ? "auth-required"
      : "completed";
  return (
    <section
      id={id}
      tabIndex={-1}
      aria-label={t("tasks")}
      className="flex w-full flex-col items-center rounded-xl outline-none"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1.5 px-3 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {state === "completed" ? (
          <Workflow className="size-3.5 shrink-0" />
        ) : (
          <TaskState state={state} />
        )}
        <span className="truncate">
          {t(tasks.length === 1 ? "handedOutOneTo" : "handedOutTo", {
            agents: new Intl.ListFormat(locale, { type: "conjunction" }).format(
              agents,
            ),
          })}
        </span>
        <span className="shrink-0 tabular-nums">
          {done}/{tasks.length}
        </span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <ul className="mt-2 w-full space-y-px rounded-xl border bg-muted/50 p-1.5">
          {taskRows(tasks).map(({ task, depth }) => {
            const completion = completions.get(task.id);
            const delegatedAt = new Date(task.createdAt);
            return (
              <li
                key={task.id}
                style={{ marginLeft: `${depth * 1.25}rem` }}
                className="flex items-center gap-1"
              >
                <TaskLink
                  sessionId={sessionId}
                  task={task}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <TaskState state={task.state} />
                  <span className="shrink-0 font-medium">
                    {task.agent.name}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-muted-foreground"
                    title={task.task}
                  >
                    {task.task}
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
                </TaskLink>
                {completion && (
                  <span className="shrink-0 px-1 text-xs">
                    <TaskJump target={`task-update-${completion}`}>
                      <span className="sr-only">{t("jumpToCompletion")}</span>
                      <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                    </TaskJump>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * A chat's tasks in the box beside it, as a tree, so the work it handed out
 * can be followed without scrolling back to each card; a task opens in
 * the canvas beside the chat, as from its card.
 */
export function TaskList({
  sessionId,
  tasks,
}: {
  sessionId: string;
  tasks: readonly AgentTask[];
}) {
  const { t, formatDate } = useI18n();
  const working = tasks.filter((task) => task.state === "working").length;
  const waiting = tasks.filter((task) => task.state === "auth-required").length;
  const children = childrenOf(tasks);
  // Each task's children hang from a line down from its mark, with an elbow to each child's.
  const branch = (parent: string | null): ReactNode =>
    children.get(parent)?.map((task) => (
      <li
        key={task.id}
        className={cn(
          parent !== null &&
            "relative pl-1.5 before:absolute before:top-0 before:left-0 before:h-full before:border-border before:border-l after:absolute after:top-[18px] after:left-0 after:w-2.5 after:border-border after:border-t first:before:top-[-26px] first:before:h-[calc(100%+26px)] last:before:h-[18px] first:last:before:h-[44px]",
        )}
      >
        <TaskLink
          sessionId={sessionId}
          task={task}
          className="flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="flex h-5 shrink-0 items-center">
            <TaskState state={task.state} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-1 text-sm">
              <span className="max-w-full truncate font-medium">
                {task.agent.name}
              </span>
              <span className="text-muted-foreground">
                {t(activityKey[task.state])}
              </span>
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {task.task}
            </span>
          </span>
          <time
            className="shrink-0 pt-0.5 text-muted-foreground text-xs tabular-nums"
            dateTime={new Date(task.createdAt).toISOString()}
          >
            {formatDate(new Date(task.createdAt), { timeStyle: "short" })}
          </time>
        </TaskLink>
        {children.has(task.id) && (
          <ul className="ml-[15px]">{branch(task.id)}</ul>
        )}
      </li>
    ));
  const counts = [
    working > 0 && t("tasksWorking", { count: working }),
    waiting > 0 && t("tasksWaiting", { count: waiting }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Collapsible defaultOpen asChild>
      <section aria-labelledby="task-list" className="border-t">
        <h2 id="task-list">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3.5 text-left text-[13px] text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
            {t("tasks")}
            {counts && <span className="ml-auto">{counts}</span>}
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent className="px-2 pb-2">
          <ul className="space-y-px">{branch(null)}</ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** Atop a chat another agent started for a task: who started it, from which chat, which it links back to. */
export function StartedFrom({ startedBy }: { startedBy: StartedBy }) {
  const { t } = useI18n();
  const { data: sessions } = useQuery(sessionsQuery());
  const from = sessions?.find((session) => session.id === startedBy.session);
  return (
    <p className="flex max-w-full items-center justify-center gap-1.5 px-3 text-[13px] text-muted-foreground">
      <CornerDownRight className="size-3.5 shrink-0" />
      {from ? (
        <>
          <span className="shrink-0">
            {t("startedFrom", { agent: startedBy.agent.name })}
          </span>
          <Link
            to="/chat/$sessionId"
            params={{ sessionId: from.id }}
            className="truncate text-foreground hover:underline"
          >
            {from.title ?? t("newChat")}
          </Link>
        </>
      ) : (
        // The chat it was started from is gone.
        <span className="truncate">
          {t("startedBy", { agent: startedBy.agent.name })}
        </span>
      )}
    </p>
  );
}

/** Atop a chat that carries on one that grew too long: a link back to it. */
export function ContinuedFrom({ session }: { session: string }) {
  const { t } = useI18n();
  const { data: sessions } = useQuery(sessionsQuery());
  const from = sessions?.find((candidate) => candidate.id === session);
  if (!from) return null;
  return (
    <p className="flex max-w-full items-center justify-center gap-1.5 px-3 text-[13px] text-muted-foreground">
      <CornerDownRight className="size-3.5 shrink-0" />
      <span className="shrink-0">{t("continuedFrom")}</span>
      <Link
        to="/chat/$sessionId"
        params={{ sessionId: from.id }}
        className="truncate text-foreground hover:underline"
      >
        {from.title ?? t("newChat")}
      </Link>
    </p>
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

/**
 * Opens the chat a task runs in, like any chat; a task from before tasks
 * were chats opens read-only in the canvas beside its chat (`?task=`),
 * marked while it is open there.
 */
function TaskLink({
  sessionId,
  task,
  className,
  children,
}: {
  sessionId: string;
  task: AgentTask;
  className: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const open = useSearch({
    strict: false,
    select: (search: { task?: string }) => search.task === task.id,
  });
  if (task.session !== null) {
    return (
      <Link
        to="/chat/$sessionId"
        params={{ sessionId: task.session }}
        aria-label={t("openTaskChat", { agent: task.agent.name })}
        title={task.task}
        className={className}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link
      to="/chat/$sessionId"
      params={{ sessionId }}
      search={{ task: task.id }}
      aria-current={open || undefined}
      aria-label={t("viewTaskBy", { agent: task.agent.name })}
      title={task.task}
      className={cn(
        className,
        open && "bg-background/70 hover:bg-background/70",
      )}
    >
      {children}
    </Link>
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

/**
 * A task in the canvas beside the chat it works for: what it was asked and
 * what its agent did, read-only, and Cancel while it isn't done.
 */
export function TaskView({
  sessionId,
  taskId,
  onClose,
}: {
  sessionId: string;
  taskId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: task, error } = useQuery({
    queryKey: ["tasks", sessionId, taskId],
    queryFn: () => pim.task(sessionId, taskId),
    refetchInterval: (query) =>
      query.state.data && OPEN_STATES.has(query.state.data.state)
        ? TASK_POLL_MS
        : false,
  });
  const cancel = useMutation({
    mutationFn: () => pim.cancelTask(sessionId, taskId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["tasks", sessionId] }),
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-13 shrink-0 items-center gap-2 border-b px-4">
        {task && <TaskState state={task.state} />}
        <h1 className="flex min-w-0 flex-1 items-baseline gap-2 font-semibold">
          <span className="truncate">{task?.agent.name}</span>
          {task && (
            <span className="shrink-0 font-normal text-[13px] text-muted-foreground">
              {t(stateKey[task.state])}
            </span>
          )}
        </h1>
        {task && OPEN_STATES.has(task.state) && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={cancel.isPending}
            onClick={() => {
              if (window.confirm(t("cancelTaskConfirm"))) cancel.mutate();
            }}
          >
            {t("cancelTask")}
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          aria-label={t("close")}
          title={t("close")}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      {error ? (
        <p className="p-4 text-muted-foreground text-sm">{t("taskNotFound")}</p>
      ) : task ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-6 text-sm">
          <p className="mb-4 text-muted-foreground">
            {t("taskReadOnly", {
              agent: task.agent.name,
              from: task.from.name,
            })}
          </p>
          <ol className="space-y-3">
            {task.messages.flatMap((message) =>
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
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
