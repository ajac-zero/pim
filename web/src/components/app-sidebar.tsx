import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Bell,
  Brain,
  Check,
  MessageCircle,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquarePen,
  Sun,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { LanguageSelect, useI18n } from "~/components/i18n";
import { useShowReasoning } from "~/components/reasoning-preference";
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
import { Switch } from "~/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { pim, type Session } from "~/lib/pim-api";
import {
  approvalsQuery,
  notificationsQuery,
  sessionsQuery,
} from "~/lib/queries";
import { cn } from "~/lib/utils";

type T = ReturnType<typeof useI18n>["t"];

function groupLabel(time: number | null, t: T): string {
  if (time === null) return t("older");
  const date = new Date(time);
  const now = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.floor(
    (startOfDay(now) - startOfDay(date)) / 86_400_000,
  );
  if (diffDays <= 0) return t("today");
  if (diffDays === 1) return t("yesterday");
  if (diffDays < 7) return t("previous7Days");
  if (diffDays < 30) return t("previous30Days");
  return t("older");
}

export function sessionTitle(session: Pick<Session, "title">, t: T) {
  return session.title ?? t("newChat");
}

const SIDEBAR_TOOLTIP_CLASS =
  "rounded-md border border-sidebar-border bg-sidebar px-2.5 py-1.5 font-normal text-xs text-sidebar-foreground shadow-md";

/** Creates a session and opens it. */
export function useNewChat(onDone?: () => void) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => pim.createSession(),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate({
        to: "/chat/$sessionId",
        params: { sessionId: session.id },
      });
      onDone?.();
    },
    onError: (error) => toast.error(error.message),
  });
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
  const { data: approvals } = useQuery(approvalsQuery());
  const { data: notifications } = useQuery(notificationsQuery());
  const params = useParams({ strict: false }) as { sessionId?: string };
  const activeId = params.sessionId;
  const newChat = useNewChat(onNavigate);

  /* Chats with an action waiting for the user's approval. */
  const awaitingApproval = useMemo(
    () =>
      new Set(
        approvals
          ?.filter((approval) => approval.status === "pending")
          .map((approval) => approval.session),
      ),
    [approvals],
  );
  const unreadNotifications =
    notifications?.filter((notification) => notification.readAt === null)
      .length ?? 0;

  const sessionGroups = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of sessions ?? []) {
      const label = groupLabel(session.updatedAt, t);
      const list = map.get(label) ?? [];
      list.push(session);
      map.set(label, list);
    }
    return [
      t("today"),
      t("yesterday"),
      t("previous7Days"),
      t("previous30Days"),
      t("older"),
    ].flatMap((label) => {
      const list = map.get(label);
      return list ? [{ label, list }] : [];
    });
  }, [sessions, t]);
  const groups = useMemo(
    () =>
      sessionGroups.flatMap((group) => {
        const list = group.list.filter((session) =>
          sessionTitle(session, t).toLowerCase().includes(search.toLowerCase()),
        );
        return list.length > 0 ? [{ ...group, list }] : [];
      }),
    [sessionGroups, search, t],
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
                onClick={() => newChat.mutate()}
                disabled={newChat.isPending}
                aria-label={t("newChat")}
              >
                {content}
              </button>
            )}
          </SidebarItem>
          <SidebarNavItem
            to="/notifications"
            icon={<Bell className="size-4.5 shrink-0" />}
            label={t("notifications")}
            count={unreadNotifications}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
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
              groups={sessionGroups}
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
            {sessions && groups.length === 0 && (
              <p className="px-2 py-6 text-center text-muted-foreground text-sm">
                {search ? t("noChatsMatch") : t("noChatsYet")}
              </p>
            )}
            {groups.map((group) => (
              <div key={group.label} className="mb-3">
                <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                  {group.label}
                </div>
                <ul className="space-y-px">
                  {group.list.map((session) => (
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
            ))}
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
  to: "/notifications" | "/settings";
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

function CollapsedChatsMenu({
  groups,
  activeId,
  awaitingApproval,
  onNavigate,
}: {
  groups: Array<{ label: string; list: Session[] }>;
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
        {groups.length === 0 ? (
          <DropdownMenuItem disabled>{t("noChatsYet")}</DropdownMenuItem>
        ) : (
          groups.map((group) => (
            <DropdownMenuGroup key={group.label}>
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                {group.label}
              </DropdownMenuLabel>
              {group.list.map((session) => (
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
      <DropdownMenu>
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
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function PreferencesMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { preference, setPreference } = useTheme();
  const { showReasoning, setShowReasoning } = useShowReasoning();
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
        <DropdownMenuSeparator />
        <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm">
          <Brain className="size-4 text-muted-foreground" />
          <span className="flex-1">{t("showReasoning")}</span>
          <Switch checked={showReasoning} onCheckedChange={setShowReasoning} />
        </label>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PimMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path
        d="M11 23V9h6a4.5 4.5 0 0 1 0 9h-6"
        className="stroke-primary-foreground"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="21.5" cy="22" r="1.5" className="fill-primary-foreground" />
    </svg>
  );
}
