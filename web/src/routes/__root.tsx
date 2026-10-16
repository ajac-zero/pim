import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Outlet,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { PanelLeft } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { AppSidebar, sessionTitle } from "~/components/app-sidebar";
import { I18nProvider, useI18n } from "~/components/i18n";
import { RouteError } from "~/components/route-error";
import { SignIn } from "~/components/sign-in";
import { ThemeProvider } from "~/components/theme";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { Toaster } from "~/components/ui/sonner";
import { authSessionQuery } from "~/lib/auth";
import { pimClient } from "~/lib/pim-client";
import { agentsQuery, sessionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
});

function Root() {
  return (
    <I18nProvider>
      <ThemeProvider>
        <SignedIn>
          <AppLayout />
        </SignedIn>
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
        // Or made an agent.
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      },
      onNotification: (notification) => {
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        toast(notification.title, {
          description: notification.body,
          action: {
            label: t("view"),
            onClick: () => navigate({ to: "/notifications" }),
          },
        });
      },
      onVisits: () => {
        queryClient.invalidateQueries({ queryKey: ["visits"] });
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
      },
      onApproval: (approval) => {
        queryClient.invalidateQueries({ queryKey: ["approvals"] });
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
        if (approval.requestedBy) {
          // Someone in a circle asked: their request waits on the Sharing page.
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
                onClick: () => navigate({ to: "/sharing" }),
              },
            },
          );
          return;
        }
        // The open chat shows it inline; elsewhere, point to its chat (for a team member, the chat it works for).
        const chat = approval.member?.session ?? approval.session;
        if (approval.status !== "pending" || chat === sessionId) {
          return;
        }
        toast(t("approvalRequested"), {
          description: approval.summary,
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
          session.agent ? agent.id === session.agent.id : agent.default,
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

function AppLayout() {
  const { t } = useI18n();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  usePimEvents();

  return (
    <div className="flex h-svh w-full overflow-hidden">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 overflow-hidden border-sidebar-border border-r transition-[width] duration-200 md:block",
          sidebarCollapsed ? "w-16" : "w-[300px]",
        )}
      >
        <div className="h-full w-full">
          <AppSidebar
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
          />
        </div>
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-[300px] p-0 md:hidden [&>button]:hidden"
        >
          <SheetTitle className="sr-only">{t("navigation")}</SheetTitle>
          <AppSidebar onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center gap-2 border-sidebar-border border-b px-2 py-2 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            onClick={() => setMobileOpen(true)}
            aria-label={t("openSidebar")}
          >
            <PanelLeft className="size-5" />
          </Button>
          <MobileTitle />
        </div>

        <Outlet />
      </div>
    </div>
  );
}
