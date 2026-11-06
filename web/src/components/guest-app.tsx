import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { toast } from "sonner";
import { DeleteAccountSection } from "~/components/account-settings";
import { AgentIcon } from "~/components/agent-icon";
import { sessionTitle } from "~/components/app-sidebar";
import { ArtifactView } from "~/components/artifact-view";
import { Composer } from "~/components/chat/composer";
import { Thread } from "~/components/chat/thread";
import { useI18n } from "~/components/i18n";
import {
  AlertCircle,
  Download,
  Loader2,
  LogOut,
  MessagesSquare,
  MoreHorizontal,
  SquarePen,
  Trash2,
  X,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useElementHeight } from "~/hooks/use-element-size";
import { auth, authSessionQuery } from "~/lib/auth";
import {
  type Agent,
  FILES_ROOT,
  fileContentUrl,
  type GuestBot,
  pim,
  type UserContent,
} from "~/lib/pim-api";
import { pimClient, usePimClient } from "~/lib/pim-client";
import {
  accountQuery,
  agentsQuery,
  approvalsQuery,
  sessionsQuery,
} from "~/lib/queries";
import { useStartChat } from "~/lib/start-chat";
import { cn } from "~/lib/utils";

export const guestBotQuery = () =>
  queryOptions({ queryKey: ["guest-bot"], queryFn: pim.guestBot });

/**
 * The app as a guest sees it: they joined through a bot's public link and
 * chat with that bot alone, like a chat app with one assistant. Their chats
 * with it, a new chat, how many of today's messages are left, and their
 * account. The Worker lets a guest reach nothing else.
 */
