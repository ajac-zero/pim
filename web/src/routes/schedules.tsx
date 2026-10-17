import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarClock, Repeat } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { sessionTitle } from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { EmptyState, Page } from "~/components/page";
import { type PimSchedule, pim, type Session } from "~/lib/pim-api";
import { schedulesQuery, sessionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/schedules")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(schedulesQuery()),
  component: SchedulesPage,
});

function SchedulesPage() {
  const { t } = useI18n();
  const { data: schedules = [] } = useQuery(schedulesQuery());
  const { data: sessions } = useQuery(sessionsQuery());
  const soonestFirst = [...schedules].sort(
    (a, b) => Date.parse(a.next) - Date.parse(b.next),
  );

  return (
    <Page title={t("schedules")} description={t("schedulesDescription")}>
      {soonestFirst.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="size-5" />}
          text={t("noSchedules")}
        />
      ) : (
        <ul className="divide-y">
          {soonestFirst.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              session={sessions?.find((s) => s.id === schedule.session)}
            />
          ))}
        </ul>
      )}
    </Page>
  );
}

function ScheduleRow({
  schedule,
  session,
}: {
  schedule: PimSchedule;
  session?: Session;
}) {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const repeats = schedule.type === "cron" || schedule.type === "interval";
  const Icon = repeats ? Repeat : CalendarClock;
  // Cancelling asks twice: the first click turns the button into a confirmation.
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => pim.cancelSchedule(schedule.id),
    onSuccess: () => {
      toast.success(t("scheduleCancelled"));
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <li className="flex gap-3 p-4">
      <Icon className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 truncate text-sm">
            {schedule.label ?? schedule.instruction}
          </p>
          <time
            dateTime={schedule.next}
            className="shrink-0 text-muted-foreground text-xs"
          >
            {t("scheduleNext", {
              date: formatDate(new Date(schedule.next), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })}
          </time>
        </div>
        {schedule.label && (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-muted-foreground text-sm">
            {schedule.instruction}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
          <span>
            {repeats ? t("scheduleRepeats") : t("scheduleOnce")}
            {schedule.cron && (
              <>
                {" · "}
                <code className="font-mono">{schedule.cron}</code> UTC
              </>
            )}
          </span>
          <Link
            to="/chat/$sessionId"
            params={{ sessionId: schedule.session }}
            className="max-w-60 truncate underline-offset-2 hover:text-foreground hover:underline"
          >
            {session ? sessionTitle(session, t) : t("openChat")}
          </Link>
          <button
            type="button"
            className={cn(
              "hover:text-foreground",
              confirming && "text-destructive hover:text-destructive",
            )}
            onClick={() => (confirming ? cancel.mutate() : setConfirming(true))}
            onBlur={() => setConfirming(false)}
            disabled={cancel.isPending}
          >
            {confirming ? t("confirmCancelSchedule") : t("cancelSchedule")}
          </button>
        </div>
      </div>
    </li>
  );
}
