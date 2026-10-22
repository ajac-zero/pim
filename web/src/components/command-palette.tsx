import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Dialog } from "radix-ui";
import { type ReactNode, useEffect, useState } from "react";
import { AgentIcon } from "~/components/agent-icon";
import {
  type SidebarPanel,
  sessionTitle,
  useAwaitingApproval,
  useNewChat,
} from "~/components/app-sidebar";
import { ArtifactIcon } from "~/components/artifact";
import { type TranslationKey, useI18n } from "~/components/i18n";
import {
  Bell,
  Blocks,
  CalendarClock,
  Check,
  Compass,
  FileIcon,
  Folder,
  Lightbulb,
  MessagesSquare,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Sun,
  Users,
} from "~/components/icons";
import { useTheme } from "~/components/theme";
import {
  accountQuery,
  agentsQuery,
  artifactsQuery,
  sessionsQuery,
} from "~/lib/queries";
import { cn } from "~/lib/utils";

const PANELS: {
  panel: SidebarPanel;
  label: TranslationKey;
  icon: ReactNode;
}[] = [
  { panel: "notifications", label: "notifications", icon: <Bell /> },
  { panel: "agents", label: "agents", icon: <Users /> },
  { panel: "artifacts", label: "artifacts", icon: <FileIcon /> },
  { panel: "files", label: "files", icon: <Folder /> },
  { panel: "skills", label: "skills", icon: <Lightbulb /> },
  { panel: "schedules", label: "schedules", icon: <CalendarClock /> },
];

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** A shortcut's keys, with the modifier a Mac or another computer uses. */
function Shortcut({ keys }: { keys: string }) {
  return (
    <span className="ml-auto text-[13px] text-muted-foreground">
      {MAC ? "⌘" : "Ctrl+"}
      {keys}
    </span>
  );
}

const ITEM =
  "flex h-10 cursor-default items-center gap-3 rounded-xl px-3 text-[15px] outline-none select-none data-[selected=true]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";
const GROUP =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-[13px] [&_[cmdk-group-heading]]:text-muted-foreground";

/**
 * A search over everything you can open or do: chats, agents, the sidebar's
 * panels, dialogs and New chat. ⌘K or Ctrl+K opens it from anywhere.
 */