export function GuestApp() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: guest, error } = useQuery(guestBotQuery());
  const { data: agents } = useQuery(agentsQuery());
  const agent = agents?.find((candidate) => candidate.id === guest?.agent);
  const { data: account } = useQuery(accountQuery());
  const location = useRouterState({ select: (state) => state.location });
  const sessionId = /^\/chat\/([^/]+)$/.exec(location.pathname)?.[1];
  const search = location.search as {
    artifact?: string;
    v?: number;
    file?: string;
  };
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    if (agent) document.title = `${agent.name} · Pim`;
  }, [agent]);

  // Live updates refresh the list of chats, today's usage, and approvals.
  useEffect(() => {
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["account"] });
    };
    pimClient.handlers = {
      onActivity: refresh,
      onSessions: () => {
        refresh();
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      },
      onApproval: () =>
        queryClient.invalidateQueries({ queryKey: ["approvals"] }),
      onTasks: (session) =>
        queryClient.invalidateQueries({ queryKey: ["tasks", session] }),
    };
    return () => {
      pimClient.handlers = {};
    };
  }, [queryClient]);

  if (error) {
    return (
      <main className="flex h-svh items-center justify-center px-6 text-center text-muted-foreground">
        {error.message}
      </main>
    );
  }
  if (!guest || !agent) {
    return (
      <main className="flex h-svh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  const off = guest.bot === null;
  const limit = account?.usage.limits.dailyRuns ?? null;
  const usedUp = limit !== null && (account?.usage.today.runs ?? 0) >= limit;
  return (
    <div className="flex h-svh w-full overflow-hidden">
      <aside
        className={cn(
          "w-full shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex md:w-72 md:border-sidebar-border md:border-r",
          listOpen ? "flex" : "hidden",
        )}
      >
        <GuestSidebar
          agent={agent}
          guest={guest}
          activeId={sessionId}
          onNavigate={() => setListOpen(false)}
        />
      </aside>
      <div
        className={cn(
          "min-w-0 flex-1 flex-col",
          listOpen ? "hidden md:flex" : "flex",
        )}
      >
        <header className="flex h-13 shrink-0 items-center gap-2 border-sidebar-border border-b px-4 md:hidden">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("guestChats")}
            onClick={() => setListOpen(true)}
          >
            <MessagesSquare />
          </Button>
          <AgentIcon agent={agent} tile className="size-6 rounded-md" />
          <span className="truncate text-[15px]">{agent.name}</span>
        </header>
        {off && (
          <p
            role="status"
            className="flex shrink-0 items-center justify-center gap-2 border-sidebar-border border-b px-4 py-2 text-center text-[13px] text-muted-foreground"
          >
            <AlertCircle className="size-4 shrink-0" />
            {t("guestBotOff", { name: agent.name })}
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          {sessionId ? (
            <GuestChat
              key={sessionId}
              sessionId={sessionId}
              agent={agent}
              disabled={off || usedUp}
            />
          ) : (
            <GuestHome agent={agent} guest={guest} disabled={off || usedUp} />
          )}
          {sessionId && (search.artifact || search.file) && (
            <GuestCanvas sessionId={sessionId} {...search} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The guest's chats with their bot, a new chat, today's messages, and their account. */
function GuestSidebar({
  agent,
  guest,
  activeId,
  onNavigate,
}: {
  agent: Agent;
  guest: GuestBot;
  activeId: string | undefined;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const { data: sessions } = useQuery(sessionsQuery());
  // Chats with the bot itself; tasks it handed the agents that came with it open from their chat.
  const chats = sessions?.filter(
    (session) => session.agent?.id === agent.id && !session.startedBy,
  );
  return (
    <>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <AgentIcon agent={agent} tile className="size-9 rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px]">{agent.name}</p>
          {guest.bot && (
            <p className="truncate text-[13px] text-muted-foreground">
              {t("guestBotBy", {
                author: guest.bot.authorName ?? `@${guest.bot.author}`,
              })}
            </p>
          )}
        </div>
        {/* On phones the list covers the chat: back to it. */}
        <Button
          size="icon-sm"
          variant="ghost"
          className="md:hidden"
          aria-label={t("close")}
          onClick={onNavigate}
        >
          <X />
        </Button>
      </div>
      <div className="px-3">
        <Button
          variant="ghost"
          className="w-full justify-start rounded-xl"
          asChild
        >
          <Link to="/" onClick={onNavigate}>
            <SquarePen /> {t("newChat")}
          </Link>
        </Button>
      </div>
      <nav
        aria-label={t("guestChats")}
        className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 scrollbar-thin"
      >
        <ul className="space-y-0.5">
          {chats?.map((session) => (
            <li key={session.id}>
              <Link
                to="/chat/$sessionId"
                params={{ sessionId: session.id }}
                onClick={onNavigate}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-xl px-3 text-[15px] hover:bg-muted",
                  session.id === activeId && "bg-muted",
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {sessionTitle(session, t)}
                </span>
                {(session.busy || session.unread) && (
                  <span className="size-2 shrink-0 rounded-full bg-link" />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="space-y-3 border-sidebar-border border-t px-4 py-3">
        {/* Turned off, the bot allows nothing more: the banner says so. */}
        {guest.bot && <UsageMeter />}
        <GuestAccountMenu />
      </div>
    </>
  );
}

/**
 * How many of today's messages the guest has sent, out of what their bot
 * allows, and, once the bot has used any tools, how many tool calls.
 */
function UsageMeter() {
  const { t } = useI18n();
  const { data: account } = useQuery(accountQuery());
  if (!account) return null;
  const { today, limits } = account.usage;
  return (
    <>
      {limits.dailyRuns !== null && (
        <Meter
          label={t("guestMessagesToday")}
          used={today.runs}
          limit={limits.dailyRuns}
          usedUp={t("guestMessagesUsedUp")}
        />
      )}
      {limits.dailyToolCalls !== null && today.toolCalls > 0 && (
        <Meter
          label={t("guestToolCallsToday")}
          used={today.toolCalls}
          limit={limits.dailyToolCalls}
          usedUp={t("guestToolCallsUsedUp")}
        />
      )}
    </>
  );
}

function Meter({
  label,
  used,
  limit,
  usedUp,
}: {
  label: string;
  used: number;
  limit: number;
  usedUp: string;
}) {
  const { t } = useI18n();
  const share = limit === 0 ? 1 : Math.min(used / limit, 1);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[13px] text-muted-foreground">
        <span>{label}</span>
        <span>{t("guestMessagesUsed", { used, limit })}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            share >= 1 ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${share * 100}%` }}
        />
      </div>
      {share >= 1 && (
        <p className="mt-1.5 text-[13px] text-muted-foreground">{usedUp}</p>
      )}
    </div>
  );
}

/** Who is signed in, signing out, and deleting the account. */
function GuestAccountMenu() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: session } = useQuery(authSessionQuery());
  const [deleting, setDeleting] = useState(false);
  const signOut = useMutation({
    mutationFn: auth.signOut,
    onSuccess: () => queryClient.invalidateQueries(),
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
        @{session?.account?.username}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("settingsAccount")}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuItem onSelect={() => signOut.mutate()}>
            <LogOut /> {t("signOut")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDeleting(true)}>
            <Trash2 /> {t("deleteAccount")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog.Root open={deleting} onOpenChange={setDeleting}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
          <Dialog.Content className="fixed inset-0 z-50 overflow-y-auto bg-background p-6 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[calc(100%-2rem)] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:shadow-xl">
            <Dialog.Title className="pr-8 font-semibold text-xl">
              {t("settingsAccount")}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="absolute top-5 right-5"
                aria-label={t("close")}
              >
                <X />
              </Button>
            </Dialog.Close>
            <DeleteAccountSection />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/** No chat open: the bot, and a message box that starts a chat with it. */
function GuestHome({
  agent,
  guest,
  disabled,
}: {
  agent: Agent;
  guest: GuestBot;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const { start, starting } = useStartChat(agent.id);
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6 px-4 pb-16">
      <div className="flex max-w-lg flex-col items-center gap-3 text-center">
        <AgentIcon agent={agent} tile className="size-14 rounded-2xl" />
        <h1 className="font-semibold text-xl">{agent.name}</h1>
        {(guest.bot?.description ?? agent.description) && (
          <p className="text-muted-foreground text-[15px]">
            {guest.bot?.description ?? agent.description}
          </p>
        )}
      </div>
      <div className="w-full max-w-3xl">
        <Composer
          draftKey="guest-new"
          onSend={(content: UserContent) => void start(content)}
          busy={starting}
          disabled={disabled || starting}
          placeholder={t("messageAgent", { name: agent.name })}
          autoFocus
        />
      </div>
    </main>
  );
}

/** A chat with the bot: its transcript, and the message box over its bottom. */
function GuestChat({
  sessionId,
  agent,
  disabled,
}: {
  sessionId: string;
  agent: Agent;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: sessions, isFetched } = useQuery(sessionsQuery());
  // Approvals show inline; loading them here keeps them current.
  useQuery(approvalsQuery());
  const known = sessions?.some((session) => session.id === sessionId);
  useEffect(() => {
    if (isFetched && known === false) void navigate({ to: "/", replace: true });
  }, [isFetched, known, navigate]);

  useLayoutEffect(() => {
    pimClient.open(sessionId);
  }, [sessionId]);
  const followed = usePimClient((state) => state.session);
  const view = usePimClient((state) => state.view);
  const loaded = usePimClient((state) => state.loaded);
  const synced = usePimClient((state) => state.synced);
  const pending = usePimClient((state) => state.pending);
  const ready = followed === sessionId;
  // A reply read on screen is read, as in the app's own chats.
  const queryClient = useQueryClient();
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const responseAt = session?.responseAt;
  const unread = ready && loaded && !view.running && session?.unread;
  useEffect(() => {
    if (!unread || responseAt == null) return;
    pim
      .readSession(sessionId, responseAt)
      .then(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }))
      .catch(() => undefined);
  }, [unread, responseAt, sessionId, queryClient]);
  const { ref: overlayRef, height: composerHeight } =
    useElementHeight<HTMLDivElement>();
  const { ref: cardRef, height: composerCardHeight } =
    useElementHeight<HTMLDivElement>();

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {ready && (loaded || pending !== null) ? (
        <Thread
          sessionId={sessionId}
          synced={synced}
          host={{ id: agent.id, name: agent.name }}
          view={view}
          pending={pending}
          composerHeight={composerHeight}
          composerCardHeight={composerCardHeight}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center pb-40">
          <Loader2
            className="size-5 animate-spin text-muted-foreground"
            aria-label={t("loading")}
          />
        </div>
      )}
      <div
        ref={overlayRef}
        style={{ "--scrollbar": "0px" } as CSSProperties}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center bg-background pb-2"
      >
        <div
          ref={cardRef}
          className="pointer-events-auto w-full max-w-4xl px-4"
        >
          <Composer
            key={sessionId}
            draftKey={sessionId}
            onSend={(content) =>
              pimClient
                .send(content)
                .catch((error: Error) => toast.error(error.message))
            }
            onStop={() =>
              pimClient
                .stop()
                .catch((error: Error) => toast.error(error.message))
            }
            busy={ready && view.running}
            disabled={!ready || disabled}
            placeholder={t("messageAgent", { name: agent.name })}
            autoFocus
          />
        </div>
      </div>
    </main>
  );
}

/** An artifact or file the chat opened, beside it, or over it on phones. */
function GuestCanvas({
  sessionId,
  artifact,
  v,
  file,
}: {
  sessionId: string;
  artifact?: string;
  v?: number;
  file?: string;
}) {
  const navigate = useNavigate();
  const show = (search: { artifact?: string; v?: number }) =>
    void navigate({
      to: "/chat/$sessionId",
      params: { sessionId },
      search,
      replace: true,
    });
  return (
    <aside className="fixed inset-0 z-40 flex min-h-0 flex-col bg-background md:relative md:inset-auto md:z-auto md:w-[50%] md:min-w-96 md:shrink-0 md:border-l">
      {artifact ? (
        <ArtifactView
          key={artifact}
          artifactId={artifact}
          version={v}
          onVersion={(version) => show({ artifact, v: version })}
          onDeleted={() => show({})}
          onClose={() => show({})}
        />
      ) : (
        file?.startsWith(`${FILES_ROOT}/`) && (
          <GuestImage key={file} path={file} onClose={() => show({})} />
        )
      )}
    </aside>
  );
}

/**
 * An image the bot made. A guest has no files of their own: it is kept in
 * the bot's author's, which the guest's space reads it from.
 */
function GuestImage({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useI18n();
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <h1 className="min-w-0 flex-1 truncate font-semibold">{name}</h1>
        <Button asChild size="sm" variant="outline" className="h-8">
          <a href={fileContentUrl(path, true)} download>
            <Download className="size-3.5" />
            {t("download")}
          </a>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          aria-label={t("close")}
          title={t("close")}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2 md:p-4">
        <img
          src={fileContentUrl(path)}
          alt={name}
          className="max-h-full max-w-full rounded-lg object-contain"
        />
      </div>
    </main>
  );
}
