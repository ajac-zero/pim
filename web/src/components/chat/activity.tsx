import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  usePendingApprovals,
  useSummaryOpen,
} from "~/components/chat/activity-toggle";
import { BrowserView } from "~/components/chat/browser-view";
import { ApprovalBlock } from "~/components/chat/items";
import { Markdown } from "~/components/chat/markdown";
import { TaskList } from "~/components/chat/tasks";
import { useI18n } from "~/components/i18n";
import { AlertCircle, ChevronRight, Loader2 } from "~/components/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { pim } from "~/lib/pim-api";
import { browserQuery } from "~/lib/queries";

/** How often the open box looks at the agents' browser again. */
const BROWSER_REFRESH_MS = 4_000;

/**
 * A box beside a chat (above it on phones) with a quick summary of it and
 * its next steps, from the utility model; below it, the tasks the chat led
 * to, if any, and while it's open, the browser the person's agents share. The thread makes room for it. Approvals the chat
 * is waiting on come first, and open the box even when it's closed. Nothing is
 * written until the summary dropdown is open. While open, it asks again only
 * when the chat has settled with new entries (`entries`),
 * and Pim writes a new summary only if something more was said.
 */
export function ActivityBox({
  sessionId,
  entries,
  settled,
  visit,
}: {
  sessionId: string;
  entries: number;
  settled: boolean;
  /** A conversation with someone else's space, whose tasks aren't yours to see. */
  visit: boolean;
}) {
  const { t } = useI18n();
  const [open] = useSummaryOpen();
  const approvals = usePendingApprovals(sessionId);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summary = useQuery({
    queryKey: ["summary", sessionId, entries],
    queryFn: () => pim.summary(sessionId),
    enabled: open && summaryOpen && settled && entries > 0,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    retry: false,
  });
  // The same query as the chat's task cards, which keeps it up to date.
  const tasks = useQuery({
    queryKey: ["tasks", sessionId],
    queryFn: () => pim.tasks(sessionId),
    enabled: open && !visit,
  });
  const browser = useQuery({
    ...browserQuery(sessionId),
    enabled: open,
    refetchInterval: BROWSER_REFRESH_MS,
  });
  if (!open && approvals.length === 0) return null;
  const page = browser.data?.page;

  return (
    <aside className="order-first flex max-h-[45%] shrink-0 flex-col px-3 pt-3 pb-2 md:order-none md:absolute md:inset-y-0 md:right-(--scrollbar) md:max-h-none md:w-80 md:pb-3 md:pl-0">
      <div className="fade-in-0 min-h-0 animate-in overflow-y-auto rounded-[18px] border bg-muted/40 duration-150">
        {approvals.length > 0 && (
          <section className="space-y-2 border-b p-3">
            <h2 className="px-1 text-[13px] text-muted-foreground">
              {t("waitingForYou")}
            </h2>
            {approvals.map((approval) => (
              <ApprovalBlock key={approval.id} approval={approval} />
            ))}
          </section>
        )}
        {open && (
          <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
            <h2>
              <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3.5 text-left text-[13px] text-muted-foreground hover:text-foreground">
                <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                {t("summary")}
                {summary.isFetching && summary.data !== undefined && (
                  <Loader2
                    className="size-3 animate-spin"
                    aria-label={t("summarizing")}
                  />
                )}
              </CollapsibleTrigger>
            </h2>
            <CollapsibleContent className="px-4 pb-4 text-sm">
              {entries === 0 || summary.data === null ? (
                <p className="text-muted-foreground">
                  {t("nothingToSummarize")}
                </p>
              ) : summary.data !== undefined ? (
                <Markdown
                  text={summary.data}
                  untrusted
                  className="text-sm leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm"
                />
              ) : summary.error ? (
                <p className="flex items-start gap-2 text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  {summary.error.message}
                </p>
              ) : (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("summarizing")}
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
        {open && tasks.data && tasks.data.length > 0 && (
          <TaskList sessionId={sessionId} tasks={tasks.data} />
        )}
        {open && page && (
          <BrowserView
            sessionId={sessionId}
            page={page}
            updatedAt={browser.dataUpdatedAt}
          />
        )}
      </div>
    </aside>
  );
}
