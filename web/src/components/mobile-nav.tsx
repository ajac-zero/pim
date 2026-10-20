import {
  Link,
  type LinkProps,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import {
  type SidebarPanel,
  useNavigationState,
  useNewChat,
} from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import {
  Bell,
  Blocks,
  CalendarClock,
  Compass,
  Contact,
  Folder,
  MessagesSquare,
  MoreHorizontal,
  ScrollText,
  Settings,
  Shapes,
  SquarePen,
  Users,
} from "~/components/icons";
import {
  ProfilePopover,
  ProfilePopoverTrigger,
} from "~/components/profile-popover";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

/** The panels that live under More rather than in the bar. */
const MORE_PANELS: readonly (SidebarPanel | undefined)[] = [
  "agents",
  "files",
  "skills",
  "schedules",
];

/**
 * The navigation on narrow screens, in place of the sidebar: a bar of icons
 * along the bottom of every page, as the rail is beside every page. Chats, notifications and artifacts fill the screen with
 * their list (`list`), New chat opens the dashboard of the open chat's agent
 * or stays on the open dashboard (your majordomo's anywhere else), and More opens
 * a sheet with the rest: agents, files, skills, schedules, the dialogs and your
 * profile.
 */
export function MobileNav({
  list,
  onShowList,
  onHideList,
}: {
  /** Whether a list fills the screen, rather than the page. */
  list: boolean;
  onShowList: () => void;
  onHideList: () => void;
}) {
  const { t } = useI18n();
  const { panel } = useSearch({ strict: false });
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const navigation = useNavigationState();
  const newChat = useNewChat(onHideList);
  const { awaitingApproval, guestRequests, unreadNotifications } = navigation;
  const showing = (shown?: SidebarPanel) => list && panel === shown;

  return (
    <nav
      aria-label={t("navigation")}
      className="grid shrink-0 grid-cols-5 items-center border-sidebar-border border-t bg-sidebar px-2 py-1 md:hidden"
    >
      <NavItem
        to="."
        search={(prev) => ({ ...prev, panel: "notifications" })}
        onClick={onShowList}
        active={showing("notifications")}
        icon={<Bell className="size-5" />}
        label={t("notifications")}
        count={unreadNotifications}
      />
      <NavItem
        to="."
        search={(prev) => ({ ...prev, panel: undefined })}
        onClick={onShowList}
        // An open chat counts as being in your chats, as the rail shows it.
        active={showing(undefined) || (!list && pathname.startsWith("/chat/"))}
        icon={<MessagesSquare className="size-5" />}
        label={t("chats")}
        count={awaitingApproval.size}
      />
      <Button
        onClick={newChat}
        size="icon-lg"
        className="size-11 justify-self-center"
        aria-label={t("newChat")}
      >
        <SquarePen className="size-5" />
      </Button>
      <NavItem
        to="."
        search={(prev) => ({ ...prev, panel: "artifacts" })}
        onClick={onShowList}
        active={showing("artifacts")}
        icon={<Shapes className="size-5" />}
        label={t("artifacts")}
      />
      <button
        type="button"
        onClick={() => setMoreOpen(true)}
        className={NAV_ITEM_CLASS}
        aria-label={
          guestRequests > 0 ? `${t("more")} (${guestRequests})` : t("more")
        }
        aria-expanded={moreOpen}
      >
        <NavIcon
          active={moreOpen || (list && MORE_PANELS.includes(panel))}
          count={guestRequests}
        >
          <MoreHorizontal className="size-5" />
        </NavIcon>
      </button>
      <MoreSheet
        {...navigation}
        open={moreOpen}
        onOpenChange={setMoreOpen}
        onShowList={onShowList}
        onHideList={onHideList}
      />
    </nav>
  );
}

const NAV_ITEM_CLASS =
  "flex h-12 min-w-0 items-center justify-center text-muted-foreground";

/** An icon in the bar, on a pill when it's what the screen shows, with a dot while something waits there. */
function NavIcon({
  active,
  count = 0,
  children,
}: {
  active: boolean;
  count?: number;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "relative flex h-8 w-14 items-center justify-center rounded-full transition-colors",
        active && "bg-sidebar-accent text-foreground",
      )}
    >
      {children}
      {count > 0 && (
        <span className="absolute top-1 right-3.5 size-2 rounded-full bg-primary" />
      )}
    </span>
  );
}

