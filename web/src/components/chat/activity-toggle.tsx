import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useI18n } from "~/components/i18n";
import { ListChecks } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { pim } from "~/lib/pim-api";
import { approvalsQuery, browserQuery, sessionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** Whether the activity box is open: one setting for every chat, kept across visits. */
const OPEN_KEY = "pim-summary-open";
const listeners = new Set<() => void>();

function writeSummaryOpen(next: boolean) {
  if (next) localStorage.setItem(OPEN_KEY, "1");
  else localStorage.removeItem(OPEN_KEY);
  for (const listener of listeners) listener();
}

export function useSummaryOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => localStorage.getItem(OPEN_KEY) === "1",
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
 * The header button that shows or hides the activity box; a dot says the chat's
 * browser window is open in it, or an approval waits. The box opens by itself
 * when the browser opens or a task starts while the person is in the chat, not
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
  const { data: sessions } = useQuery(sessionsQuery());
  const visit = !!sessions?.find((session) => session.id === sessionId)?.visit;
  const { data: tasks } = useQuery({
    queryKey: ["tasks", sessionId],
    queryFn: () => pim.tasks(sessionId),
    enabled: !visit,
  });
  const waiting = usePendingApprovals(sessionId).length > 0;
  // What the chat had when its data first arrived; only a change from it opens the box.
  const seen = useRef<{ session: string; browser: boolean; tasks: number }>(
    undefined,
  );
  const hasBrowser = !!browser?.page;
  const taskCount = tasks?.length;
  const loaded = browser !== undefined && (visit || taskCount !== undefined);
  useEffect(() => {
    if (!loaded) return;
    const now = {
      session: sessionId,
      browser: hasBrowser,
      tasks: taskCount ?? 0,
    };
    const before = seen.current;
    seen.current = now;
    if (before?.session !== sessionId) return;
    if ((now.browser && !before.browser) || now.tasks > before.tasks)
      writeSummaryOpen(true);
  }, [loaded, sessionId, hasBrowser, taskCount]);
  const label = t("activity");
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
