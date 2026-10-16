import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { PimMark, sessionTitle, useNewChat } from "~/components/app-sidebar";
import { Composer } from "~/components/chat/composer";
import { TeamPanel } from "~/components/chat/team";
import { Thread } from "~/components/chat/thread";
import { CHATGPT_USAGE_URL, ChatGPTLogo } from "~/components/chatgpt-logo";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { useElementHeight } from "~/hooks/use-element-size";
import { CHATGPT_PROVIDER, type UserContent } from "~/lib/pim-api";
import { pimClient, usePimClient } from "~/lib/pim-client";
import { agentsQuery, modelQuery, sessionsQuery } from "~/lib/queries";

export const Route = createFileRoute("/chat/$sessionId")({
  loader: async ({ context, params }) => {
    const sessions = await context.queryClient.ensureQueryData(sessionsQuery());
    if (!sessions.some((session) => session.id === params.sessionId)) {
      // A session created moments ago may not be in a cached list yet.
      const fresh = await context.queryClient.fetchQuery(sessionsQuery());
      if (!fresh.some((session) => session.id === params.sessionId)) {
        throw notFound();
      }
    }
  },
  component: ChatPage,
  notFoundComponent: SessionNotFound,
});

function SessionNotFound() {
  const { t } = useI18n();
  const newChat = useNewChat();
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
      <p className="text-muted-foreground">{t("chatNotFound")}</p>
      <Button variant="outline" onClick={newChat}>
        {t("startNewChat")}
      </Button>
    </main>
  );
}

function ChatPage() {
  const { t } = useI18n();
  const { sessionId } = Route.useParams();
  const { data: sessions } = useQuery(sessionsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const { data: agents } = useQuery(agentsQuery());
  const agent = agents?.find(
    (candidate) => candidate.id === session?.agent?.id,
  );
  const { data: model } = useQuery(modelQuery());
  const onPlan = model?.model.provider === CHATGPT_PROVIDER;

  // The socket outlives this page, so notifications and approvals keep
  // arriving elsewhere in the app; it switches when another chat opens.
  useEffect(() => {
    pimClient.open(sessionId);
  }, [sessionId]);

  const followed = usePimClient((state) => state.session);
  const view = usePimClient((state) => state.view);
  const pending = usePimClient((state) => state.pending);
  const connection = usePimClient((state) => state.connection);
  const ready = followed === sessionId;

  const { ref: composerOverlayRef, height: composerHeight } =
    useElementHeight<HTMLDivElement>();
  const { ref: composerCardRef, height: composerCardHeight } =
    useElementHeight<HTMLDivElement>();

  const send = (content: UserContent) => {
    pimClient.send(content).catch((error: Error) => toast.error(error.message));
  };
  const stop = () => {
    pimClient.stop().catch((error: Error) => toast.error(error.message));
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <header className="hidden h-13 shrink-0 items-center gap-2 border-b bg-background px-4 md:flex">
          {session?.visit ? (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs">
              {session.visit.username.slice(0, 1).toUpperCase()}
            </span>
          ) : agent ? (
            <AgentIcon
              agent={agent}
              tile
              className="size-6 shrink-0 rounded-md"
            />
          ) : (
            <PimMark className="h-3 w-6 shrink-0" />
          )}
          <span className="min-w-0 truncate font-medium text-[15px]">
            {session ? sessionTitle(session, t) : "\u00a0"}
          </span>
          {session?.agent && (
            <span className="hidden truncate text-muted-foreground text-[13px] sm:inline">
              {session.agent.name}
            </span>
          )}
          {ready && connection !== "open" && (
            <span className="ml-auto text-muted-foreground text-[13px]">
              {t("connecting")}
            </span>
          )}
        </header>
        {ready && (
          <Thread
            sessionId={sessionId}
            visit={session?.visit?.username}
            view={view}
            pending={pending}
            composerHeight={composerHeight}
            composerCardHeight={composerCardHeight}
          />
        )}

        {/* Floats over the bottom of the thread. Its measured height feeds
         * the thread's bottom padding, so the last message clears it. */}
        <div
          ref={composerOverlayRef}
          className="pointer-events-none absolute right-2.5 bottom-0 left-0 z-10 flex justify-center bg-background px-4 pb-2"
        >
          <div
            ref={composerCardRef}
            className="pointer-events-auto w-full max-w-3xl"
          >
            {session?.agent && (
              <TeamPanel
                sessionId={sessionId}
                agentName={session.agent.name}
                running={ready && view.running}
              />
            )}
            <Composer
              key={sessionId}
              onSend={send}
              placeholder={
                session?.visit
                  ? t("messageVisit", { username: session.visit.username })
                  : session?.agent
                    ? t("messageAgent", { name: session.agent.name })
                    : undefined
              }
              onStop={stop}
              busy={ready && view.running}
              disabled={!ready}
              disclaimer={
                session?.visit ? (
                  <>
                    <Users className="size-3.5 shrink-0" />
                    {t("visitBanner", { username: session.visit.username })}
                  </>
                ) : onPlan ? (
                  <>
                    <ChatGPTLogo className="size-3.5" />
                    {t("usingChatGPTPlan")} ·
                    <a
                      href={CHATGPT_USAGE_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      {t("manageUsage")}
                    </a>
                  </>
                ) : undefined
              }
              autoFocus
            />
          </div>
        </div>
      </div>
    </main>
  );
}
