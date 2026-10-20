import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { AgentSettingsDialog } from "~/components/agent-settings";
import { useI18n } from "~/components/i18n";
import {
  Bell,
  Blocks,
  CalendarClock,
  Check,
  ChevronDown,
  Compass,
  ExternalLink,
  Folder,
  ListFilter,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
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
import {
  ArtifactsPanel,
  FilesPanel,
  NotificationsPanel,
  SchedulesPanel,
  SIDEBAR_TOOLTIP_CLASS,
  SidebarPanelHeader,
  SkillsPanel,
} from "~/components/sidebar-panels";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  type ChatView,
  flatChats,
  type InboxOrder,
  useChatListPreferences,
} from "~/lib/chat-list";
import { type Agent, pim, type Session, type Visit } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import {
  accountQuery,
  agentsQuery,
  approvalsQuery,
  extensionsQuery,
  notificationsQuery,
  profileQuery,
  sessionsQuery,
  visitsQuery,
} from "~/lib/queries";
import { CHAT_DRAG_TYPE, closeTab, openTab } from "~/lib/tabs";
import { cn } from "~/lib/utils";
import { version } from "../../../package.json";

type T = ReturnType<typeof useI18n>["t"];

/**
 * One of your agents in the sidebar, with its chats, most recent first;
 * `archived` says it has older ones, listed under Archived.
 */
