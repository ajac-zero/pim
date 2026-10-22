import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Outlet,
  retainSearchParams,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import {
  AppSidebar,
  SIDEBAR_PANELS,
  type SidebarPanel,
  SidebarPanelContent,
  sessionTitle,
  useAwaitingApproval,
} from "~/components/app-sidebar";
import { AppsDialog } from "~/components/apps-dialog";
import { ChatLinkMenu } from "~/components/chat/chat-link";
import { CopyConversation } from "~/components/chat/copy-conversation";
import { SummaryToggle } from "~/components/chat/summary";
import { CommandPalette } from "~/components/command-palette";
import { DiscoverDialog } from "~/components/discover-dialog";
import { I18nProvider, useI18n } from "~/components/i18n";
import { MeetMajordomo } from "~/components/majordomo-setup";
import { MobileNav } from "~/components/mobile-nav";
import { RouteError } from "~/components/route-error";
import {
  SETTINGS_TABS,
  SettingsDialog,
  type SettingsTab,
} from "~/components/settings-dialog";
import { SharingDialog } from "~/components/sharing-dialog";
import { SignIn } from "~/components/sign-in";
import { ThemeProvider } from "~/components/theme";
import { ResizeHandle, useStoredSize } from "~/components/ui/resize-handle";
import { Toaster } from "~/components/ui/sonner";
import { TooltipProvider } from "~/components/ui/tooltip";
import { authSessionQuery } from "~/lib/auth";
import { pimClient } from "~/lib/pim-client";
import { pushEnabled, pushSupported } from "~/lib/push";
import { agentsQuery, majordomoQuery, sessionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

export interface RouterContext {
  queryClient: QueryClient;
}

const DIALOGS = ["settings", "sharing", "discover", "apps"] as const;
type AppDialog = (typeof DIALOGS)[number];

/**
 * Settings, Sharing, Discover and Apps open as dialogs over any page, named
 * in the URL so links and redirects can open them: `?dialog=settings&tab=model`.
 * What the sidebar shows is in the URL too (`?panel=artifacts`), and stays
 * as you move between chats.
 */
type AppSearch = {
  dialog?: AppDialog;
  tab?: SettingsTab;
  panel?: SidebarPanel;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: (search: Record<string, unknown>): AppSearch => ({
    ...(DIALOGS.includes(search.dialog as AppDialog) && {
      dialog: search.dialog as AppDialog,
    }),
    ...(SETTINGS_TABS.includes(search.tab as SettingsTab) && {
      tab: search.tab as SettingsTab,
    }),
    ...(SIDEBAR_PANELS.includes(search.panel as SidebarPanel) && {
      panel: search.panel as SidebarPanel,
    }),
  }),
  search: { middlewares: [retainSearchParams(["panel"])] },
  component: Root,
});

function Root() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // Letting an MCP client in is a page of its own, between the client and the person,
  // and so is taking the agents' browser over.
  const alone = pathname === "/authorize" || pathname === "/browser";
  return (
    <I18nProvider>
      <ThemeProvider>
        {/* A chat's public link is for anyone, signed in or not. */}
        {pathname.startsWith("/shared/") ? (
          <Outlet />
        ) : (
          <SignedIn>
            {alone ? (
              <Outlet />
            ) : (
              <Introduced>
                <AppLayout />
              </Introduced>
            )}
          </SignedIn>
        )}
        <Toaster position="top-center" />
      </ThemeProvider>
    </I18nProvider>
  );
}

/** The app once this browser is signed in; the sign-in screen until then. */
function SignedIn({ children }: { children: ReactNode }) {
  const { data, error, refetch } = useQuery(authSessionQuery());
  const queryClient = useQueryClient();
  const signedOut = data?.signedIn === false;
  // Reconcile this device on opening or returning to Pim, not just in Settings.
  useQuery({
    queryKey: ["push"],
    queryFn: pushEnabled,
    enabled: data?.signedIn === true && pushSupported(),
  });
  // An open socket would keep streaming after signing out. The sign-in screen takes the
  // app's place, which unmounts every artifact frame; what was read of artifacts goes too.
  useEffect(() => {
    if (!signedOut) return;
    pimClient.close();
    queryClient.removeQueries({ queryKey: ["artifacts"] });
  }, [signedOut, queryClient]);
  if (error) {
    return (
      <div className="flex h-svh">
        <RouteError error={error} reset={() => refetch()} />
      </div>
    );
  }
  if (!data) return null;
  if (!data.signedIn) return <SignIn session={data} />;
  return children;
}

