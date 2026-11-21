import type { Activity } from "@pim/shared/activity-types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { call } from "~/lib/pim-api";
import { cn } from "~/lib/utils";
import { useI18n } from "./i18n";
import { ChevronRight } from "./icons";

/** Server-side, redacted activity shared with pim_diagnostics. The browser only advances the clock. */
export function RunActivity({
  activity,
  timeline = true,
}: {
  activity?: Activity;
  timeline?: boolean;
}) {
  const { t, formatDate } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!activity?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity?.running]);
  if (!activity) return null;
  const seconds = (ms: number) => `${Math.floor(Math.max(0, ms) / 1000)} s`;
  return (
    <div className="min-w-0 space-y-1 text-[13px] text-muted-foreground">
      <div role="status" className="flex flex-wrap items-center gap-2">
        {activity.stalls.length > 0 && (
          <span
            className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive"
            title={activity.stalls.map((stall) => stall.reason).join("; ")}
          >
            {t("activityStalled")}
          </span>
        )}
        {activity.running && activity.current.length === 0 && (
          <span>{t("activityWorking")}</span>
        )}
        {activity.current.map((tool) => (
          <span
            key={tool.id ?? `${tool.startedAt}:${tool.name}`}
            className="min-w-0 break-words"
          >
            {t("activityNow")}:{" "}
            <span className="font-mono">
              {tool.name} {tool.summary}
            </span>
            {" · "}
            {seconds(now - tool.startedAt)}
          </span>
        ))}
        {activity.lastActivityAt > 0 && (
          <span>
            {t("activityLast")}:{" "}
            <time dateTime={new Date(activity.lastActivityAt).toISOString()}>
              {formatDate(new Date(activity.lastActivityAt), {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
          </span>
        )}
      </div>
      {timeline && activity.steps.length > 0 && (
        <details>
          <summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t("activityTimeline")}
          </summary>
          <ol className="max-h-64 space-y-1 overflow-auto py-2">
            {activity.steps.map((step) => (
              <li
                key={step.kind === "tool" ? step.id : `model:${step.at}`}
                className="break-words"
              >
                <span className="font-mono">
                  {step.kind === "tool"
                    ? `${step.name} ${step.summary}`
                    : step.model}
                </span>
                {" · "}
                {step.ms === null
                  ? activity.running
                    ? seconds(now - step.at)
                    : "—"
                  : seconds(step.ms)}
                {step.kind === "tool" &&
                  step.exitCode !== null &&
                  ` · ${t("activityExit")} ${step.exitCode}`}
                {step.kind === "tool" &&
                  step.outputBytes !== null &&
                  ` · ${step.outputBytes} B`}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/**
 * The same record laid out for a narrow box: a status line, what runs now with
 * its elapsed time at the right edge, when the last thing happened, and the steps
 * as rows of a name and a duration.
 */
function ActivityPanel({ activity }: { activity?: Activity }) {
  const { t, formatDate } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!activity?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity?.running]);
  if (!activity) return null;
  const seconds = (ms: number) => `${Math.floor(Math.max(0, ms) / 1000)} s`;
  const stalled = activity.stalls.length > 0;
  const row = "flex min-w-0 items-baseline gap-3";
  const time = "ml-auto shrink-0 tabular-nums text-muted-foreground";
  return (
    <div className="min-w-0 space-y-3 text-[13px]">
      <div role="status" className="space-y-2">
        {(activity.running || stalled) && (
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                stalled
                  ? "bg-destructive"
                  : "animate-pulse bg-primary motion-reduce:animate-none",
              )}
            />
            <span
              className={stalled ? "text-destructive" : "text-foreground"}
              title={activity.stalls.map((stall) => stall.reason).join("; ")}
            >
              {stalled ? t("activityStalled") : t("activityWorking")}
            </span>
          </div>
        )}
        {activity.current.map((tool) => (
          <div
            key={tool.id ?? `${tool.startedAt}:${tool.name}`}
            className={row}
          >
            <span className="min-w-0 break-words font-mono">
              {tool.name} {tool.summary}
            </span>
            <span className={time}>{seconds(now - tool.startedAt)}</span>
          </div>
        ))}
        {activity.lastActivityAt > 0 && (
          <div className={`${row} text-muted-foreground`}>
            {t("activityLast")}
            <time
              className="ml-auto tabular-nums"
              dateTime={new Date(activity.lastActivityAt).toISOString()}
            >
              {formatDate(new Date(activity.lastActivityAt), {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
          </div>
        )}
      </div>
      {activity.steps.length > 0 && (
        <details className="group border-t pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            {t("activityTimeline")}
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          </summary>
          <ol className="mt-2 max-h-64 space-y-1.5 overflow-auto">
            {activity.steps.map((step) => (
              <li
                key={step.kind === "tool" ? step.id : `model:${step.at}`}
                className={row}
              >
                <span className="min-w-0 break-words font-mono">
                  {step.kind === "tool"
                    ? `${step.name} ${step.summary}`
                    : step.model}
                </span>
                <span className={time}>
                  {step.kind === "tool" &&
                    step.exitCode !== null &&
                    step.exitCode !== 0 && (
                      <span className="mr-2 text-destructive">
                        {t("activityExit")} {step.exitCode}
                      </span>
                    )}
                  {step.ms === null
                    ? activity.running
                      ? seconds(now - step.at)
                      : "—"
                    : seconds(step.ms)}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** An open chat refreshes even while a tool is silent; no transcript event is needed to expose a stall. */
export function ChatRunActivity({ chat }: { chat: string }) {
  const { data } = useQuery({
    queryKey: ["run-activity", chat],
    queryFn: () =>
      call<Activity>(`/sessions/${encodeURIComponent(chat)}/activity`),
    refetchInterval: 4000,
  });
  return <ActivityPanel activity={data} />;
}
