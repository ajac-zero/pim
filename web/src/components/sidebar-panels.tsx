import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { AgentSettingsDialog } from "~/components/agent-settings";
import {
  ARTIFACT_KIND_NAMES,
  ArtifactIcon,
  formatBytes,
} from "~/components/artifact";
import { useI18n } from "~/components/i18n";
import {
  ArrowLeft,
  CalendarClock,
  Check,
  CheckCheck,
  Download,
  FileIcon,
  Folder,
  MoreHorizontal,
  Plus,
  Repeat,
  ScrollText,
  Settings,
  Trash2,
  Upload,
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
import { baseName, parentOf } from "~/lib/files";
import {
  type Agent,
  ApiError,
  FILES_ROOT,
  type FileEntry,
  fileContentUrl,
  type PimNotification,
  type PimSchedule,
  pim,
} from "~/lib/pim-api";
import {
  agentsQuery,
  artifactsQuery,
  filesQuery,
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

/** What Pim told you, newest first. Opening one marks it read. */
export function NotificationsPanel({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: notifications } = useQuery(notificationsQuery());
  const unread = (notifications ?? []).filter((n) => n.readAt === null);
  const markAll = useMutation({
    mutationFn: () => Promise.all(unread.map((n) => pim.markRead(n.id))),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (error) => toast.error(error.message),
  });
  return (
    <>
      <SidebarPanelHeader title={t("notifications")}>
        {unread.length > 0 && (
          <SidebarPanelAction
            label={t("markAllRead")}
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
          >
            <CheckCheck className="size-4.5" />
          </SidebarPanelAction>
        )}
      </SidebarPanelHeader>
      <PanelList
        label={t("notifications")}
        empty={notifications?.length === 0 && t("noNotifications")}
      >
        {notifications?.map((notification) => (
          <NotificationRow
            key={notification.id}
            notification={notification}
            onNavigate={onNavigate}
          />
        ))}
      </PanelList>
    </>
  );
}

function NotificationRow({
  notification,
  onNavigate,
}: {
  notification: PimNotification;
  onNavigate?: () => void;
}) {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const unread = notification.readAt === null;
  const markRead = useMutation({
    mutationFn: () => pim.markRead(notification.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (error) => toast.error(error.message),
  });
  const read = () => {
    if (unread) markRead.mutate();
  };
  const content = (
    <>
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 self-start rounded-full",
          unread ? "bg-link" : "bg-transparent",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        {unread && <span className="sr-only">{t("unread")}: </span>}
        <span
          className={cn("block truncate", !unread && "text-muted-foreground")}
        >
          {notification.title}
        </span>
        {notification.body && (
          <span className="line-clamp-2 text-muted-foreground text-xs">
            {notification.body}
          </span>
        )}
        <time className="mt-0.5 block text-muted-foreground text-xs">
          {formatDate(new Date(notification.createdAt), {
            dateStyle: "medium",
            timeStyle: "short",
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
            read();
            onNavigate?.();
          }}
          className={cn(ROW_CLASS, "items-start gap-2")}
        >
          {content}
        </Link>
      ) : unread ? (
        <button
          type="button"
          onClick={read}
          title={t("markRead")}
          className={cn(ROW_CLASS, "items-start gap-2")}
        >
          {content}
        </button>
      ) : (
        <div
          className={cn(ROW_CLASS, "items-start gap-2 hover:bg-transparent")}
        >
          {content}
        </div>
      )}
    </li>
  );
}

/** Documents and pages your agents made, most recently changed first. */
export function ArtifactsPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { t, formatDate } = useI18n();
  const { data } = useQuery(artifactsQuery());
  const { data: shared } = useQuery(sharedArtifactsQuery());
  return (
    <>
      <SidebarPanelHeader title={t("artifacts")} />
      <PanelList
        label={t("artifacts")}
        empty={
          data?.artifacts.length === 0 && !shared?.length && t("noArtifacts")
        }
      >
        {data?.artifacts.map((artifact) => {
          const row = (
            <>
              <ArtifactIcon kind={artifact.kind} className={ROW_ICON_CLASS} />
              <RowText
                title={artifact.title}
                meta={`${ARTIFACT_KIND_NAMES[artifact.kind]} · ${formatDate(
                  new Date(artifact.updatedAt),
                  { dateStyle: "medium" },
                )}`}
              />
            </>
          );
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
                {row}
              </Link>
            </li>
          );
        })}
        {shared && shared.length > 0 && (
          <li className="pt-3">
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              {t("sharedWithYou")}
            </div>
            <ul className="space-y-px" aria-label={t("sharedWithYou")}>
              {shared.map((artifact) => (
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
                      meta={`${ARTIFACT_KIND_NAMES[artifact.kind]} · ${t("sharedBy", { host: artifact.host })}`}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        )}
      </PanelList>
    </>
  );
}

/**
 * Your files, which your agents read and write too: one folder at a time,
 * folders first. Opening a file shows it beside the sidebar; uploads go to
 * the folder showing.
 */
export function FilesPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // The panel opens on the folder of the file showing, if one is.
  const { path: open } = useSearch({ strict: false }) as { path?: string };
  const [folder, setFolder] = useState(
    () => (open && parentOf(open)) || FILES_ROOT,
  );
  const { data, error } = useQuery(filesQuery(folder));
  // A folder deleted meanwhile leaves you at the top.
  useEffect(() => {
    if (error instanceof ApiError && error.status === 404)
      setFolder(FILES_ROOT);
  }, [error]);
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (files: File[]) =>
      Promise.all(
        files.map((file) => pim.uploadFile(`${folder}/${file.name}`, file)),
      ),
    onSuccess: (saved) =>
      toast.success(t("filesUploaded", { count: saved.length })),
    onError: (failure) => toast.error(failure.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["files"] }),
  });
  const parent = parentOf(folder);
  return (
    <>
      <SidebarPanelHeader title={t("files")}>
        <SidebarPanelAction
          label={t("uploadFiles")}
          onClick={() => input.current?.click()}
          disabled={upload.isPending}
        >
          <Upload className="size-4.5" />
        </SidebarPanelAction>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length > 0) upload.mutate(files);
          }}
        />
      </SidebarPanelHeader>
      {parent !== null && (
        <button
          type="button"
          onClick={() => setFolder(parent)}
          className="mx-3 mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-muted-foreground text-sm transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4 shrink-0" />
          <span className="truncate">
            {parent === FILES_ROOT ? t("files") : baseName(parent)}
            <span className="sr-only">: {t("parentFolder")}</span>
          </span>
          <span className="ml-auto truncate text-foreground">
            {baseName(folder)}
          </span>
        </button>
      )}
      <PanelList
        label={t("files")}
        empty={
          data?.entries.length === 0 &&
          t(folder === FILES_ROOT ? "noFiles" : "emptyFolder")
        }
      >
        {data?.entries.map((entry) => (
          <FileRow
            key={entry.path}
            entry={entry}
            active={entry.path === open}
            onOpenFolder={() => setFolder(entry.path)}
            onNavigate={onNavigate}
          />
        ))}
      </PanelList>
    </>
  );
}

