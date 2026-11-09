import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, type Ref, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { ApprovalBlock } from "~/components/chat/items";
import { useI18n } from "~/components/i18n";
import {
  AtSign,
  CalendarClock,
  CheckCheck,
  ScrollText,
} from "~/components/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { type PimNotification, pim } from "~/lib/pim-api";
import {
  approvalsQuery,
  builtinAppsQuery,
  notificationsQuery,
  skillsQuery,
} from "~/lib/queries";
import { cn } from "~/lib/utils";

/*
 * What the sidebar shows beside the rail besides your chats. The open chat
 * stays where it is while you look through them.
 */

export const SIDEBAR_TOOLTIP_CLASS =
  "rounded-md border border-sidebar-border bg-sidebar px-2.5 py-1.5 font-normal text-xs text-sidebar-foreground shadow-md";

const ROW_CLASS =
  "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent";
const ROW_ICON_CLASS =
  "size-8 shrink-0 rounded-[10px] bg-background p-2 text-muted-foreground";

/** A panel's title, with the one action it has, if any, beside it. */
export function SidebarPanelHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center justify-between pt-3 pr-3 pb-1 pl-5">
      <h2 className="text-muted-foreground text-sm">{title}</h2>
      {children}
    </div>
  );
}

/** An icon button in a panel's header, labelled by its tooltip. */
export function SidebarPanelAction({
  label,
  onClick,
  disabled,
  ref,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          className="flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        showArrow={false}
        className={SIDEBAR_TOOLTIP_CLASS}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function PanelList({
  label,
  empty,
  children,
}: {
  label: string;
  /** What to say instead when the list is empty. */
  empty: string | false;
  children: ReactNode;
}) {
  return (
    <nav
      aria-label={label}
      className="flex-1 overflow-y-auto px-3 pb-2 scrollbar-thin"
    >
      {empty ? (
        <p className="px-2 py-1 text-muted-foreground text-xs">{empty}</p>
      ) : (
        <ul className="space-y-px">{children}</ul>
      )}
    </nav>
  );
}

/** A row's title and the muted line below it. */
function RowText({ title, meta }: { title: string; meta: ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate">{title}</span>
      <span className="block truncate text-muted-foreground text-xs">
        {meta}
      </span>
    </span>
  );
}

/** Unread notifications, with opened ones kept in place until you leave the panel. */
export function NotificationsPanel({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: notifications } = useQuery(notificationsQuery());
  // Calls your bots' guests asked to make with tools you approve first: they wait here, in any Pim.
  const { data: approvals } = useQuery(approvalsQuery());
  const botRequests = (approvals ?? []).filter(
    (approval) =>
      approval.status === "pending" && approval.requestedBy?.bot !== undefined,
  );
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const pending = (notifications ?? []).filter(
    (n) => n.readAt === null || seen.has(n.id),
  );
  const { mutate: markSeen } = useMutation({
    mutationFn: (id: string) => pim.markRead(id),
    onMutate: (id) => setSeen((previous) => new Set(previous).add(id)),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (error) => toast.error(error.message),
  });
  const markAll = useMutation({
    mutationFn: () => Promise.all(pending.map((n) => pim.markRead(n.id))),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
      setSeen(new Set());
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (error) => toast.error(error.message),
  });
  return (
    <>
      <SidebarPanelHeader title={t("notifications")}>
        {pending.length > 0 && (
          <SidebarPanelAction
            label={t("markAllRead")}
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
          >
            <CheckCheck className="size-4.5" />
          </SidebarPanelAction>
        )}
      </SidebarPanelHeader>
      {botRequests.length > 0 && (
        <section
          aria-label={t("waitingForYou")}
          className="max-h-[60%] shrink-0 space-y-2 overflow-y-auto px-3 pb-3 scrollbar-thin"
        >
          <h3 className="px-2 text-muted-foreground text-xs">
            {t("waitingForYou")}
          </h3>
          {botRequests.map((approval) => (
            <ApprovalBlock key={approval.id} approval={approval} />
          ))}
        </section>
      )}
      <PanelList
        label={t("notifications")}
        empty={
          notifications !== undefined &&
          pending.length === 0 &&
          t("noNotifications")
        }
      >
        {pending.map((notification) => (
          <NotificationRow
            key={notification.id}
            notification={notification}
            onSeen={markSeen}
            onNavigate={onNavigate}
          />
        ))}
      </PanelList>
    </>
  );
}

/** A notification's agent tile, or Pim's mark, with a small badge for what kind it is. */
export function NotificationIcon({
  notification,
  className,
}: {
  notification: PimNotification;
  className?: string;
}) {
  const Badge =
    notification.kind === "mention"
      ? AtSign
      : notification.kind === "scheduled"
        ? CalendarClock
        : null;
  return (
    <span className="relative shrink-0">
      {notification.agent ? (
        <AgentIcon agent={notification.agent} tile className={className} />
      ) : (
        <img
          src="/icon-192.png"
          alt=""
          className={cn("shrink-0 rounded-lg", className)}
        />
      )}
      {Badge && (
        <span className="-bottom-1 -right-1 absolute flex size-4 items-center justify-center rounded-full bg-link text-background ring-2 ring-background">
          <Badge className="size-2.5" />
        </span>
      )}
    </span>
  );
}

function NotificationRow({
  notification,
  onSeen,
  onNavigate,
}: {
  notification: PimNotification;
  onSeen: (id: string) => void;
  onNavigate?: () => void;
}) {
  const { formatDate } = useI18n();
  const unread = notification.readAt === null;
  const content = (
    <>
      <NotificationIcon notification={notification} className="size-8" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{notification.title}</span>

        <time
          dateTime={new Date(notification.createdAt).toISOString()}
          title={formatDate(new Date(notification.createdAt), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          className="mt-0.5 block text-muted-foreground text-xs"
        >
          {formatDate(new Date(notification.createdAt), {
            ...(new Date(notification.createdAt).toDateString() !==
            new Date().toDateString()
              ? { month: "short", day: "numeric" }
              : {}),
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      </span>
    </>
  );
  return (
    <li>
      {notification.session ? (
        <Link
          to="/chat/$sessionId"
          params={{ sessionId: notification.session }}
          onClick={() => {
            if (unread) onSeen(notification.id);
            onNavigate?.();
          }}
          className={ROW_CLASS}
        >
          {content}
        </Link>
      ) : (
        <div className={cn(ROW_CLASS, "hover:bg-transparent")}>{content}</div>
      )}
    </li>
  );
}

/** Whether the admin left Notes on; while that's loading, it is. */
export function useNotesOn() {
  const { data } = useQuery(builtinAppsQuery());
  return data?.some((app) => app.id === "notes") ?? true;
}

/** How your agents do work that comes up again, by name; each opens the skill. */
export function SkillsPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const { data: skills } = useQuery(skillsQuery());
  return (
    <>
      <SidebarPanelHeader title={t("skills")} />
      <PanelList
        label={t("skills")}
        empty={skills?.length === 0 && t("noSkills")}
      >
        {skills?.map((skill) => (
          <li key={skill.name}>
            <Link
              to="/skills/$skillName"
              params={{ skillName: skill.name }}
              onClick={onNavigate}
              className={ROW_CLASS}
              activeOptions={{ includeSearch: false }}
              activeProps={{ className: "bg-sidebar-accent" }}
              title={skill.description}
            >
              <ScrollText className={ROW_ICON_CLASS} />
              <RowText title={skill.name} meta={skill.description} />
            </Link>
          </li>
        ))}
      </PanelList>
    </>
  );
}