export function CommandPalette({
  onToggleSidebar,
}: {
  onToggleSidebar: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data: sessions } = useQuery(sessionsQuery());
  const { data: agents } = useQuery(agentsQuery());
  const { data: account } = useQuery(accountQuery());
  const { data } = useQuery(artifactsQuery());
  const artifacts = data?.artifacts;
  const newChat = useNewChat();
  const awaitingApproval = useAwaitingApproval();
  const { preference, setPreference, themes, colorTheme, setColorTheme } =
    useTheme();

  // ⌘K opens the palette, ⌘⇧O starts a chat and ⌘B hides or shows the sidebar
  // (Ctrl instead of ⌘ away from a Mac).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "k" && !event.shiftKey) setOpen((current) => !current);
      else if (key === "o" && event.shiftKey) newChat();
      else if (key === "b" && !event.shiftKey) onToggleSidebar();
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [newChat, onToggleSidebar]);

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const openDialog = (dialog: "settings" | "sharing" | "discover" | "apps") =>
    run(() => navigate({ to: ".", search: (prev) => ({ ...prev, dialog }) }));

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[15vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border bg-background shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="sr-only">{t("commandPalette")}</Dialog.Title>
          <Command loop>
            <div className="flex items-center gap-3 border-b px-4">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Command.Input
                autoFocus
                placeholder={t("commandPlaceholder")}
                className="h-13 w-full bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-2 scrollbar-thin">
              <Command.Empty className="px-3 py-6 text-center text-muted-foreground text-[13px]">
                {t("commandEmpty")}
              </Command.Empty>
              <Command.Group heading={t("commandActions")} className={GROUP}>
                <Command.Item className={ITEM} onSelect={run(newChat)}>
                  <Plus /> {t("newChat")}
                  <Shortcut keys="⇧O" />
                </Command.Item>
                <Command.Item className={ITEM} onSelect={run(onToggleSidebar)}>
                  <PanelLeft /> {t("toggleSidebar")}
                  <Shortcut keys="B" />
                </Command.Item>
                <Command.Item
                  className={ITEM}
                  onSelect={run(() => navigate({ to: "/agents/new" }))}
                >
                  <Plus /> {t("newAgent")}
                </Command.Item>
              </Command.Group>
              <Command.Group heading={t("commandGoTo")} className={GROUP}>
                {PANELS.map(({ panel, label, icon }) => (
                  <Command.Item
                    key={panel}
                    className={ITEM}
                    onSelect={run(() =>
                      navigate({
                        to: ".",
                        search: (prev) => ({ ...prev, panel }),
                      }),
                    )}
                  >
                    {icon} {t(label)}
                  </Command.Item>
                ))}
                {account && !account.alone && (
                  <Command.Item
                    className={ITEM}
                    onSelect={openDialog("discover")}
                  >
                    <Compass /> {t("discover")}
                  </Command.Item>
                )}
                <Command.Item className={ITEM} onSelect={openDialog("apps")}>
                  <Blocks /> {t("connectedApps")}
                </Command.Item>
                {account && !account.alone && (
                  <Command.Item
                    className={ITEM}
                    onSelect={openDialog("sharing")}
                  >
                    <Users /> {t("sharing")}
                  </Command.Item>
                )}
                <Command.Item
                  className={ITEM}
                  onSelect={openDialog("settings")}
                >
                  <Settings /> {t("settings")}
                </Command.Item>
              </Command.Group>
              <Command.Group heading={t("appearance")} className={GROUP}>
                {(
                  [
                    ["light", "lightTheme", Sun],
                    ["dark", "darkTheme", Moon],
                    ["system", "systemTheme", Monitor],
                  ] as const
                ).map(([value, label, Icon]) => (
                  <Command.Item
                    key={value}
                    value={`appearance ${t(label)}`}
                    className={ITEM}
                    onSelect={run(() => setPreference(value))}
                  >
                    <Icon /> {t(label)}
                    {preference === value && <Check className="ml-auto" />}
                  </Command.Item>
                ))}
                {themes.map((theme) => (
                  <Command.Item
                    key={theme.id}
                    value={`${t("theme")} ${theme.name}`}
                    className={ITEM}
                    onSelect={run(() => setColorTheme(theme.id))}
                  >
                    <Palette /> {t("theme")}: {theme.name}
                    {colorTheme?.id === theme.id && (
                      <Check className="ml-auto" />
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
              {!!artifacts?.length && (
                <Command.Group heading={t("artifacts")} className={GROUP}>
                  {artifacts.map((artifact) => (
                    <Command.Item
                      key={artifact.id}
                      value={`artifact ${artifact.title} ${artifact.id}`}
                      className={ITEM}
                      onSelect={run(() =>
                        navigate({
                          to: "/artifacts/$artifactId",
                          params: { artifactId: artifact.id },
                        }),
                      )}
                    >
                      <ArtifactIcon kind={artifact.kind} />
                      <span className="truncate">{artifact.title}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {!!agents?.length && (
                <Command.Group heading={t("agents")} className={GROUP}>
                  {agents.map((agent) => (
                    <Command.Item
                      key={agent.id}
                      value={`agent ${agent.name} ${agent.id}`}
                      className={ITEM}
                      onSelect={run(() =>
                        navigate({
                          to: "/agents/$agentId",
                          params: { agentId: agent.id },
                        }),
                      )}
                    >
                      <AgentIcon
                        agent={agent}
                        tile
                        className="size-6 rounded-md"
                      />
                      <span className="truncate">{agent.name}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {!!sessions?.length && (
                <Command.Group heading={t("chats")} className={GROUP}>
                  {sessions.map((session) => {
                    const waiting = awaitingApproval.has(session.id);
                    const hint = waiting
                      ? t("awaitingApproval")
                      : (session.visit?.username ?? session.agent?.name);
                    return (
                      <Command.Item
                        key={session.id}
                        value={`chat ${sessionTitle(session, t)} ${hint ?? ""} ${session.id}`}
                        className={ITEM}
                        onSelect={run(() =>
                          navigate({
                            to: "/chat/$sessionId",
                            params: { sessionId: session.id },
                          }),
                        )}
                      >
                        <MessagesSquare />
                        <span className="truncate">
                          {sessionTitle(session, t)}
                        </span>
                        {hint && (
                          <span
                            className={cn(
                              "ml-auto shrink-0 text-[13px] text-muted-foreground",
                              waiting && "text-foreground",
                            )}
                          >
                            {hint}
                          </span>
                        )}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}
            </Command.List>
            <div className="hidden items-center gap-4 border-t px-4 py-2.5 text-[13px] text-muted-foreground md:flex">
              <span>↑↓ {t("commandMove")}</span>
              <span>↵ {t("commandOpen")}</span>
              <span>esc {t("close")}</span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
