import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Bell,
  Check,
  ChevronDown,
  Compass,
  MessageCircle,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  Shapes,
  ShieldCheck,
  SlidersHorizontal,
  SquarePen,
  Sun,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon, PimMark } from "~/components/agent-icon";
import { AgentSettingsDialog } from "~/components/agent-settings";
import { LanguageSelect, useI18n } from "~/components/i18n";
import { useTheme } from "~/components/theme";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { type Agent, pim, type Session, type Visit } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import {
  accountQuery,
  agentsQuery,
  approvalsQuery,
  notificationsQuery,
  sessionsQuery,
  visitsQuery,
} from "~/lib/queries";
import { cn } from "~/lib/utils";

type T = ReturnType<typeof useI18n>["t"];

/** One of your agents in the sidebar, with its chats, most recent first. */
type AgentSection = { agent: Agent; list: Session[] };

export function sessionTitle(session: Pick<Session, "title">, t: T) {
  return session.title ?? t("newChat");
}

const SIDEBAR_TOOLTIP_CLASS =
  "rounded-md border border-sidebar-border bg-sidebar px-2.5 py-1.5 font-normal text-xs text-sidebar-foreground shadow-md";

/** Opens an empty draft; the session is created when its first message is sent. */
export function useNewChat(onDone?: () => void) {
  const navigate = useNavigate();
  return () => {
    navigate({ to: "/new" });
    onDone?.();
  };
}