function FileRow({
  entry,
  active,
  onOpenFolder,
  onNavigate,
}: {
  entry: FileEntry;
  active: boolean;
  onOpenFolder: () => void;
  onNavigate?: () => void;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const folder = entry.type === "directory";
  // Deleting asks twice: the first click turns the item into a confirmation.
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => pim.deleteFile(entry.path),
    onSuccess: () => {
      toast.success(t("fileDeleted", { name: entry.name }));
      void queryClient.invalidateQueries({ queryKey: ["files"] });
      if (active) void navigate({ to: "/" });
    },
    onError: (failure) => toast.error(failure.message),
  });
  const date = formatDate(new Date(entry.updatedAt), { dateStyle: "medium" });
  const content = (
    <>
      {folder ? (
        <Folder className={ROW_ICON_CLASS} />
      ) : (
        <FileIcon className={ROW_ICON_CLASS} />
      )}
      <RowText
        title={entry.name}
        meta={
          folder
            ? t("folder")
            : `${formatBytes(entry.size, formatNumber)} · ${date}`
        }
      />
    </>
  );
  return (
    <li className="group/row relative">
      {folder ? (
        <button
          type="button"
          onClick={onOpenFolder}
          className={cn(ROW_CLASS, "pr-8")}
        >
          {content}
        </button>
      ) : (
        <Link
          to="/files"
          search={{ path: entry.path }}
          onClick={onNavigate}
          className={cn(ROW_CLASS, "pr-8", active && "bg-sidebar-accent")}
        >
          {content}
        </Link>
      )}
      <DropdownMenu onOpenChange={() => setConfirming(false)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "-translate-y-1/2 absolute top-1/2 right-1.5 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100",
              active && "opacity-100",
            )}
            aria-label={t("fileOptions", { name: entry.name })}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          {!folder && (
            <DropdownMenuItem asChild>
              <a href={fileContentUrl(entry.path, true)} download>
                <Download className="size-4" />
                {t("download")}
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            disabled={remove.isPending}
            onSelect={(event) => {
              if (!confirming) {
                event.preventDefault();
                setConfirming(true);
                return;
              }
              remove.mutate();
            }}
          >
            {confirming ? (
              <Check className="size-4" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {confirming
              ? t(folder ? "confirmDeleteFolder" : "confirmDeleteFile")
              : t("deleteFile")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * Your agents, each opening its dashboard, with its settings a click away
 * and a new one from the header.
 */
export function AgentsPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const { data: agents } = useQuery(agentsQuery());
  const [creating, setCreating] = useState(false);
  const newAgent = useRef<HTMLButtonElement>(null);
  return (
    <>
      <SidebarPanelHeader title={t("agents")}>
        <SidebarPanelAction
          ref={newAgent}
          label={t("newAgent")}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-4.5" />
        </SidebarPanelAction>
        <AgentSettingsDialog
          open={creating}
          onOpenChange={setCreating}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            newAgent.current?.focus();
          }}
        />
      </SidebarPanelHeader>
      <PanelList label={t("agents")} empty={false}>
        {agents?.map((agent) => (
          <AgentRow key={agent.id} agent={agent} onNavigate={onNavigate} />
        ))}
      </PanelList>
    </>
  );
}

function AgentRow({
  agent,
  onNavigate,
}: {
  agent: Agent;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settings = useRef<HTMLButtonElement>(null);
  return (
    <li className="group/row relative">
      <Link
        to="/agents/$agentId"
        params={{ agentId: agent.id }}
        onClick={onNavigate}
        className={cn(ROW_CLASS, "pr-8")}
        activeOptions={{ includeSearch: false }}
        activeProps={{ className: "bg-sidebar-accent" }}
      >
        <AgentIcon agent={agent} tile className="size-8 rounded-[10px]" />
        <RowText
          title={agent.name}
          meta={agent.majordomo ? t("majordomoBadge") : agent.description}
        />
      </Link>
      <button
        ref={settings}
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="-translate-y-1/2 absolute top-1/2 right-1.5 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100"
        aria-label={t("agentSettings", { name: agent.name })}
      >
        <Settings className="size-4" />
      </button>
      <AgentSettingsDialog
        agent={agent}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          settings.current?.focus();
        }}
      />
    </li>
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
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
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
