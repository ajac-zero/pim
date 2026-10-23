import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { useI18n } from "~/components/i18n";
import {
  Archive,
  Bell,
  Blocks,
  CalendarClock,
  Check,
  ChevronDown,
  Compass,
  Contact,
  ExternalLink,
  Folder,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  ScrollText,
  Search,
  Settings,
  Shapes,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Trash2,
  Users,
  X,
} from "~/components/icons";
import {
  ProfilePopover,
  ProfilePopoverTrigger,
} from "~/components/profile-popover";
import { Shortcut } from "~/components/shortcut";
import {
  AgentsPanel,
  ArtifactsPanel,
  FilesPanel,
  NotificationsPanel,
  SchedulesPanel,
  SIDEBAR_TOOLTIP_CLASS,
  SkillsPanel,
} from "~/components/sidebar-panels";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { flatChats, groupByAge } from "~/lib/chat-list";
import { pim, type Session } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import {
  accountQuery,
  agentsQuery,
  approvalsQuery,
  computerQuery,
  extensionsQuery,
  notificationsQuery,
  profileQuery,
  sessionsQuery,
} from "~/lib/queries";
import { CHAT_DRAG_TYPE, closeTab, openTab } from "~/lib/tabs";
import { cn } from "~/lib/utils";
import { version } from "../../../package.json";

type T = ReturnType<typeof useI18n>["t"];

export function sessionTitle(session: Pick<Session, "title">, t: T) {
  return session.title ?? t("newChat");
}

/**
 * Opens the dashboard of the agent in the open chat, or of the agent whose
 * dashboard is open, or the majordomo's anywhere else, where a chat starts
 * with its first message.
 */
export function useNewChat(onDone?: () => void) {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    sessionId?: string;
    agentId?: string;
  };
  const { data: sessions } = useQuery(sessionsQuery());
  const agentId =
    params.agentId ??
    sessions?.find((session) => session.id === params.sessionId)?.agent?.id;
  return () => {
    if (agentId) {
      navigate({ to: "/agents/$agentId", params: { agentId } });
    } else {
      navigate({ to: "/" });
    }
    onDone?.();
  };
}

/** Chats with an action waiting for the user's approval. */
export function useAwaitingApproval() {
  const { data: approvals } = useQuery(approvalsQuery());
  return useMemo(
    () =>
      new Set(
        approvals
          ?.filter(
            (approval) =>
              approval.status === "pending" && !approval.requestedBy,
          )
          .flatMap(
            (approval) => approval.member?.session ?? approval.session ?? [],
          ),
      ),
    [approvals],
  );
}

/** What the sidebar can show beside the rail instead of your chats, named in the URL (`?panel=artifacts`). */
export const SIDEBAR_PANELS = [
  "notifications",
  "agents",
  "artifacts",
  "files",
  "skills",
  "schedules",
] as const;
export type SidebarPanel = (typeof SIDEBAR_PANELS)[number];

/**
 * What the navigation shows beside its icons: who you are, whether there
 * are others on this Pim, and what waits for you behind each icon.
 */
export function useNavigationState() {
  const { data: approvals } = useQuery(approvalsQuery());
  const { data: notifications } = useQuery(notificationsQuery());
  // Sharing, Discover and your profile are with the other people on this Pim.
  const { data: account } = useQuery(accountQuery());
  const { data: profile } = useQuery({ ...profileQuery(), enabled: !!account });
  // Your files are on your computer: without one, there are none to show.
  const { data: computer } = useQuery(computerQuery());
  return {
    account,
    profile,
    hasComputer: !!computer && computer.state !== "none",
    // Alone on this Pim, there is nobody to share with or discover.
    withOthers: !!account && !account.alone,
    awaitingApproval: useAwaitingApproval(),
    /* Requests from people in your circles, waiting in Sharing. */
    guestRequests:
      approvals?.filter(
        (approval) => approval.status === "pending" && approval.requestedBy,
      ).length ?? 0,
    unreadNotifications:
      notifications?.filter((notification) => notification.readAt === null)
        .length ?? 0,
  };
}

