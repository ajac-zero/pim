import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { memo, useMemo, useState } from "react";
import {
  ReasoningBlock,
  ToolCallBlock,
  UnknownItemBlock,
} from "~/components/chat/items";
import { Markdown } from "~/components/chat/markdown";
import { type TranslationKey, useI18n } from "~/components/i18n";
import { useShowReasoning } from "~/components/reasoning-preference";
import {
  type FunctionCallItem,
  type FunctionCallOutputItem,
  type MessageItem,
  messageText,
  type ReasoningItem,
} from "~/lib/openresponses";
import type { ConnectedApp } from "~/lib/pim-api";
import type { RunningTool, ThreadEntry } from "~/lib/pim-view";
import { appsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** What each of Pim's own tools is doing, in a word or three. */
const TOOL_STEPS: Record<string, TranslationKey> = {
  web_search: "stepSearchingWeb",
  fetch_url: "stepReadingWeb",
  note: "stepRemembering",
  recall: "stepRecalling",
  zoom: "stepRecalling",
  forget: "stepForgetting",
  create_goal: "stepPlanning",
  update_goal: "stepPlanning",
  list_goals: "stepPlanning",
  schedule_task: "stepScheduling",
  list_scheduled_tasks: "stepScheduling",
  cancel_scheduled_task: "stepScheduling",
  current_time: "stepCheckingTime",
  artifact_create: "stepWriting",
  artifact_update: "stepWriting",
  artifact_read: "stepReadingArtifacts",
  artifact_list: "stepReadingArtifacts",
  http_request: "stepRequest",
  find_app: "stepApps",
  connect_app: "stepApps",
  list_apps: "stepApps",
  read_skill: "stepInstructions",
  read_skill_file: "stepInstructions",
  list_app_events: "stepEvents",
  watch_app_event: "stepEvents",
  list_watches: "stepEvents",
  stop_watch: "stepEvents",
};

type Translate = ReturnType<typeof useI18n>["t"];

/** One step of Pim's work, as a short label. App tools are named `<app id>_<tool>`. */
function stepLabel(
  entry: ThreadEntry,
  t: Translate,
  apps: readonly ConnectedApp[],
  visit: string | undefined,
): string {
  if (entry.kind !== "item" || entry.item.type !== "function_call") {
    return t("stepThinking");
  }
  const { name } = entry.item as FunctionCallItem;
  const own = TOOL_STEPS[name];
  if (own) return t(own);
  // In a visit, the other tools are the host's, asked through their Pim.
  if (visit) return t("stepAskingPim", { username: visit });
  const app = apps.find((candidate) => name.startsWith(`${candidate.id}_`));
  return app ? t("stepUsingApp", { app: app.name }) : t("stepWorking");
}

const MAX_LABELS = 3;

/**
 * Pim's work between the messages it sends: thinking, its notes and tool
 * calls, folded into one line that says what it is doing or did. Opening it
 * shows each step in full; "Show Pim's work" opens them all by default.
 */
export const ActivityGroup = memo(function ActivityGroup({
  entries,
  outputs,
  runningTools,
  live,
  liveKeys,
  visit,
}: {
  entries: readonly ThreadEntry[];
  outputs: ReadonlyMap<string, FunctionCallOutputItem>;
  runningTools: ReadonlyMap<string, RunningTool>;
  /** Pim is working on it right now. */
  live: boolean;
  /** Entries still streaming. */
  liveKeys: ReadonlySet<string>;
  visit?: string;
}) {
  const { t } = useI18n();
  const { showReasoning } = useShowReasoning();
  const [open, setOpen] = useState(showReasoning);
  const { data: apps = [] } = useQuery({ ...appsQuery(), enabled: !visit });

  const labels = useMemo(
    () => entries.map((entry) => stepLabel(entry, t, apps, visit)),
    [entries, t, apps, visit],
  );
  const summary = useMemo(() => {
    if (live) return labels.at(-1) ?? t("stepThinking");
    // What it did, each kind of step once; thinking only if it did nothing else.
    const thinking = t("stepThinking");
    const distinct = [...new Set(labels)];
    const done =
      distinct.length > 1
        ? distinct.filter((label) => label !== thinking)
        : distinct;
    const shown = done.slice(0, MAX_LABELS).join(" · ");
    return done.length > MAX_LABELS
      ? `${shown} ${t("stepsMore", { count: done.length - MAX_LABELS })}`
      : shown;
  }, [labels, live, t]);

  // Notes alone, after the work is done (what Pim tells itself once it has sent its message), are not worth a line.
  const notesOnly = entries.every(
    (entry) => entry.kind === "item" && entry.item.type === "message",
  );
  if (notesOnly && !live && !showReasoning) return null;

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group inline-flex max-w-full items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
      >
        {live ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Sparkles className="size-3.5 shrink-0" />
        )}
        <span className={cn("truncate", live && "animate-pulse")}>
          {summary}
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="mt-2 space-y-3 border-l pl-4">
          {entries.map((entry) => {
            if (entry.kind !== "item") return null;
            const { item } = entry;
            const streaming = liveKeys.has(entry.key);
            if (item.type === "reasoning") {
              return (
                <ReasoningBlock
                  key={entry.key}
                  item={item as ReasoningItem}
                  streaming={streaming}
                />
              );
            }
            if (item.type === "message") {
              // Notes Pim wrote for itself, shown quieter than what it sends.
              return (
                <div
                  key={entry.key}
                  className="text-muted-foreground text-sm [&_p]:my-1"
                >
                  <Markdown
                    text={messageText(item as MessageItem)}
                    streaming={streaming}
                  />
                </div>
              );
            }
            if (item.type === "function_call") {
              const call = item as FunctionCallItem;
              const running = runningTools.get(call.call_id);
              return (
                <ToolCallBlock
                  key={entry.key}
                  call={call}
                  output={outputs.get(call.call_id) ?? null}
                  running={running !== undefined}
                  liveOutput={running?.output}
                />
              );
            }
            return <UnknownItemBlock key={entry.key} item={item} />;
          })}
        </div>
      )}
    </div>
  );
});
