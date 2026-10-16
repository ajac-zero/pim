import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertCircle, ListChecks, Loader2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { pim } from "~/lib/pim-api";
import { cn } from "~/lib/utils";

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

/** The header button that shows or hides the summary box. */
export function SummaryToggle({ className }: { className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useSummaryOpen();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("summary")}
      title={t("summary")}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className={cn(
        "rounded-full",
        open && "bg-accent text-foreground",
        className,
      )}
    >
      <ListChecks className="size-4.5" />
    </Button>
  );
}

/**
 * A box beside a chat (above it on phones) with a quick summary of it and
 * its next steps, from the utility model. The thread makes room for it. Nothing is written while it is closed. Open,
 * it asks again only when the chat has settled with new entries (`entries`),
 * and Pim writes a new summary only if something more was said.
 */
export function SummaryBox({
  sessionId,
  entries,
  settled,
}: {
  sessionId: string;
  entries: number;
  settled: boolean;
}) {
  const { t } = useI18n();
  const [open] = useSummaryOpen();
  const summary = useQuery({
    queryKey: ["summary", sessionId, entries],
    queryFn: () => pim.summary(sessionId),
    enabled: open && settled && entries > 0,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (!open) return null;

  return (
    <aside
      aria-label={t("summary")}
      className="order-first flex max-h-[45%] shrink-0 flex-col px-3 pt-3 pb-2 md:order-none md:max-h-none md:w-80 md:pb-3 md:pl-0"
    >
      <div className="fade-in-0 flex min-h-0 animate-in flex-col overflow-hidden rounded-[18px] border bg-muted/40 duration-150">
        <h2 className="flex items-center gap-2 px-4 pt-3.5 pb-1 text-[13px] text-muted-foreground">
          {t("summary")}
          {summary.isFetching && summary.data !== undefined && (
            <Loader2
              className="size-3 animate-spin"
              aria-label={t("summarizing")}
            />
          )}
        </h2>
        <div className="min-h-0 overflow-y-auto px-4 pb-4 text-sm">
          {entries === 0 || summary.data === null ? (
            <p className="text-muted-foreground">{t("nothingToSummarize")}</p>
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
        </div>
      </div>
    </aside>
  );
}
