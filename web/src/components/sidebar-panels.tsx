import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, type Ref, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { ARTIFACT_KIND_NAMES, ArtifactIcon } from "~/components/artifact-icon";
import { ApprovalBlock } from "~/components/chat/items";
import { useI18n } from "~/components/i18n";
import {
  AtSign,
  CalendarClock,
  Check,
  CheckCheck,
  FileText,
  MoreHorizontal,
  Repeat,
  ScrollText,
  SquarePen,
  Trash2,
} from "~/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  type ArtifactKind,
  type PimNotification,
  type PimSchedule,
  pim,
} from "~/lib/pim-api";
import {
  approvalsQuery,
  artifactsQuery,
  builtinAppsQuery,
  notificationsQuery,
  schedulesQuery,
  sessionsQuery,
  sharedArtifactsQuery,
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

/**
 * Pim's built-in apps, then the pages and tools your agents made, most
 * recently changed first. With Notes off, the notes you have are among them.
 */
export function ArtifactsPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const notesOn = useNotesOn();
  return (
    <>
      <SidebarPanelHeader title={t("artifacts")} />
      <ArtifactList
        show={notesOn ? "apps" : "all"}
        onNavigate={onNavigate}
        builtIn={
          notesOn && (
            <li className="pb-3">
              <SectionLabel>{t("builtInApps")}</SectionLabel>
              <ul className="space-y-px" aria-label={t("builtInApps")}>
                <li>
                  {/* Notes keeps its own list, in its own panel. */}
                  <Link
                    to="."
                    search={(prev) => ({ ...prev, panel: "notes" })}
                    className={ROW_CLASS}
                  >
                    <FileText className={ROW_ICON_CLASS} />
                    <RowText title={t("notes")} meta={t("notesDescription")} />
                  </Link>
                </li>
              </ul>
            </li>
          )
        }
      />
    </>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
      {children}
    </div>
  );
}

/** Notes, which you write in with your agents, most recently changed first, and a button that starts one. */
export function NotesPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => pim.createNote(t("untitledNote")),
    onSuccess: async (note) => {
      await queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      onNavigate?.();
      await navigate({
        to: "/artifacts/$artifactId",
        params: { artifactId: note.id },
        search: { v: note.version },
      });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <>
      <SidebarPanelHeader title={t("notes")}>
        <SidebarPanelAction
          label={t("newNote")}
          onClick={() => create.mutate()}
          disabled={create.isPending}
        >
          <SquarePen className="size-4.5" />
        </SidebarPanelAction>
      </SidebarPanelHeader>
      <ArtifactList show="notes" onNavigate={onNavigate} />
    </>
  );
}

