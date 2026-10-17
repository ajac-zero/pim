import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Bell,
  Blocks,
  CalendarClock,
  Check,
  ChevronDown,
  Compass,
  MessageCircle,
  Monitor,
  Moon,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  Search,
  Settings,
  Shapes,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Sun,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { AgentSettingsDialog } from "~/components/agent-settings";
import { LanguageSelect, useI18n } from "~/components/i18n";
import { useTheme } from "~/components/theme";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
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
import { closeTab } from "~/lib/tabs";
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
          .map((approval) => approval.member?.session ?? approval.session),
      ),
    [approvals],
  );
}

/**
 * The sidebar: a rail of icons for Pim's pages beside the chats panel. With
 * the sidebar collapsed only the rail shows, and its Chats button brings the
 * panel back.
 */
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
  const awaitingApproval = useAwaitingApproval();
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
      <div className="flex h-full w-full overflow-hidden bg-sidebar text-sidebar-foreground">
        {/* Rail */}
        <nav
          aria-label={t("navigation")}
          className="flex w-16 shrink-0 flex-col items-center gap-1 bg-sidebar-accent/40 py-3"
        >
          <Link
            to="/"
            onClick={onNavigate}
            className="mb-2 flex size-10 items-center justify-center rounded-xl transition-colors hover:bg-sidebar-accent"
            aria-label="Pim"
          >
            {/* The logo is the wordmark, so no "Pim" label beside it. */}
            <PimMark className="h-4 w-8" />
          </Link>
          <RailLink
            to="/notifications"
            icon={<Bell className="size-4.5" />}
            label={t("notifications")}
            count={unreadNotifications}
            onNavigate={onNavigate}
          />
          {onToggleCollapse && (
            <RailItem
              icon={<MessageCircle className="size-4.5" />}
              label={t(collapsed ? "showChats" : "hideChats")}
              count={collapsed ? awaitingApproval.size : 0}
            >
              {(content) => (
                <button
                  type="button"
                  className={cn(
                    RAIL_ITEM_CLASS,
                    "aria-expanded:text-foreground",
                  )}
                  onClick={onToggleCollapse}
                  aria-label={t("chats")}
                  aria-expanded={!collapsed}
                >
                  {content}
                </button>
              )}
            </RailItem>
          )}
          <RailLink
            to="/artifacts"
            icon={<Shapes className="size-4.5" />}
            label={t("artifacts")}
            onNavigate={onNavigate}
          />
          <RailLink
            to="/apps"
            icon={<Blocks className="size-4.5" />}
            label={t("connectedApps")}
            onNavigate={onNavigate}
          />
          <RailLink
            to="/schedules"
            icon={<CalendarClock className="size-4.5" />}
            label={t("schedules")}
            onNavigate={onNavigate}
          />
          {account && (
            <RailLink
              to="/discover"
              icon={<Compass className="size-4.5" />}
              label={t("discover")}
              onNavigate={onNavigate}
            />
          )}
          <div className="mt-auto" />
          {account && (
            <RailLink
              to="/sharing"
              icon={<Users className="size-4.5" />}
              label={t("sharing")}
              count={guestRequests}
              onNavigate={onNavigate}
            />
          )}
          <RailLink
            to="/settings"
            icon={<Settings className="size-4.5" />}
            label={t("settings")}
            onNavigate={onNavigate}
          />
          <PreferencesMenu onNavigate={onNavigate} />
        </nav>

        {/* Chats */}
        <div
          inert={collapsed}
          className={cn(
            "flex w-64 shrink-0 flex-col transition-opacity duration-200",
            collapsed && "opacity-0",
          )}
        >
          <div className="flex items-center justify-between pt-3 pr-3 pb-1 pl-5">
            <h2 className="text-muted-foreground text-sm">{t("chats")}</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                  onClick={newChat}
                  aria-label={t("newChat")}
                >
                  <SquarePen className="size-4.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                showArrow={false}
                className={SIDEBAR_TOOLTIP_CLASS}
              >
                {t("newChat")}
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Search */}
          <div className="px-3 pt-1 pb-2">
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

          <nav
            aria-label={t("chats")}
            className="flex-1 overflow-y-auto px-3 pb-2 scrollbar-thin"
          >
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
      </div>
    </TooltipProvider>
  );
}

const RAIL_ITEM_CLASS =
  "relative flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground";

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

function RailLink({
  to,
  onNavigate,
  ...props
}: {
  to:
    | "/artifacts"
    | "/apps"
    | "/schedules"
    | "/notifications"
    | "/discover"
    | "/sharing"
    | "/settings";
  icon: ReactNode;
  label: string;
  count?: number;
  onNavigate?: () => void;
}) {
  return (
    <RailItem {...props}>
      {(content) => (
        <Link
          to={to}
          onClick={onNavigate}
          className={cn(
            RAIL_ITEM_CLASS,
            "data-[status=active]:bg-sidebar-accent data-[status=active]:text-foreground",
          )}
          aria-label={props.label}
        >
          {content}
        </Link>
      )}
    </RailItem>
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

function PreferencesMenu({ onNavigate }: { onNavigate?: () => void }) {
  const { preference, setPreference, colorTheme } = useTheme();
  const { t } = useI18n();

  return (
    <DropdownMenu>
      <RailItem
        icon={<SlidersHorizontal className="size-4.5" />}
        label={t("preferences")}
      >
        {(content) => (
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                RAIL_ITEM_CLASS,
                "data-[state=open]:bg-sidebar-accent",
              )}
              aria-label={t("preferences")}
            >
              {content}
            </button>
          </DropdownMenuTrigger>
        )}
      </RailItem>
      <DropdownMenuContent align="end" side="right" className="w-60">
        {/* Themes are many, so they're picked in Settings. */}
        <DropdownMenuItem asChild>
          <Link to="/settings" hash="appearance" onClick={onNavigate}>
            <Palette className="size-4" />
            <span className="flex-1">{t("theme")}</span>
            <span className="text-muted-foreground text-xs">
              {colorTheme?.name}
            </span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          {t("mode")}
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
