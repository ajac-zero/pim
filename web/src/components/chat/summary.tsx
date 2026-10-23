import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
import { BrowserView } from "~/components/chat/browser-view";
import { ApprovalBlock } from "~/components/chat/items";
import { Markdown } from "~/components/chat/markdown";
import { TaskList } from "~/components/chat/tasks";
import { useI18n } from "~/components/i18n";
import {
  AlertCircle,
  ChevronRight,
  ListChecks,
  Loader2,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { pim } from "~/lib/pim-api";
import { approvalsQuery, browserQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** How often the open box looks at the agents' browser again. */
const BROWSER_REFRESH_MS = 4_000;

/** Whether the summary box is open: one setting for every chat, kept across visits. */
const OPEN_KEY = "pim-summary-open";
const listeners = new Set<() => void>();

function useSummaryOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => localStorage.getItem(OPEN_KEY) === "1",
    () => false,
  );
  const setOpen = (next: boolean) => {
    if (next) localStorage.setItem(OPEN_KEY, "1");
    else localStorage.removeItem(OPEN_KEY);
    for (const listener of listeners) listener();
  };
  return [open, setOpen];
}

/** The approvals this chat is waiting on, oldest first: its own agent's, and its team members'. Requests from circles are answered in Sharing. */
function usePendingApprovals(sessionId: string) {
  const { data } = useQuery(approvalsQuery());
  return useMemo(
    () =>
      (data ?? [])
        .filter(
          (approval) =>
            approval.status === "pending" &&
            !approval.requestedBy &&
            (approval.member?.session ?? approval.session) === sessionId,
        )
        .sort((a, b) => a.createdAt - b.createdAt),
    [data, sessionId],
  );
}

/** The header button that shows or hides the summary box; a dot says the chat's browser window is open in it, or an approval waits. */
export function SummaryToggle({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useSummaryOpen();
  const { data: browser } = useQuery(browserQuery(sessionId));
  const waiting = usePendingApprovals(sessionId).length > 0;
  const label = browser?.page ? t("summaryAndBrowser") : t("summary");
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className={cn(
        "relative rounded-full",
        open && "bg-accent text-foreground",
        className,
      )}
    >
      <ListChecks className="size-4.5" />
      {(browser?.page || waiting) && (
        <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" />
      )}
    </Button>
  );
}

/**
 * A box beside a chat (above it on phones) with a quick summary of it and
 * its next steps, from the utility model; below it, the tasks the chat led
 * to, if any, and while it's open, the browser the person's agents share. The thread makes room for it. Approvals the chat
 * is waiting on come first, and open the box even when it's closed. Nothing is
 * written until the summary dropdown is open. While open, it asks again only
 * when the chat has settled with new entries (`entries`),
 * and Pim writes a new summary only if something more was said.
 */
export function SummaryBox({
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
    <aside className="order-first flex max-h-[45%] shrink-0 flex-col px-3 pt-3 pb-2 md:order-none md:max-h-none md:w-80 md:pb-3 md:pl-0">
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
            provider={browser.data?.provider}
          />
        )}
      </div>
    </aside>
  );
}