export function AppSidebar({
  onNavigate,
  collapsed = false,
  onToggleCollapse,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const { data: sessions } = useQuery(sessionsQuery());
  const { data: agents } = useQuery(agentsQuery());
  const { data: approvals } = useQuery(approvalsQuery());
  const { data: notifications } = useQuery(notificationsQuery());
  // Sharing and Discover are with the other people on this Pim.
  const { data: account } = useQuery(accountQuery());
  const { data: visits } = useQuery({ ...visitsQuery(), enabled: !!account });
  const params = useParams({ strict: false }) as { sessionId?: string };
  const activeId = params.sessionId;
  const newChat = useNewChat(onNavigate);

  /* Chats with an action waiting for the user's approval. */
  const awaitingApproval = useMemo(
    () =>
      new Set(
        approvals
          ?.filter(
            (approval) =>
              approval.status === "pending" && !approval.requestedBy,
          )
          .map((approval) => approval.member?.session ?? approval.session),
      ),
    [approvals],
  );
  /* Requests from people in your circles, waiting on the Sharing page. */
  const guestRequests =
    approvals?.filter(
      (approval) => approval.status === "pending" && approval.requestedBy,
    ).length ?? 0;
  const shownVisits = (visits ?? []).filter((visit) =>
    visit.username.toLowerCase().includes(search.toLowerCase()),
  );
  const unreadNotifications =
    notifications?.filter((notification) => notification.readAt === null)
      .length ?? 0;

  // A section for each of your agents, the default one first, holding the chats with it.
  const sections = useMemo((): AgentSection[] => {
    const all = (agents ?? []).map((agent) => ({
      agent,
      list: [] as Session[],
    }));
    for (const session of sessions ?? []) {
      // Conversations with others' Pims are listed under Shared with you.
      if (session.visit) continue;
      const section =
        all.find((candidate) => candidate.agent.id === session.agent?.id) ??
        all.find((candidate) => candidate.agent.default);
      section?.list.push(session);
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
    <TooltipProvider delayDuration={0}>
      <div className="flex h-full w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
        {/* Header */}
        <div className="flex items-center gap-1 px-3 pt-3 pb-1">
          <SidebarLogoToggle
            collapsed={collapsed}
            onNavigate={onNavigate}
            onToggleCollapse={onToggleCollapse}
          />
          {onToggleCollapse && (
            <div
              className={cn(
                "shrink-0 overflow-hidden transition-[max-width,opacity] duration-200",
                collapsed ? "max-w-0 opacity-0" : "max-w-10 opacity-100",
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent"
                    onClick={onToggleCollapse}
                    aria-label={t("collapseSidebar")}
                    tabIndex={collapsed ? -1 : 0}
                  >
                    <PanelLeft className="size-4.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  sideOffset={20}
                  showArrow={false}
                  className={SIDEBAR_TOOLTIP_CLASS}
                >
                  {t("collapseSidebar")}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-0.5 px-3 py-2">
          <SidebarItem
            icon={<SquarePen className="size-4.5 shrink-0" />}
            label={t("newChat")}
            collapsed={collapsed}
          >
            {(content) => (
              <button
                type="button"
                className={ITEM_CLASS(collapsed)}
                onClick={newChat}
                aria-label={t("newChat")}
              >
                {content}
              </button>
            )}
          </SidebarItem>
          <SidebarNavItem
            to="/artifacts"
            icon={<Shapes className="size-4.5 shrink-0" />}
            label={t("artifacts")}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
          <SidebarNavItem
            to="/notifications"
            icon={<Bell className="size-4.5 shrink-0" />}
            label={t("notifications")}
            count={unreadNotifications}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
          {account && (
            <SidebarNavItem
              to="/discover"
              icon={<Compass className="size-4.5 shrink-0" />}
              label={t("discover")}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          )}
          {account && (
            <SidebarNavItem
              to="/sharing"
              icon={<Users className="size-4.5 shrink-0" />}
              label={t("sharing")}
              count={guestRequests}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          )}
          <SidebarNavItem
            to="/settings"
            icon={<Settings className="size-4.5 shrink-0" />}
            label={t("settings")}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
          <div
            inert={!collapsed}
            className={cn(
              "max-h-0 overflow-hidden opacity-0 transition-[max-height,opacity] duration-0",
              collapsed &&
                "max-h-9 opacity-100 delay-200 duration-150 ease-out",
            )}
          >
            <CollapsedChatsMenu
              sections={sections}
              activeId={activeId}
              awaitingApproval={awaitingApproval}
              onNavigate={onNavigate}
            />
          </div>
        </div>

        {/* Search */}
        <div
          className={cn(
            "overflow-hidden px-3 transition-[max-height,opacity] duration-200",
            collapsed ? "max-h-0 opacity-0" : "max-h-12 pb-2 opacity-100",
          )}
        >
          <div className="relative">
            <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchChats")}
              className="h-8 border-transparent bg-sidebar-accent/60 pl-8 text-sm shadow-none focus-visible:border-sidebar-border focus-visible:bg-sidebar-accent/60 focus-visible:ring-0"
            />
          </div>
        </div>

        {/* Sessions */}
        <div
          className={cn(
            "flex-1 overflow-hidden transition-opacity duration-200",
            collapsed && "pointer-events-none opacity-0",
          )}
        >
          <nav className="h-full overflow-y-auto px-3 pb-2 scrollbar-thin">
            {shownVisits.length > 0 && (
              <div className="mb-3">
                <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                  {t("sharedWithYou")}
                </div>
                <ul className="space-y-px" aria-label={t("sharedWithYou")}>
                  {shownVisits.map((visit) => (
                    <VisitRow
                      key={visit.ownerId}
                      visit={visit}
                      active={
                        visit.session !== null && visit.session === activeId
                      }
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              </div>
            )}
            {search &&
              shownSections.length === 0 &&
              shownVisits.length === 0 && (
                <p className="px-2 py-6 text-center text-muted-foreground text-sm">
                  {t("noChatsMatch")}
                </p>
              )}
            {shownSections.map((section) => (
              <AgentSectionList
                key={section.agent.id}
                section={section}
                activeId={activeId}
                awaitingApproval={awaitingApproval}
                onNavigate={onNavigate}
              />
            ))}
            <AgentSettingsDialog>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-muted-foreground text-xs hover:bg-sidebar-accent hover:text-foreground"
              >
                <Plus className="size-3.5" /> {t("newAgent")}
              </button>
            </AgentSettingsDialog>
          </nav>
        </div>

        {/* Preferences */}
        <div className="border-sidebar-border border-t p-3">
          <PreferencesMenu collapsed={collapsed} />
        </div>
      </div>
    </TooltipProvider>
  );
}

const ITEM_CLASS = (collapsed: boolean) =>
  cn(
    "flex h-9 w-full items-center overflow-hidden rounded-lg text-sm transition-colors hover:bg-sidebar-accent",
    !collapsed && "gap-2.5",
  );

/** An icon, a label that hides when collapsed, and a tooltip in its place. */
function SidebarItem({
  icon,
  label,
  count = 0,
  collapsed,
  children,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  collapsed: boolean;
  children: (content: ReactNode) => ReactNode;
}) {
  const content = (
    <>
      <span className="relative flex h-9 w-10 shrink-0 items-center justify-center">
        {icon}
        {count > 0 && collapsed && (
          <span className="absolute top-1.5 right-2 size-2 rounded-full bg-primary" />
        )}
      </span>
      <span
        className={cn(
          "flex-1 truncate text-left transition-[max-width,opacity] duration-200",
          collapsed ? "max-w-0 opacity-0" : "max-w-[200px] opacity-100",
        )}
      >
        {label}
      </span>
      {count > 0 && !collapsed && (
        <span className="mr-2 rounded-full bg-primary px-1.5 py-px font-medium text-[11px] text-primary-foreground tabular-nums">
          {count}
        </span>
      )}
    </>
  );
  const item = children(content);
  if (!collapsed) return item;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={20}
        showArrow={false}
        className={SIDEBAR_TOOLTIP_CLASS}
      >
        {count > 0 ? `${label} (${count})` : label}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarNavItem({
  to,
  onNavigate,
  ...props
}: {
  to: "/artifacts" | "/notifications" | "/discover" | "/sharing" | "/settings";
  icon: ReactNode;
  label: string;
  count?: number;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <SidebarItem {...props}>
      {(content) => (
        <Link
          to={to}
          onClick={onNavigate}
          activeProps={{ className: "bg-sidebar-accent" }}
          className={ITEM_CLASS(props.collapsed)}
          aria-label={props.label}
        >
          {content}
        </Link>
      )}
    </SidebarItem>
  );
}

/** An agent's dashboard, settings, new-chat button, and chats. */
function AgentSectionList({
  section: { agent, list },
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
          <Link
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
            onClick={onNavigate}
            className="min-w-0 truncate rounded-md px-2 py-1.5 font-medium text-muted-foreground text-xs hover:text-foreground"
            activeProps={{ className: "bg-sidebar-accent text-foreground" }}
            title={t("agentDashboard", { name: agent.name })}
          >
            <span className="flex items-center gap-1">
              <AgentIcon agent={agent} className="size-4" />
              <span className="truncate">{agent.name}</span>
            </span>
          </Link>
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
                  to: "/new",
                  search: agent.default ? {} : { agent: agent.id },
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
            {t("noChatsYet")}
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

function CollapsedChatsMenu({
  sections,
  activeId,
  awaitingApproval,
  onNavigate,
}: {
  sections: AgentSection[];
  activeId?: string;
  awaitingApproval: ReadonlySet<string>;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const trigger = (
    <button
      type="button"
      className="relative flex h-9 w-full items-center justify-center rounded-lg text-sm transition-colors hover:bg-sidebar-accent"
      aria-label={t("chats")}
    >
      <MessageCircle className="size-4.5" />
      {awaitingApproval.size > 0 && (
        <span className="absolute top-1.5 right-2 size-2 rounded-full bg-primary" />
      )}
    </button>
  );

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          sideOffset={20}
          showArrow={false}
          className={SIDEBAR_TOOLTIP_CLASS}
        >
          {t("chats")}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="right"
        className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-64"
      >
        {sections.every((section) => section.list.length === 0) ? (
          <DropdownMenuItem disabled>{t("noChatsYet")}</DropdownMenuItem>
        ) : (
          sections.map((section) => (
            <DropdownMenuGroup key={section.agent.id}>
              <DropdownMenuLabel className="flex items-center gap-1.5 truncate text-muted-foreground text-xs">
                <AgentIcon agent={section.agent} className="size-4" />
                {section.agent.name}
              </DropdownMenuLabel>
              {section.list.map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  className={cn(
                    "cursor-pointer truncate",
                    session.id === activeId && "bg-accent",
                  )}
                  onSelect={() => {
                    navigate({
                      to: "/chat/$sessionId",
                      params: { sessionId: session.id },
                    });
                    onNavigate?.();
                  }}
                >
                  <span className="truncate">{sessionTitle(session, t)}</span>
                  {awaitingApproval.has(session.id) && <AwaitingApprovalMark />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarLogoToggle({
  collapsed,
  onNavigate,
  onToggleCollapse,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const content = (
    <Link
      to="/"
      onClick={(e) => {
        if (collapsed && onToggleCollapse) {
          e.preventDefault();
          onToggleCollapse();
        } else {
          onNavigate?.();
        }
      }}
      className={cn(
        "group flex h-9 min-w-0 flex-1 items-center overflow-hidden rounded-lg transition-colors hover:bg-sidebar-accent",
        !collapsed && "gap-2",
      )}
      aria-label={collapsed ? t("expandSidebar") : "Pim"}
    >
      <span className="relative flex h-9 w-10 shrink-0 items-center justify-center">
        <span
          className={cn(
            "flex items-center justify-center transition-opacity",
            collapsed && "group-hover:opacity-0",
          )}
        >
          <PimMark className="size-6" />
        </span>
        {collapsed && (
          <PanelLeft className="absolute inset-0 m-auto size-4.5 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </span>
      <span
        className={cn(
          "truncate font-semibold text-[15px] transition-[max-width,opacity] duration-200",
          collapsed ? "max-w-0 opacity-0" : "max-w-[160px] opacity-100",
        )}
      >
        Pim
      </span>
    </Link>
  );

  if (!collapsed) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={20}
        showArrow={false}
        className={SIDEBAR_TOOLTIP_CLASS}
      >
        {t("expandSidebar")}
      </TooltipContent>
    </Tooltip>
  );
}

/** Someone else's Pim, shared with you: opens your conversation with it, started on first use. */
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
function AwaitingApprovalMark() {
  const { t } = useI18n();
  return (
    <ShieldCheck
      className="ml-auto size-3.5 shrink-0 text-primary"
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
}: {
  session: Session;
  active: boolean;
  awaitingApproval: boolean;
  onNavigate?: () => void;
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

  const navigate = useNavigate();
  // Delete asks twice: the first click turns the item into a confirmation.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: () => pim.deleteSession(session.id),
    onSuccess: async () => {
      if (pimClient.getState().session === session.id) pimClient.close();
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      if (active) await navigate({ to: "/" });
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
        className={cn(
          "flex items-center gap-2 rounded-lg px-2 py-2 pr-8 text-sm transition-colors hover:bg-sidebar-accent",
          active && "bg-sidebar-accent",
        )}
      >
        <span className={cn("truncate", !session.title && "italic")}>
          {title}
        </span>
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
              "-translate-y-1/2 absolute top-1/2 right-1.5 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus:opacity-100 group-hover/row:opacity-100",
              active && "opacity-100",
            )}
            aria-label={t("chatOptions")}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem
            onClick={() => {
              setDraft(title);
              setRenaming(true);
            }}
          >
            <Pencil className="size-4" /> {t("rename")}
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

function PreferencesMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { preference, setPreference } = useTheme();
  const { t } = useI18n();

  const trigger = (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full items-center overflow-hidden rounded-lg text-left text-sm transition-colors hover:bg-sidebar-accent",
        !collapsed && "gap-2.5",
      )}
      aria-label={t("preferences")}
    >
      <span className="flex h-9 w-10 shrink-0 items-center justify-center">
        <SlidersHorizontal className="size-4.5" />
      </span>
      <span
        className={cn(
          "truncate transition-[max-width,opacity] duration-200",
          collapsed ? "max-w-0 opacity-0" : "max-w-[180px] opacity-100",
        )}
      >
        {t("preferences")}
      </span>
    </button>
  );

  return (
    <DropdownMenu>
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent
            side="right"
            sideOffset={20}
            showArrow={false}
            className={SIDEBAR_TOOLTIP_CLASS}
          >
            {t("preferences")}
          </TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          {t("theme")}
        </DropdownMenuLabel>
        <div className="flex gap-1 px-2 pb-1.5">
          {(
            [
              ["light", Sun],
              ["dark", Moon],
              ["system", Monitor],
            ] as const
          ).map(([value, Icon]) => (
            <Button
              key={value}
              variant={preference === value ? "secondary" : "ghost"}
              size="icon"
              className="size-8 flex-1"
              onClick={() => setPreference(value)}
              aria-label={t(`${value}Theme`)}
            >
              <Icon className="size-4" />
            </Button>
          ))}
        </div>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <LanguageSelect className="block w-full" />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
