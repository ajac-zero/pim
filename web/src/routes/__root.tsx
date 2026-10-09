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
import { AppSidebar, sessionTitle } from "~/components/app-sidebar";
import { I18nProvider, useI18n } from "~/components/i18n";
import { ShowReasoningProvider } from "~/components/reasoning-preference";
import { RouteError } from "~/components/route-error";
import { SignIn } from "~/components/sign-in";
import { ThemeProvider } from "~/components/theme";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { Toaster } from "~/components/ui/sonner";
import { authSessionQuery } from "~/lib/auth";
import { pimClient } from "~/lib/pim-client";
import { sessionsQuery } from "~/lib/queries";
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
        <ShowReasoningProvider>
          <SignedIn>
            <AppLayout />
          </SignedIn>
          <Toaster position="top-center" />
        </ShowReasoningProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

/** The app once this browser is signed in; the sign-in screen until then. */
function SignedIn({ children }: { children: ReactNode }) {
  const { data, error, refetch } = useQuery(authSessionQuery());
  const signedOut = data?.signedIn === false;
  // An open socket would keep streaming after signing out.
  useEffect(() => {
    if (signedOut) pimClient.close();
  }, [signedOut]);
  if (error) {
    return (
      <div className="flex h-svh">
        <RouteError error={error} reset={() => refetch()} />
      </div>
    );
  }
  if (!data) return null;
  if (!data.signedIn) return <SignIn hasPasskeys={data.hasPasskeys} />;
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
      onApproval: (approval) => {
        queryClient.invalidateQueries({ queryKey: ["approvals"] });
        // The open chat shows it inline; elsewhere, point to its chat.
        if (approval.status !== "pending" || approval.session === sessionId) {
          return;
        }
        toast(t("approvalRequested"), {
          description: approval.summary,
          action: {
            label: t("review"),
            onClick: () =>
              navigate({
                to: "/chat/$sessionId",
                params: { sessionId: approval.session },
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
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  return (
    <span className="truncate font-semibold text-[15px]">
      {session ? sessionTitle(session, t) : "Pim"}
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
          sidebarCollapsed ? "w-16" : "w-[268px]",
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
        <SheetContent side="left" className="w-[290px] p-0 md:hidden">
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