/** Your apps and those shared with you, after Pim's own apps: the notes, everything else, or all of them. */
function ArtifactList({
  show,
  onNavigate,
  builtIn,
}: {
  show: "notes" | "apps" | "all";
  onNavigate?: () => void;
  /** Pim's built-in apps, listed first, with yours under a label of their own. */
  builtIn?: ReactNode;
}) {
  const { t, formatDate } = useI18n();
  const { data } = useQuery(artifactsQuery());
  const { data: shared } = useQuery(sharedArtifactsQuery());
  const notes = show === "notes";
  const wanted = (kind: ArtifactKind) =>
    show === "all" || (kind === "markdown") === notes;
  const own = data?.artifacts.filter((artifact) => wanted(artifact.kind));
  const others = shared?.filter((artifact) => wanted(artifact.kind));
  const label = t(notes ? "notes" : "artifacts");
  const empty =
    own?.length === 0 &&
    !others?.length &&
    t(notes ? "noNotes" : "noArtifacts");
  return (
    <PanelList label={label} empty={!builtIn && empty}>
      {builtIn}
      {builtIn && (
        <li>
          <SectionLabel>{t("yourApps")}</SectionLabel>
          {empty && (
            <p className="px-2 py-1 text-muted-foreground text-xs">{empty}</p>
          )}
        </li>
      )}
      {own?.map((artifact) => {
        const date = formatDate(new Date(artifact.updatedAt), {
          dateStyle: "medium",
        });
        return (
          <li key={artifact.id}>
            <Link
              to="/artifacts/$artifactId"
              params={{ artifactId: artifact.id }}
              search={{ v: artifact.version }}
              onClick={onNavigate}
              className={ROW_CLASS}
              activeOptions={{ includeSearch: false }}
              activeProps={{ className: "bg-sidebar-accent" }}
            >
              <ArtifactIcon kind={artifact.kind} className={ROW_ICON_CLASS} />
              <RowText
                title={artifact.title}
                meta={
                  notes
                    ? date
                    : `${ARTIFACT_KIND_NAMES[artifact.kind]} · ${date}`
                }
              />
            </Link>
          </li>
        );
      })}
      {others && others.length > 0 && (
        <li className="pt-3">
          <SectionLabel>{t("sharedWithYou")}</SectionLabel>
          <ul className="space-y-px" aria-label={t("sharedWithYou")}>
            {others.map((artifact) => (
              <li key={`${artifact.host}/${artifact.id}`}>
                <Link
                  to="/artifacts/shared/$host/$artifactId"
                  params={{ host: artifact.host, artifactId: artifact.id }}
                  onClick={onNavigate}
                  className={ROW_CLASS}
                  activeProps={{ className: "bg-sidebar-accent" }}
                >
                  <ArtifactIcon
                    kind={artifact.kind}
                    className={ROW_ICON_CLASS}
                  />
                  <RowText
                    title={artifact.title}
                    meta={
                      notes
                        ? t("sharedBy", { host: artifact.host })
                        : `${ARTIFACT_KIND_NAMES[artifact.kind]} · ${t("sharedBy", { host: artifact.host })}`
                    }
                  />
                </Link>
              </li>
            ))}
          </ul>
        </li>
      )}
    </PanelList>
  );
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

/** What your agents will do later, soonest first; each opens the chat it runs in. */
export function SchedulesPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const { data: schedules } = useQuery(schedulesQuery());
  const { data: sessions } = useQuery(sessionsQuery());
  const soonestFirst = [...(schedules ?? [])].sort(
    (a, b) => Date.parse(a.next) - Date.parse(b.next),
  );
  return (
    <>
      <SidebarPanelHeader title={t("schedules")} />
      <PanelList
        label={t("schedules")}
        empty={schedules?.length === 0 && t("noSchedules")}
      >
        {soonestFirst.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            // A task that starts new chats outlives the chat that scheduled it: no link once that chat is gone.
            linked={
              !schedule.newChat ||
              !!sessions?.some((session) => session.id === schedule.session)
            }
            onNavigate={onNavigate}
          />
        ))}
      </PanelList>
    </>
  );
}

function ScheduleRow({
  schedule,
  linked,
  onNavigate,
}: {
  schedule: PimSchedule;
  linked: boolean;
  onNavigate?: () => void;
}) {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const active = linked && params.sessionId === schedule.session;
  const repeats = schedule.type === "cron" || schedule.type === "interval";
  const Icon = repeats ? Repeat : CalendarClock;
  // Cancelling asks twice: the first click turns the item into a confirmation.
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => pim.cancelSchedule(schedule.id),
    onSuccess: () => {
      toast.success(t("scheduleCancelled"));
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const content = (
    <>
      <Icon className={ROW_ICON_CLASS} />
      <RowText
        title={schedule.label ?? schedule.instruction}
        meta={t("scheduleNext", {
          date: formatDate(new Date(schedule.next), {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
        })}
      />
    </>
  );
  return (
    <li className="group/row relative" title={schedule.instruction}>
      {linked ? (
        <Link
          to="/chat/$sessionId"
          params={{ sessionId: schedule.session }}
          onClick={onNavigate}
          className={cn(ROW_CLASS, "pr-8", active && "bg-sidebar-accent")}
        >
          {content}
        </Link>
      ) : (
        <div className={cn(ROW_CLASS, "pr-8 hover:bg-transparent")}>
          {content}
        </div>
      )}
      <DropdownMenu onOpenChange={() => setConfirming(false)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "-translate-y-1/2 absolute top-1/2 right-1.5 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100",
              active && "opacity-100",
            )}
            aria-label={t("scheduleOptions")}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem
            variant="destructive"
            disabled={cancel.isPending}
            onSelect={(event) => {
              if (!confirming) {
                event.preventDefault();
                setConfirming(true);
                return;
              }
              cancel.mutate();
            }}
          >
            {confirming ? (
              <Check className="size-4" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {confirming ? t("confirmCancelSchedule") : t("cancelSchedule")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