/** The panel the URL names: notifications, your chats, your agents, artifacts, files, skills or schedules. */
export function SidebarPanelContent({
  awaitingApproval,
  onNavigate,
}: {
  awaitingApproval: ReadonlySet<string>;
  onNavigate?: () => void;
}) {
  const { panel } = useSearch({ strict: false });
  return panel === "notifications" ? (
    <NotificationsPanel onNavigate={onNavigate} />
  ) : panel === "agents" ? (
    <AgentsPanel onNavigate={onNavigate} />
  ) : panel === "artifacts" ? (
    <ArtifactsPanel onNavigate={onNavigate} />
  ) : panel === "files" ? (
    <FilesPanel onNavigate={onNavigate} />
  ) : panel === "skills" ? (
    <SkillsPanel onNavigate={onNavigate} />
  ) : panel === "schedules" ? (
    <SchedulesPanel onNavigate={onNavigate} />
  ) : (
    <ChatsPanel awaitingApproval={awaitingApproval} onNavigate={onNavigate} />
  );
}

/**
 * The sidebar on wider screens: a rail of icons beside a panel. The icons at
 * the top choose what the panel shows (notifications, your chats, your agents, artifacts,
 * files, skills or schedules) while the open chat stays where it is; those at
 * the bottom open dialogs over it. Choosing the panel that's already showing
 * collapses the sidebar to the rail, and choosing any panel brings it back.
 */
export function AppSidebar({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const { panel } = useSearch({ strict: false });
  const {
    account,
    profile,
    hasComputer,
    withOthers,
    awaitingApproval,
    guestRequests,
    unreadNotifications,
  } = useNavigationState();
  const railPanel = {
    current: panel,
    collapsed,
    onToggleCollapse,
  };

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-full w-full overflow-hidden bg-sidebar text-sidebar-foreground">
        {/* Rail */}
        <nav
          aria-label={t("navigation")}
          className="flex w-16 shrink-0 flex-col items-center gap-1 bg-sidebar-accent/40 py-3"
        >
          <SidebarLogo />
          <RailPanel
            {...railPanel}
            panel="notifications"
            icon={<Bell className="size-4.5" />}
            label={t("notifications")}
            count={unreadNotifications}
          />
          <RailPanel
            {...railPanel}
            icon={<MessagesSquare className="size-4.5" />}
            label={t("chats")}
            count={panel || collapsed ? awaitingApproval.size : 0}
          />
          <RailPanel
            {...railPanel}
            panel="agents"
            icon={<Contact className="size-4.5" />}
            label={t("agents")}
          />
          <RailPanel
            {...railPanel}
            panel="artifacts"
            icon={<Shapes className="size-4.5" />}
            label={t("artifacts")}
          />
          {hasComputer && (
            <RailPanel
              {...railPanel}
              panel="files"
              icon={<Folder className="size-4.5" />}
              label={t("files")}
            />
          )}
          <RailPanel
            {...railPanel}
            panel="skills"
            icon={<ScrollText className="size-4.5" />}
            label={t("skills")}
          />
          <RailPanel
            {...railPanel}
            panel="schedules"
            icon={<CalendarClock className="size-4.5" />}
            label={t("schedules")}
          />
          {/* Below, what opens over the chat instead of beside it. */}
          <div className="mt-auto" />
          {withOthers && (
            <RailDialogLink
              dialog="discover"
              icon={<Compass className="size-4.5" />}
              label={t("discover")}
            />
          )}
          <RailDialogLink
            dialog="apps"
            icon={<Blocks className="size-4.5" />}
            label={t("connectedApps")}
          />
          {withOthers && (
            <RailDialogLink
              dialog="sharing"
              icon={<Users className="size-4.5" />}
              label={t("sharing")}
              count={guestRequests}
            />
          )}
          <RailDialogLink
            dialog="settings"
            icon={<Settings className="size-4.5" />}
            label={t("settings")}
          />
          {account && (
            <ProfilePopover account={account} profile={profile}>
              <RailItem
                icon={
                  <span className="flex size-7 items-center justify-center rounded-full bg-background font-medium text-foreground text-xs uppercase">
                    {(profile?.displayName ?? account.username).slice(0, 1)}
                  </span>
                }
                label={profile?.displayName ?? `@${account.username}`}
              >
                {(content) => (
                  <ProfilePopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        RAIL_ITEM_CLASS,
                        "aria-expanded:bg-sidebar-accent",
                      )}
                      aria-label={t("profile")}
                    >
                      {content}
                    </button>
                  </ProfilePopoverTrigger>
                )}
              </RailItem>
            </ProfilePopover>
          )}
        </nav>

        <div
          inert={collapsed}
          className={cn(
            "flex min-w-0 flex-1 flex-col transition-opacity duration-200",
            collapsed && "opacity-0",
          )}
        >
          <SidebarPanelContent awaitingApproval={awaitingApproval} />
        </div>
      </div>
    </TooltipProvider>
  );
}

