import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import {
  Check,
  ChevronRight,
  Loader2,
  ShieldAlert,
  Workflow,
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
const POLL_MS = 5_000;

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

/**
 * The tasks the work begun in this chat led to, as a tree above the
 * composer: who does each, for whom, and how it is going. Open while any is
 * at work; a task opens read-only, where one not done can be canceled.
 */
export function TaskPanel({
  sessionId,
  running,
}: {
  sessionId: string;
  /** The chat's agent is at work: it may hand out tasks. */
  running: boolean;
}) {
  const { t } = useI18n();
  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks", sessionId],
    queryFn: () => pim.tasks(sessionId),
    refetchInterval: (query) =>
      running || query.state.data?.some((task) => task.state === "working")
        ? POLL_MS
        : false,
  });
  const rows = useMemo(() => taskRows(tasks), [tasks]);
  const open = tasks.filter((task) => OPEN_STATES.has(task.state)).length;
  // Expanded while work goes on, unless the person folded it; folded once it is all done, unless they opened it.
  const [shown, setShown] = useState<boolean | null>(null);
  const expanded = shown ?? open > 0;
  const [viewing, setViewing] = useState<string | null>(null);
  const viewed = tasks.find((task) => task.id === viewing);
  if (rows.length === 0) return null;
  return (
    <>
      <section
        className="mb-2 rounded-2xl bg-muted px-3 py-2"
        aria-label={t("tasks")}
      >
        <button
          type="button"
          onClick={() => setShown(!expanded)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Workflow className="size-3.5" />
          <span>{t("tasks")}</span>
          <span>·</span>
          <span>
            {open > 0
              ? t("tasksOpen", { count: open })
              : t("tasksDone", { count: rows.length })}
          </span>
          <ChevronRight
            className={cn(
              "ml-auto size-3.5 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
        {expanded && (
          <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto">
            {rows.map(({ task, depth }) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => setViewing(task.id)}
                  title={task.task}
                  style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
                  className="flex w-full items-center gap-2 rounded-xl py-1.5 pr-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  <TaskState state={task.state} />
                  <span className="shrink-0 font-medium">
                    {task.agent.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {task.task}
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {t(stateKey[task.state])}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Sheet
        open={viewing !== null}
        onOpenChange={(next) => !next && setViewing(null)}
      >
        <SheetContent className="w-full sm:max-w-lg">
          {viewed && <TaskTranscript sessionId={sessionId} task={viewed} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

const stateKey = {
  working: "taskWorking",
  "auth-required": "taskWaiting",
  completed: "taskDone",
  failed: "taskDidntFinish",
  canceled: "taskCanceled",
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
    refetchInterval: OPEN_STATES.has(task.state) ? POLL_MS : false,
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