/** The app once the person has named their majordomo; naming it until then, the first time they sign in. */
function Introduced({ children }: { children: ReactNode }) {
  const { data, error, refetch } = useQuery(majordomoQuery());
  if (error) {
    return (
      <div className="flex h-svh">
        <RouteError error={error} reset={() => refetch()} />
      </div>
    );
  }
  if (!data) return null;
  if (!data.introduced) return <MeetMajordomo majordomo={data.agent} />;
  return children;
}

/** Live updates from Pim's socket refresh the lists and raise toasts. */
function usePimEvents() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };

  useEffect(() => {
    pimClient.handlers = {
      onActivity: () => {
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
        // A run may have changed what a dashboard shows: goals, schedules, memories, artifacts.
        queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        queryClient.invalidateQueries({ queryKey: ["schedules"] });
        // Or made an agent, saved a skill, written files, or used the browser.
        queryClient.invalidateQueries({ queryKey: ["agents"] });
        queryClient.invalidateQueries({ queryKey: ["files"] });
        queryClient.invalidateQueries({ queryKey: ["browser"] });
        queryClient.invalidateQueries({ queryKey: ["skills"] });
      },
      onNotification: (notification) => {
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        toast(notification.title, {
          icon: notification.agent ? (
            <AgentIcon agent={notification.agent} tile className="size-5" />
          ) : (
            <img src="/icon-192.png" alt="" className="size-5 rounded-sm" />
          ),
          description: notification.body,
          action: {
            label: t("view"),
            onClick: () =>
              navigate({
                to: ".",
                search: (prev) => ({ ...prev, panel: "notifications" }),
              }),
          },
        });
      },
      onSessions: () => {
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
      },
      onTasks: (session) => {
        queryClient.invalidateQueries({ queryKey: ["tasks", session] });
      },
      onComputer: () => {
        queryClient.invalidateQueries({ queryKey: ["computer"] });
        queryClient.invalidateQueries({ queryKey: ["files"] });
      },
      onVisits: () => {
        queryClient.invalidateQueries({ queryKey: ["visits"] });
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
      },
      onApproval: (approval) => {
        queryClient.invalidateQueries({ queryKey: ["approvals"] });
        if (approval.action === "file_delete" && approval.status === "approved")
          queryClient.invalidateQueries({ queryKey: ["files"] });
        if (
          (approval.action === "rename_agent" ||
            approval.action === "manage_apps") &&
          approval.status === "approved"
        ) {
          queryClient.invalidateQueries({ queryKey: ["agents"] });
          queryClient.invalidateQueries({ queryKey: ["sessions"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          if (approval.action === "manage_apps")
            queryClient.invalidateQueries({ queryKey: ["apps"] });
        }
        if (
          approval.action === "write_skill" &&
          approval.status === "approved"
        ) {
          queryClient.invalidateQueries({ queryKey: ["skills"] });
          queryClient.invalidateQueries({ queryKey: ["agents"] });
        }
        if (approval.requestedBy) {
          // Someone in a circle asked: their request waits in Sharing.
          queryClient.invalidateQueries({ queryKey: ["guest-activity"] });
          queryClient.invalidateQueries({ queryKey: ["notifications"] });
          if (approval.status !== "pending") return;
          toast(
            t("guestAsked", {
              username: approval.requestedBy.username,
              circle: approval.requestedBy.circleName,
            }),
            {
              description: approval.summary,
              action: {
                label: t("review"),
                onClick: () =>
                  navigate({
                    to: ".",
                    search: (prev) => ({ ...prev, dialog: "sharing" }),
                  }),
              },
            },
          );
          return;
        }
        // The open chat shows it inline; elsewhere, point to its chat (for a team member, the chat it works for).
        // Nothing to ask yet while the majordomo decides it.
        const chat = approval.member?.session ?? approval.session;
        if (
          chat === null ||
          approval.status !== "pending" ||
          approval.review?.status === "reviewing" ||
          chat === sessionId
        ) {
          return;
        }
        toast(t("approvalRequested"), {
          description: approval.review?.note
            ? `${approval.summary}\n${approval.review.note}`
            : approval.summary,
          action: {
            label: t("review"),
            onClick: () =>
              navigate({
                to: "/chat/$sessionId",
                params: { sessionId: chat },
              }),
          },
        });
      },
    };
    return () => {
      pimClient.handlers = {};
    };
  }, [queryClient, navigate, t, sessionId]);
}

/** The open chat's title, or the app's name elsewhere. */
function MobileTitle() {
  const { t } = useI18n();
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const { data: sessions } = useQuery(sessionsQuery());
  const { data: agents } = useQuery(agentsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const agent =
    session && !session.visit
      ? agents?.find((agent) =>
          session.agent ? agent.id === session.agent.id : agent.majordomo,
        )
      : undefined;
  return (
    <span className="flex min-w-0 items-center gap-2 text-[15px]">
      {agent && (
        <AgentIcon agent={agent} tile className="size-6 shrink-0 rounded-md" />
      )}
      <span className="truncate">
        {session ? sessionTitle(session, t) : "Pim"}
      </span>
    </span>
  );
}

/**
 * The sidebar beside the page on wider screens. On narrow ones a bar along
 * the bottom takes its place, always there like the rail, and its lists fill
 * the screen over the page.
 */
/** The desktop sidebar's width in pixels, rail included, which the person can drag. */
const SIDEBAR_WIDTH = { default: 320, min: 256, max: 480 };

function AppLayout() {
  const { t } = useI18n();
  const { panel } = Route.useSearch();
  // Collapsing hides the panel the sidebar was showing; showing another opens it again.
  const [collapsedOn, setCollapsedOn] = useState<string | null>(null);
  const sidebarCollapsed = collapsedOn === (panel ?? "chats");
  const [sidebarWidth, setSidebarWidth] = useStoredSize(
    "pim-sidebar-width",
    SIDEBAR_WIDTH.default,
  );
  const sidebar = useRef<HTMLElement>(null);
  const [listOpen, setListOpen] = useState(false);
  // Anything that shows another panel, such as a notification's View, shows its list.
  const [listedPanel, setListedPanel] = useState(panel);
  if (listedPanel !== panel) {
    setListedPanel(panel);
    setListOpen(true);
  }
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const inChat = useRouterState({
    select: (state) => state.location.pathname.startsWith("/chat/"),
  });
  const awaitingApproval = useAwaitingApproval();
  usePimEvents();

  return (
    <div className="flex h-svh w-full overflow-hidden">
      {/* As wide as the person last made it */}
      <div className="relative hidden shrink-0 md:flex">
        <aside
          ref={sidebar}
          style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
          className={cn(
            "shrink-0 overflow-hidden border-sidebar-border border-r transition-[width] duration-200",
            sidebarCollapsed && "w-16",
          )}
        >
          <div className="h-full w-full">
            <AppSidebar
              collapsed={sidebarCollapsed}
              onToggleCollapse={() =>
                setCollapsedOn(sidebarCollapsed ? null : (panel ?? "chats"))
              }
            />
          </div>
        </aside>
        {!sidebarCollapsed && (
          <ResizeHandle
            label={t("resizeSidebar")}
            edge="right"
            value={sidebarWidth}
            min={SIDEBAR_WIDTH.min}
            max={SIDEBAR_WIDTH.max}
            step={16}
            onChange={setSidebarWidth}
            onReset={() => setSidebarWidth(null)}
            fromPointer={(x) =>
              x - (sidebar.current?.getBoundingClientRect().left ?? 0)
            }
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {listOpen ? (
          <div className="flex min-h-0 flex-1 flex-col bg-sidebar text-sidebar-foreground md:hidden">
            <TooltipProvider>
              <SidebarPanelContent
                awaitingApproval={awaitingApproval}
                onNavigate={() => setListOpen(false)}
              />
            </TooltipProvider>
          </div>
        ) : (
          inChat && (
            <div className="flex h-13 shrink-0 items-center gap-2 border-sidebar-border border-b px-4 md:hidden">
              <MobileTitle />
              {sessionId && (
                <div className="ml-auto flex shrink-0 gap-2">
                  <CopyConversation sessionId={sessionId} />
                  <ChatLinkMenu sessionId={sessionId} />
                  <SummaryToggle sessionId={sessionId} />
                </div>
              )}
            </div>
          )
        )}

        {/* Stays mounted under a list, so going back finds the page as it was. */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            listOpen && "hidden md:flex",
          )}
        >
          <Outlet />
        </div>

        <MobileNav
          list={listOpen}
          onShowList={() => setListOpen(true)}
          onHideList={() => setListOpen(false)}
        />
      </div>
      <AppDialogs />
      <CommandPalette />
    </div>
  );
}

function AppDialogs() {
  const { dialog, tab } = Route.useSearch();
  const navigate = useNavigate();
  const close = (open: boolean) => {
    if (open) return;
    navigate({
      to: ".",
      search: ({ dialog: _, tab: __, ...rest }) => rest,
      replace: true,
    });
  };
  return (
    <>
      <SettingsDialog
        open={dialog === "settings"}
        tab={tab}
        onOpenChange={close}
      />
      <SharingDialog open={dialog === "sharing"} onOpenChange={close} />
      <DiscoverDialog open={dialog === "discover"} onOpenChange={close} />
      <AppsDialog open={dialog === "apps"} onOpenChange={close} />
    </>
  );
}