function NavItem({
  active,
  icon,
  label,
  count = 0,
  ...link
}: Pick<LinkProps, "to" | "search"> & {
  onClick: () => void;
  active: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <Link
      {...link}
      className={NAV_ITEM_CLASS}
      aria-label={count > 0 ? `${label} (${count})` : label}
      aria-current={active ? "page" : undefined}
    >
      <NavIcon active={active} count={count}>
        {icon}
      </NavIcon>
    </Link>
  );
}

const ROW_CLASS =
  "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] transition-colors hover:bg-muted";
const ROW_ICON_CLASS =
  "size-8 shrink-0 rounded-[10px] bg-muted p-2 text-muted-foreground";

/** What doesn't fit in the bar: your profile, the other lists, and the dialogs. */
function MoreSheet({
  account,
  profile,
  hasComputer,
  withOthers,
  guestRequests,
  open,
  onOpenChange,
  onShowList,
  onHideList,
}: ReturnType<typeof useNavigationState> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowList: () => void;
  onHideList: () => void;
}) {
  const { t } = useI18n();
  const close = () => onOpenChange(false);
  const panelRow = (panel: SidebarPanel, icon: ReactNode, label: string) => (
    <Link
      to="."
      search={(prev) => ({ ...prev, panel })}
      onClick={() => {
        close();
        onShowList();
      }}
      className={ROW_CLASS}
    >
      {icon}
      {label}
    </Link>
  );
  const dialogRow = (
    dialog: "settings" | "sharing" | "discover" | "apps",
    icon: ReactNode,
    label: string,
    count = 0,
  ) => (
    <Link
      to="."
      search={(prev) => ({ ...prev, dialog, tab: undefined })}
      onClick={close}
      className={ROW_CLASS}
    >
      {icon}
      {label}
      {count > 0 && (
        <span className="ml-auto text-[13px] text-muted-foreground">
          {count}
        </span>
      )}
    </Link>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-0 rounded-t-2xl border-0 p-2 pb-4 data-[state=closed]:duration-150 data-[state=open]:duration-200 md:hidden"
      >
        <SheetTitle className="sr-only">{t("more")}</SheetTitle>
        {account && (
          <ProfilePopover
            account={account}
            profile={profile}
            side="top"
            onNavigate={() => {
              close();
              onHideList();
            }}
          >
            <ProfilePopoverTrigger className={ROW_CLASS}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground uppercase">
                {(profile?.displayName ?? account.username).slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {profile?.displayName ?? `@${account.username}`}
                </span>
                <span className="block truncate text-[13px] text-muted-foreground">
                  {t("profile")}
                </span>
              </span>
            </ProfilePopoverTrigger>
          </ProfilePopover>
        )}
        <div className="mx-3 my-1 h-px bg-border" />
        {panelRow(
          "agents",
          <Contact className={ROW_ICON_CLASS} />,
          t("agents"),
        )}
        {hasComputer &&
          panelRow("files", <Folder className={ROW_ICON_CLASS} />, t("files"))}
        {panelRow(
          "skills",
          <ScrollText className={ROW_ICON_CLASS} />,
          t("skills"),
        )}
        {panelRow(
          "schedules",
          <CalendarClock className={ROW_ICON_CLASS} />,
          t("schedules"),
        )}
        <div className="mx-3 my-1 h-px bg-border" />
        {withOthers &&
          dialogRow(
            "discover",
            <Compass className={ROW_ICON_CLASS} />,
            t("discover"),
          )}
        {dialogRow(
          "apps",
          <Blocks className={ROW_ICON_CLASS} />,
          t("connectedApps"),
        )}
        {withOthers &&
          dialogRow(
            "sharing",
            <Users className={ROW_ICON_CLASS} />,
            t("sharing"),
            guestRequests,
          )}
        {dialogRow(
          "settings",
          <Settings className={ROW_ICON_CLASS} />,
          t("settings"),
        )}
      </SheetContent>
    </Sheet>
  );
}