type AgentSection = { agent: Agent; list: Session[]; archived: boolean };

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
  return {
    account,
    profile,
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

/** The panel the URL names: notifications, your chats, artifacts, files, skills or schedules. */
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
 * the top choose what the panel shows (notifications, your chats, artifacts,
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
            panel="artifacts"
            icon={<Shapes className="size-4.5" />}
            label={t("artifacts")}
          />
          <RailPanel
            {...railPanel}
            panel="files"
            icon={<Folder className="size-4.5" />}
            label={t("files")}
          />
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

/** Chats grouped by agent, in one inbox, or only with the majordomo. */
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
  const { data: agents } = useQuery(agentsQuery());
  const { data: account } = useQuery(accountQuery());
  const { data: visits } = useQuery({ ...visitsQuery(), enabled: !!account });
  const params = useParams({ strict: false }) as { sessionId?: string };
  const activeId = params.sessionId;
  const newChat = useNewChat(onNavigate);
  const { view, order, set } = useChatListPreferences();
  const viewLabels = {
    agents: t("agentsView"),
    inbox: t("inboxView"),
    majordomo: t("majordomoView"),
  };
  const current = useMemo(
    () => (sessions ?? []).filter((session) => !session.archived),
    [sessions],
  );
  const majordomoId = agents?.find((agent) => agent.majordomo)?.id;
  const flatView = view === "majordomo" ? "majordomo" : "inbox";
  const flat = flatChats(
    current,
    majordomoId,
    flatView,
    order,
    search,
    t("newChat"),
  );
  // Archived chats are listed apart, most recent first; visits stay under Shared with you in the agents view.
  const archived = flatChats(
    (sessions ?? []).filter(
      (session) => session.archived && !(view === "agents" && session.visit),
    ),
    majordomoId,
    flatView,
    "recent",
    search,
    t("newChat"),
  );
  const shownVisits = (visits ?? []).filter((visit) =>
    visit.username.toLowerCase().includes(search.toLowerCase()),
  );

  // A section for each of your agents, the majordomo first, holding the chats with it.
  const sections = useMemo((): AgentSection[] => {
    const all = (agents ?? []).map((agent) => ({
      agent,
      list: [] as Session[],
      archived: false,
    }));
    for (const session of sessions ?? []) {
      // Conversations with others' spaces are listed under Shared with you.
      if (session.visit) continue;
      const section =
        all.find((candidate) => candidate.agent.id === session.agent?.id) ??
        all.find((candidate) => candidate.agent.majordomo);
      if (!section) continue;
      if (session.archived) section.archived = true;
      else section.list.push(session);
    }
    return all;
  }, [agents, sessions]);
  const shownSections = useMemo(
    () =>
      sections.flatMap((section) => {
        if (!search) return [section];
        const list = section.list.filter((session) =>
          sessionTitle(session, t).toLowerCase().includes(search.toLowerCase()),
        );
        return list.length > 0 ? [{ ...section, list }] : [];
      }),
    [sections, search, t],
  );

  return (
    <>
      <SidebarPanelHeader title={t("chats")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("chatView")}
              title={`${t("chatView")}: ${viewLabels[view]}`}
              className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              <MoreHorizontal className="size-4.5 rotate-90" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={view}
              onValueChange={(value) => set({ view: value as ChatView })}
            >
              {(["agents", "inbox", "majordomo"] as const).map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {viewLabels[value]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarPanelHeader>

      {/* Search and inbox sorting share a row. */}
      <div className="flex items-center gap-2 px-3 pt-1 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchChats")}
            className="h-8 truncate border-transparent bg-sidebar-accent/60 pl-8 text-sm shadow-none focus-visible:border-sidebar-border focus-visible:bg-sidebar-accent/60 focus-visible:ring-0"
          />
        </div>
        {view === "inbox" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("sortChats")}
                title={t(order === "unread" ? "unreadFirst" : "recentActivity")}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              >
                <ListFilter className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={order}
                onValueChange={(value) => set({ order: value as InboxOrder })}
              >
                <DropdownMenuRadioItem value="recent">
                  {t("recentActivity")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="unread">
                  {t("unreadFirst")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {view !== "agents" && (
        <div className="flex justify-start px-3 pb-3">
          <Button
            variant="ghost"
            size="lg"
            className="w-full justify-start px-2 has-[>svg]:px-2"
            onClick={newChat}
          >
            <SquarePen className="size-4.5" />
            {t("newChat")}
          </Button>
        </div>
      )}

      <nav
        aria-label={t("chats")}
        className="flex-1 overflow-y-auto px-3 pb-2 scrollbar-thin"
      >
        {view === "agents" && shownVisits.length > 0 && (
          <div className="mb-3">
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              {t("sharedWithYou")}
            </div>
            <ul className="space-y-px" aria-label={t("sharedWithYou")}>
              {shownVisits.map((visit) => (
                <VisitRow
                  key={visit.ownerId}
                  visit={visit}
                  active={visit.session !== null && visit.session === activeId}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          </div>
        )}
        {view === "agents" &&
          search &&
          shownSections.length === 0 &&
          shownVisits.length === 0 &&
          archived.length === 0 && (
            <p className="px-2 py-6 text-center text-muted-foreground text-sm">
              {t("noChatsMatch")}
            </p>
          )}
        {view === "agents" ? (
          shownSections.map((section) => (
            <AgentSectionList
              key={section.agent.id}
              section={section}
              activeId={activeId}
              awaitingApproval={awaitingApproval}
              onNavigate={onNavigate}
            />
          ))
        ) : flat.length === 0 ? (
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
          <ul className="space-y-px">
            {flat.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === activeId}
                awaitingApproval={awaitingApproval.has(session.id)}
                onNavigate={onNavigate}
                showAgent={view === "inbox"}
              />
            ))}
          </ul>
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
        {view === "agents" && (
          <AgentSettingsDialog>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-muted-foreground text-xs hover:bg-sidebar-accent hover:text-foreground"
            >
              <Plus className="size-3.5" /> {t("newAgent")}
            </button>
          </AgentSettingsDialog>
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

/** An agent's name, settings, new-chat button, and chats. */
function AgentSectionList({
  section: { agent, list, archived },
  activeId,
  awaitingApproval,
  onNavigate,
}: {
  section: AgentSection;
  activeId?: string;
  awaitingApproval: ReadonlySet<string>;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const optionsTrigger = useRef<HTMLButtonElement>(null);
  return (
    <section className="mb-3" aria-label={agent.name}>
      <div className="group/section flex items-center gap-1 pr-1">
        <span className="flex min-w-0 flex-1 items-center">
          <span className="flex min-w-0 items-center gap-1 px-2 py-1.5 font-medium text-muted-foreground text-xs">
            <AgentIcon agent={agent} className="size-4" />
            <span className="truncate">{agent.name}</span>
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={t(open ? "hideChatsOf" : "showChatsOf", {
              name: agent.name,
            })}
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                !open && "-rotate-90",
              )}
            />
          </button>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              ref={optionsTrigger}
              type="button"
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              aria-label={t("agentOptions", { name: agent.name })}
              title={t("agentOptions", { name: agent.name })}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="bottom"
            onCloseAutoFocus={(event) => {
              if (settingsOpen) event.preventDefault();
            }}
          >
            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
              <Settings className="size-4" /> {t("settings")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AgentSettingsDialog
          agent={agent}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            optionsTrigger.current?.focus();
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={() => {
                navigate({
                  to: "/agents/$agentId",
                  params: { agentId: agent.id },
                });
                onNavigate?.();
              }}
              aria-label={t("newChatWith", { name: agent.name })}
            >
              <SquarePen className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="right"
            showArrow={false}
            className={SIDEBAR_TOOLTIP_CLASS}
          >
            {t("newChatWith", { name: agent.name })}
          </TooltipContent>
        </Tooltip>
      </div>
      {open &&
        (list.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground text-xs">
            {t(archived ? "noRecentChats" : "noChatsYet")}
          </p>
        ) : (
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
        ))}
    </section>
  );
}

/**
 * Chats with no activity for two days, folded away below the others. It
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
              showAgent
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Someone else's space, shared with you: opens your conversation with it, started on first use. */
function VisitRow({
  visit,
  active,
  onNavigate,
}: {
  visit: Visit;
  active: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const open = useMutation({
    mutationFn: async () =>
      visit.session ?? (await pim.startVisit(visit.username)).session,
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["visits"] });
      navigate({ to: "/chat/$sessionId", params: { sessionId: session } });
      onNavigate?.();
    },
    onError: (error) => toast.error(error.message),
  });
  // Taken back: the conversation stays readable; there's nothing to start.
  const disabled = open.isPending || (!visit.available && !visit.session);
  return (
    <li>
      <button
        type="button"
        onClick={() => open.mutate()}
        disabled={disabled}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors hover:bg-sidebar-accent disabled:opacity-60",
          active && "bg-sidebar-accent",
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-medium text-[11px] text-primary uppercase">
          {visit.username.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {t("visitPim", { username: visit.username })}
        </span>
        {!visit.available && (
          <span className="shrink-0 text-muted-foreground text-xs">
            {t("visitUnavailable")}
          </span>
        )}
      </button>
    </li>
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

function SessionRow({
  session,
  active,
  awaitingApproval,
  onNavigate,
  showAgent = false,
}: {
  session: Session;
  active: boolean;
  awaitingApproval: boolean;
  onNavigate?: () => void;
  showAgent?: boolean;
}) {
  const { t } = useI18n();
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
          "flex items-center gap-2 rounded-lg px-2 py-2 pr-8 text-sm transition-colors hover:bg-sidebar-accent",
          active && "bg-sidebar-accent",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate", !session.title && "italic")}>
            {title}
          </span>
          {showAgent && (
            <span className="block truncate text-muted-foreground text-xs">
              {session.visit
                ? `@${session.visit.username}`
                : session.agent?.name}
            </span>
          )}
        </span>
        {session.unread && (
          <span
            className={cn(
              "order-first size-1.5 shrink-0 rounded-full bg-link",
              showAgent && "motion-safe:animate-pulse",
            )}
            role="img"
            aria-label={t("unreadResponse")}
          />
        )}
        {session.busy && (
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
            role="img"
            aria-label={t("working")}
          />
        )}
        {awaitingApproval && <AwaitingApprovalMark />}
      </Link>
      <DropdownMenu onOpenChange={() => setConfirmingDelete(false)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "-translate-y-1/2 absolute top-1/2 right-1.5 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100",
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