/** Every chat in one list, most recently active first, under dividers by age. */
function ChatsPanel({
  awaitingApproval,
  onNavigate,
}: {
  awaitingApproval: ReadonlySet<string>;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const { data: sessions } = useQuery(sessionsQuery());
  const params = useParams({ strict: false }) as { sessionId?: string };
  const activeId = params.sessionId;
  const newChat = useNewChat(onNavigate);
  const current = useMemo(
    () => flatChats(sessions ?? [], search, t("newChat")),
    [sessions, search, t],
  );
  const open = current.filter((session) => !session.archived);
  const archived = current.filter((session) => session.archived);

  return (
    <>
      <div className="px-3 pt-4 pb-2">
        <div className="relative">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchChats")}
            className="h-8 truncate border-transparent bg-sidebar-accent/60 pl-8 text-sm shadow-none focus-visible:border-sidebar-border focus-visible:bg-sidebar-accent/60 focus-visible:ring-0"
          />
        </div>
      </div>

      <div className="flex justify-start px-3 pb-3">
        <Button
          variant="ghost"
          size="lg"
          className="w-full justify-start rounded-lg px-2 text-foreground hover:bg-sidebar-accent hover:text-foreground has-[>svg]:px-2"
          onClick={newChat}
        >
          <SquarePen className="size-4.5" />
          {t("newChat")}
          <Shortcut keys="⇧O" />
        </Button>
      </div>

      <nav
        aria-label={t("chats")}
        className="flex-1 overflow-y-auto px-3 py-3 scrollbar-thin [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]"
      >
        {open.length === 0 ? (
          (archived.length === 0 || !search) && (
            <p className="px-2 py-6 text-center text-muted-foreground text-sm">
              {t(
                archived.length > 0
                  ? "noRecentChats"
                  : search
                    ? "noChatsMatch"
                    : "noChatsYet",
              )}
            </p>
          )
        ) : (
          <DatedChats
            list={open}
            activeId={activeId}
            awaitingApproval={awaitingApproval}
            onNavigate={onNavigate}
          />
        )}
        {archived.length > 0 && (
          <ArchivedChats
            list={archived}
            activeId={activeId}
            searching={!!search}
            awaitingApproval={awaitingApproval}
            onNavigate={onNavigate}
          />
        )}
      </nav>
    </>
  );
}

const RAIL_ITEM_CLASS =
  "relative flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground";
const RAIL_ACTIVE_CLASS =
  "data-[status=active]:bg-sidebar-accent data-[status=active]:text-foreground";

/** An icon in the rail, with a dot while something waits there and its label as a tooltip. */
function RailItem({
  icon,
  label,
  count = 0,
  children,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  children: (content: ReactNode) => ReactNode;
}) {
  const content = (
    <>
      {icon}
      {count > 0 && (
        <span className="absolute top-2 right-2 size-2 rounded-full bg-primary" />
      )}
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children(content)}</TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={12}
        showArrow={false}
        className={SIDEBAR_TOOLTIP_CLASS}
      >
        {count > 0 ? `${label} (${count})` : label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The deployment's logo (`logo` in `pim.config.ts`), or Pim's own mark, at the
 * top of the rail. It goes nowhere; hovering it shows which Pim this is.
 */
function SidebarLogo() {
  const { data, isPending } = useQuery(extensionsQuery());
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="mb-2 flex size-10 items-center justify-center">
          {/* Nothing until the logo is known, so Pim's mark doesn't flash before another. */}
          {isPending ? null : data?.logo ? (
            <img src={data.logo} alt="" className="size-8 object-contain" />
          ) : (
            <PimMark className="h-4 w-8" />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={12}
        showArrow={false}
        className={SIDEBAR_TOOLTIP_CLASS}
      >
        v{version}
      </TooltipContent>
    </Tooltip>
  );
}

/** A rail icon that shows its panel in the sidebar, or collapses the sidebar when it's already showing. */
function RailPanel({
  panel,
  current,
  collapsed,
  onToggleCollapse,
  ...props
}: {
  /** Which panel; none for your chats. */
  panel?: SidebarPanel;
  current?: SidebarPanel;
  collapsed: boolean;
  onToggleCollapse?: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  const selected = panel === current;
  return (
    <RailItem {...props}>
      {(content) => (
        <Link
          to="."
          search={(prev) => ({ ...prev, panel })}
          onClick={(event) => {
            if (!selected || !onToggleCollapse) return;
            event.preventDefault();
            onToggleCollapse();
          }}
          className={cn(
            RAIL_ITEM_CLASS,
            selected && !collapsed && "bg-sidebar-accent text-foreground",
          )}
          aria-label={props.label}
          aria-current={selected && !collapsed ? "true" : undefined}
        >
          {content}
        </Link>
      )}
    </RailItem>
  );
}

/** A rail icon that opens a dialog over the current page. */
function RailDialogLink({
  dialog,
  ...props
}: {
  dialog: "settings" | "sharing" | "discover" | "apps";
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <RailItem {...props}>
      {(content) => (
        <Link
          to="."
          search={(prev) => ({ ...prev, dialog, tab: undefined })}
          className={cn(RAIL_ITEM_CLASS, RAIL_ACTIVE_CLASS)}
          aria-label={props.label}
        >
          {content}
        </Link>
      )}
    </RailItem>
  );
}

/** Chats under dividers for today, yesterday, last week and the last 14 days. */
function DatedChats({
  list,
  activeId,
  awaitingApproval,
  onNavigate,
}: {
  list: Session[];
  activeId?: string;
  awaitingApproval: ReadonlySet<string>;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  return groupByAge(list).map(({ age, sessions }) => (
    <div key={age}>
      <div className="px-2 pt-2 pb-1 text-muted-foreground/70 text-xs">
        {t(age)}
      </div>
      <ul className="space-y-px">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={session.id === activeId}
            awaitingApproval={awaitingApproval.has(session.id)}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </div>
  ));
}

/**
 * Chats with no activity for two weeks, folded away below the others. It
 * opens while searching, and when the open chat is one of them.
 */
function ArchivedChats({
  list,
  activeId,
  searching,
  awaitingApproval,
  onNavigate,
}: {
  list: Session[];
  activeId?: string;
  searching: boolean;
  awaitingApproval: ReadonlySet<string>;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const holdsActive = list.some((session) => session.id === activeId);
  const [open, setOpen] = useState(holdsActive);
  const [shownFor, setShownFor] = useState(activeId);
  if (shownFor !== activeId) {
    setShownFor(activeId);
    if (holdsActive) setOpen(true);
  }
  const expanded = open || searching;
  return (
    <section className="mb-3" aria-label={t("archived")}>
      <button
        type="button"
        className="flex items-center gap-1 rounded-md px-2 py-1.5 font-medium text-muted-foreground text-xs hover:text-foreground"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
      >
        {t("archived")}
        <span className="font-normal">{list.length}</span>
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform",
            !expanded && "-rotate-90",
          )}
        />
      </button>
      {expanded && (
        <ul className="space-y-px">
          {list.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === activeId}
              awaitingApproval={awaitingApproval.has(session.id)}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A chat holds an action waiting for the user's approval. */
export function AwaitingApprovalMark({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <ShieldCheck
      className={cn("ml-auto size-3.5 shrink-0 text-primary", className)}
      role="img"
      aria-label={t("awaitingApproval")}
    />
  );
}

/**
 * Measures how far a row's title overflows once its options button takes room,
 * for it to slide by, at a readable pace and clear of the fade at the edge.
 */
function scrollTitleIntoView(event: { currentTarget: HTMLElement }) {
  const box = event.currentTarget.querySelector<HTMLElement>("[data-title]");
  if (!box?.firstElementChild) return;
  const overflow =
    (box.firstElementChild as HTMLElement).offsetWidth - box.clientWidth;
  const shift = overflow > 0 ? overflow + TITLE_FADE : 0;
  box.style.setProperty("--title-shift", `${-shift}px`);
  box.style.setProperty("--title-duration", `${shift / TITLE_SPEED}s`);
}

/** Pixels of the title that fade out at its edges, and how many it slides per second. */
const TITLE_FADE = 16;
const TITLE_SPEED = 40;

function SessionRow({
  session,
  active,
  awaitingApproval,
  onNavigate,
}: {
  session: Session;
  active: boolean;
  awaitingApproval: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const { data: agents } = useQuery(agentsQuery());
  // Chats from before agents belong to the majordomo.
  const agent = agents?.find((candidate) =>
    session.agent ? candidate.id === session.agent.id : candidate.majordomo,
  );
  // A group chat shows every agent in it, its host first.
  const chatAgents = [
    agent,
    ...(session.room?.members ?? []).map((member) =>
      agents?.find((candidate) => candidate.id === member.id),
    ),
  ].filter((candidate) => candidate !== undefined);
  const queryClient = useQueryClient();
  const title = sessionTitle(session, t);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);

  const renameMutation = useMutation({
    mutationFn: (newTitle: string) => pim.renameSession(session.id, newTitle),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (error) => toast.error(error.message),
  });
  const rename = () => {
    if (draft.trim() && draft.trim() !== title) {
      renameMutation.mutate(draft.trim());
    }
    setRenaming(false);
  };

  const regenerate = useMutation({
    mutationFn: () => pim.regenerateTitle(session.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (error) => toast.error(error.message),
  });

  const archive = useMutation({
    mutationFn: () => pim.archiveSession(session.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (error) => toast.error(error.message),
  });

  const navigate = useNavigate();
  // Delete asks twice: the first click turns the item into a confirmation.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: () => pim.deleteSession(session.id),
    onSuccess: async () => {
      if (pimClient.getState().session === session.id) pimClient.close();
      // The deleted chat's tab closes; the chat next to it takes its place.
      const next = closeTab(session.id);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      if (active) {
        await navigate(
          next
            ? { to: "/chat/$sessionId", params: { sessionId: next } }
            : { to: "/" },
        );
      }
    },
    onError: (error) => toast.error(error.message),
  });

  if (renaming) {
    return (
      <li className="flex items-center gap-1 px-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-7 text-sm"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") rename();
            if (e.key === "Escape") setRenaming(false);
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={rename}
          aria-label={t("saveName")}
        >
          <Check className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => setRenaming(false)}
          aria-label={t("cancelRename")}
        >
          <X className="size-3.5" />
        </Button>
      </li>
    );
  }

  return (
    <li className="group/row relative">
      <Link
        to="/chat/$sessionId"
        params={{ sessionId: session.id }}
        onClick={onNavigate}
        onDragStart={(event) =>
          event.dataTransfer.setData(CHAT_DRAG_TYPE, session.id)
        }
        className={cn(
          "flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent group-focus-within/row:pr-8 group-hover/row:pr-8 pointer-coarse:pr-8",
          active && "bg-sidebar-accent pr-8",
        )}
        onMouseEnter={scrollTitleIntoView}
        onFocus={scrollTitleIntoView}
      >
        {session.visit ? (
          <span
            className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/10 font-medium text-[10px] text-primary uppercase"
            title={`@${session.visit.username}`}
          >
            {session.visit.username.slice(0, 1)}
          </span>
        ) : (
          chatAgents.length > 0 && (
            <span className="flex shrink-0 items-center">
              {chatAgents.slice(0, 4).map((member, index) => (
                // Drawn as in the chat's header, without the majordomo's crown, which is too small here.
                <span
                  key={member.id}
                  className={cn(
                    chatAgents.length > 1 &&
                      "rounded-md bg-sidebar ring-2 ring-sidebar",
                    index > 0 && "-ml-1.5",
                  )}
                >
                  <AgentIcon
                    agent={{ ...member, majordomo: false }}
                    tile={chatAgents.length > 1}
                    className={
                      chatAgents.length > 1 ? "size-5 rounded-md" : "size-4"
                    }
                  />
                </span>
              ))}
              {chatAgents.length > 4 && (
                <span className="ml-1 text-muted-foreground text-xs">
                  +{chatAgents.length - 4}
                </span>
              )}
            </span>
          )
        )}
        <span className="min-w-0 flex-1">
          {/* A long title fills the row and is cut off with an ellipsis. While the row shows its options button, it slides to reveal its end. */}
          <span
            className="block truncate transition-[--fade-left] duration-300 group-focus-within/row:text-clip group-focus-within/row:[--fade-left:1rem] group-focus-within/row:[mask-image:linear-gradient(to_right,transparent,#000_var(--fade-left),#000_calc(100%-1rem),transparent)] group-hover/row:text-clip group-hover/row:[--fade-left:1rem] group-hover/row:[mask-image:linear-gradient(to_right,transparent,#000_var(--fade-left),#000_calc(100%-1rem),transparent)]"
            data-title
          >
            <span
              className={cn(
                "whitespace-nowrap transition-transform group-focus-within/row:inline-block group-hover/row:inline-block delay-300 duration-[var(--title-duration,0s)] ease-linear group-focus-within/row:[transform:translateX(var(--title-shift,0px))] group-hover/row:[transform:translateX(var(--title-shift,0px))] motion-reduce:transition-none",
                !session.title && "italic",
              )}
            >
              {title}
            </span>
          </span>
        </span>
        {/* Working takes priority: one dot shows at a time. */}
        {session.unread && !session.busy && (
          <span
            className={cn(
              "order-first size-1.5 shrink-0 rounded-full bg-link motion-safe:animate-pulse",
            )}
            role="img"
            aria-label={t("unreadResponse")}
          />
        )}
        {session.busy && (
          <Loader2
            className="order-first size-3 shrink-0 animate-spin text-primary motion-reduce:animate-none"
            role="img"
            aria-label={t("working")}
          />
        )}
        {awaitingApproval && (
          <AwaitingApprovalMark className="order-first ml-0" />
        )}
      </Link>
      <DropdownMenu onOpenChange={() => setConfirmingDelete(false)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "-translate-y-1/2 absolute top-1/2 right-1.5 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100",
              active && "opacity-100",
            )}
            aria-label={t("chatOptions")}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          {/* Tabs show only on wider screens. */}
          <DropdownMenuItem
            className="max-md:hidden"
            onClick={() => {
              openTab(session.id);
              navigate({
                to: "/chat/$sessionId",
                params: { sessionId: session.id },
              });
            }}
          >
            <ExternalLink className="size-4" /> {t("openInNewTab")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setDraft(title);
              setRenaming(true);
            }}
          >
            <Pencil className="size-4" /> {t("rename")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={regenerate.isPending}
            onClick={() => regenerate.mutate()}
          >
            <Sparkles className="size-4" /> {t("regenerate")}
          </DropdownMenuItem>
          {!session.archived && (
            <DropdownMenuItem
              disabled={archive.isPending}
              onClick={() => archive.mutate()}
            >
              <Archive className="size-4" /> {t("archiveChat")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            disabled={deleteMutation.isPending}
            onSelect={(event) => {
              if (!confirmingDelete) {
                event.preventDefault();
                setConfirmingDelete(true);
                return;
              }
              deleteMutation.mutate();
            }}
            className="relative overflow-hidden"
          >
            <Trash2 className="size-4" />
            <span aria-hidden={confirmingDelete}>{t("deleteChat")}</span>
            {/* Slides in over Delete; the second click lands on it. */}
            {confirmingDelete && (
              <span className="absolute inset-0 flex animate-in items-center gap-2 bg-destructive px-2 text-destructive-foreground duration-300 ease-out slide-in-from-right">
                <Check className="size-4 text-destructive-foreground" />
                {t("confirmDeleteChat")}
              </span>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

// The Pim logo: an 8×4 pixel wordmark. Size it at whole multiples of 8×4 px
// (w-6 h-3, w-8 h-4, w-16 h-8) so the pixels stay crisp.
export function PimMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 8 4"
      shapeRendering="crispEdges"
      className={className}
      aria-hidden="true"
    >
      <rect x="0" y="0" width="3" height="1" fill="#e48a7a" />
      <rect x="2" y="1" width="1" height="1" fill="#e48a7a" />
      <rect x="0" y="1" width="1" height="1" fill="#4f8eb3" />
      <rect x="0" y="2" width="2" height="1" fill="#4f8eb3" />
      <rect x="0" y="3" width="1" height="1" fill="#4f8eb3" />
      <rect x="3" y="2" width="1" height="2" fill="#eab65d" />
      <rect x="4" y="1" width="4" height="1" fill="#a88cd6" />
      <rect x="5" y="2" width="1" height="2" fill="#a88cd6" />
      <rect x="7" y="2" width="1" height="2" fill="#a88cd6" />
    </svg>
  );
}
