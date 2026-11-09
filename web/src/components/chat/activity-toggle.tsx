import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useI18n } from "~/components/i18n";
import { SlidersHorizontal } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { approvalsQuery, browserQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** Whether the options box is open: one setting for every chat, but always closed when a chat opens, and not kept across visits. */
let summaryOpen = false;
const listeners = new Set<() => void>();

export function writeSummaryOpen(next: boolean) {
  summaryOpen = next;
  for (const listener of listeners) listener();
}

export function useSummaryOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => summaryOpen,
    () => false,
  );
  return [open, writeSummaryOpen];
}

/** The approvals this chat is waiting on, oldest first: its own agent's, and its team members'. Requests from circles are answered in Sharing. */
export function usePendingApprovals(sessionId: string) {
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

/**
 * The header button that shows or hides the chat's options box; a dot says the chat's
 * browser window is open in it, or an approval waits. The box opens by itself
 * when the browser opens while the person is in the chat, not
 * for ones the chat already had.
 */
export function ActivityToggle({
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
  // What the chat had when its data first arrived; only a change from it opens the box.
  const seen = useRef<{ session: string; browser: boolean }>(undefined);
  const hasBrowser = !!browser?.page;
  const loaded = browser !== undefined;
  useEffect(() => {
    if (!loaded) return;
    const now = { session: sessionId, browser: hasBrowser };
    const before = seen.current;
    seen.current = now;
    if (before?.session !== sessionId) return;
    if (now.browser && !before.browser) writeSummaryOpen(true);
  }, [loaded, sessionId, hasBrowser]);
  const label = t("options");
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-expanded={open}
      data-activity-toggle
      onClick={() => setOpen(!open)}
      className={cn(
        "relative rounded-full",
        open && "bg-accent text-foreground",
        className,
      )}
    >
      <SlidersHorizontal className="size-4.5" />
      {(browser?.page || waiting) && (
        <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary" />
      )}
    </Button>
  );
}
