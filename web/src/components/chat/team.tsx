import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Users, Wrench, X } from "lucide-react";
import { useState } from "react";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { pim, type TeamRun } from "~/lib/pim-api";
import { cn } from "~/lib/utils";

const POLL_MS = 2_000;

/**
 * What the chat's agent handed its team: the members of its latest handoff,
 * and any still working, each with its status. A member opens read-only:
 * it answers the agent, not you.
 */
export function TeamPanel({
  sessionId,
  agentName,
  running,
}: {
  sessionId: string;
  agentName: string;
  /** The agent is at work: its team may be too. */
  running: boolean;
}) {
  const { t } = useI18n();
  const { data: runs = [] } = useQuery({
    queryKey: ["team", sessionId],
    queryFn: () => pim.teamRuns(sessionId),
    refetchInterval: (query) =>
      running || query.state.data?.some((run) => run.status === "running")
        ? POLL_MS
        : false,
  });
  const [open, setOpen] = useState<TeamRun | null>(null);
  const latest = runs[0]?.call;
  const shown = runs
    .filter((run) => run.call === latest || run.status === "running")
    .reverse();
  if (shown.length === 0) return null;
  return (
    <>
      <div
        className="mb-2 flex flex-wrap items-center gap-1.5 text-xs"
        role="group"
        aria-label={t("teamOf", { name: agentName })}
      >
        <span className="flex items-center gap-1 pr-1 text-muted-foreground">
          <Users className="size-3.5" />
          {t("teamOf", { name: agentName })}
        </span>
        {shown.map((run) => (
          <button
            key={run.conversation}
            type="button"
            onClick={() => setOpen(run)}
            title={run.task}
            className="flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 transition-colors hover:bg-accent"
          >
            <RunStatus status={run.status} />
            <span className="font-medium">{run.member}</span>
            <span className="text-muted-foreground">
              {t(statusKey[run.status])}
            </span>
          </button>
        ))}
      </div>
      <Sheet
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
      >
        <SheetContent className="w-full sm:max-w-lg">
          {open && (
            <MemberTranscript
              sessionId={sessionId}
              run={open}
              agentName={agentName}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

const statusKey = {
  running: "teamRunning",
  done: "teamDone",
  failed: "teamFailed",
} as const;

function RunStatus({ status }: { status: TeamRun["status"] }) {
  if (status === "running") {
    return <Loader2 className="size-3.5 animate-spin text-primary" />;
  }
  if (status === "done") {
    return <Check className="size-3.5 text-success" />;
  }
  return <X className="size-3.5 text-destructive" />;
}

/** A member's conversation: the task it was given, and what it did. */
function MemberTranscript({
  sessionId,
  run,
  agentName,
}: {
  sessionId: string;
  run: TeamRun;
  agentName: string;
}) {
  const { t } = useI18n();
  const { data } = useQuery({
    queryKey: ["team", sessionId, run.conversation],
    queryFn: () => pim.teamRun(sessionId, run.conversation),
    refetchInterval: (query) =>
      (query.state.data?.status ?? run.status) === "running" ? POLL_MS : false,
  });
  const status = data?.status ?? run.status;
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <RunStatus status={status} />
          {run.member}
        </SheetTitle>
        <SheetDescription>
          {t("teamReadOnly", { member: run.member, agent: agentName })}
        </SheetDescription>
      </SheetHeader>
      <ol className="flex-1 space-y-3 overflow-y-auto px-4 pb-6 text-sm">
        {(data?.messages ?? []).flatMap((message) =>
          message.parts.flatMap((part, index) => {
            const key = `${message.id}:${index}`;
            if (part.type === "text" && part.text.trim() !== "") {
              return [
                <li
                  key={key}
                  className={cn(
                    "rounded-2xl px-4 py-3",
                    message.role === "user"
                      ? "ml-8 bg-primary text-primary-foreground"
                      : "mr-8 bg-muted",
                  )}
                >
                  <Markdown text={part.text} untrusted />
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
