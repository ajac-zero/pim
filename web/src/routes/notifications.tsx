import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { EmptyState, Page, SessionLink } from "~/components/page";
import { Button } from "~/components/ui/button";
import { type PimNotification, pim } from "~/lib/pim-api";
import { notificationsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/notifications")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(notificationsQuery()),
  component: NotificationsPage,
});

function NotificationsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: notifications = [] } = useQuery(notificationsQuery());
  const unread = notifications.filter((n) => n.readAt === null);

  const markAll = useMutation({
    mutationFn: () => Promise.all(unread.map((n) => pim.markRead(n.id))),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (error) => toast.error(error.message),
  });

  return (
    <Page
      title={t("notifications")}
      description={t("notificationsDescription")}
    >
      {unread.length > 0 && (
        <div className="-mt-4 mb-4 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
          >
            {t("markAllRead")}
          </Button>
        </div>
      )}
      {notifications.length === 0 ? (
        <EmptyState
          icon={<Bell className="size-5" />}
          text={t("noNotifications")}
        />
      ) : (
        <ul className="divide-y rounded-xl border">
          {notifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
            />
          ))}
        </ul>
      )}
    </Page>
  );
}

function NotificationRow({ notification }: { notification: PimNotification }) {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const unread = notification.readAt === null;
  const markRead = useMutation({
    mutationFn: () => pim.markRead(notification.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (error) => toast.error(error.message),
  });

  return (
    <li className={cn("flex gap-3 p-4", unread && "bg-accent/40")}>
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          unread ? "bg-primary" : "bg-transparent",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className={cn("text-sm", unread && "font-medium")}>
            {notification.title}
          </p>
          <time className="shrink-0 text-muted-foreground text-xs">
            {formatDate(new Date(notification.createdAt), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
        </div>
        {notification.body && (
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground text-sm">
            {notification.body}
          </p>
        )}
        <div className="mt-2 flex items-center gap-3 text-muted-foreground text-xs">
          {notification.session && (
            <SessionLink session={notification.session} />
          )}
          {unread && (
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() => markRead.mutate()}
              disabled={markRead.isPending}
            >
              {t("markRead")}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
