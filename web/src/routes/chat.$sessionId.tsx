import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useNewChat } from "~/components/app-sidebar";
import { Composer } from "~/components/chat/composer";
import { SummaryBox, SummaryToggle } from "~/components/chat/summary";
import { ChatTabs } from "~/components/chat/tabs";
import { TeamPanel } from "~/components/chat/team";
import { Thread } from "~/components/chat/thread";
import { CHATGPT_USAGE_URL, ChatGPTLogo } from "~/components/chatgpt-logo";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { useElementHeight } from "~/hooks/use-element-size";
import { CHATGPT_PROVIDER, type UserContent } from "~/lib/pim-api";
import { pimClient, usePimClient } from "~/lib/pim-client";
import { modelQuery, sessionsQuery } from "~/lib/queries";
import { showTab } from "~/lib/tabs";

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
  const { data: model } = useQuery(modelQuery());
  const onPlan = model?.model.provider === CHATGPT_PROVIDER;

  // The socket outlives this page, so notifications and approvals keep
  // arriving elsewhere in the app; it switches when another chat opens.
  useEffect(() => {
    pimClient.open(sessionId);
    showTab(sessionId);
  }, [sessionId]);

  const followed = usePimClient((state) => state.session);
  const view = usePimClient((state) => state.view);
  const pending = usePimClient((state) => state.pending);
  const connection = usePimClient((state) => state.connection);
  const ready = followed === sessionId;

  // Switching chats reconnects in a moment, which would flash the label and
  // squeeze the tabs; only a connection that stays down is worth showing.
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    setReconnecting(false);
    if (!ready || connection === "open") return;
    const timer = setTimeout(() => setReconnecting(true), 1000);
    return () => clearTimeout(timer);
  }, [ready, connection]);

  const { ref: composerOverlayRef, height: composerHeight } =
    useElementHeight<HTMLDivElement>();
  const { ref: composerCardRef, height: composerCardHeight } =
    useElementHeight<HTMLDivElement>();

  const send = (content: UserContent) => {
    // A chat you've written in keeps its tab.
    showTab(sessionId, true);
    pimClient.send(content).catch((error: Error) => toast.error(error.message));
  };
  const stop = () => {
    pimClient.stop().catch((error: Error) => toast.error(error.message));
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <header className="hidden h-13 shrink-0 gap-2 bg-sidebar pr-4 md:flex">
          <ChatTabs activeId={sessionId} />
          {reconnecting && (
            <span className="shrink-0 self-center text-muted-foreground text-[13px]">
              {t("connecting")}
            </span>
          )}
          <SummaryToggle className="shrink-0 self-center" />
        </header>
        {/* The summary box takes a column of its own, so the thread makes room
         * for it rather than sitting under it: at the right, or on top on phones. */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
                  draftKey={sessionId}
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
          {ready && (
            <SummaryBox
              sessionId={sessionId}
              entries={view.entries.length}
              settled={!view.running}
            />
          )}
        </div>
      </div>
    </main>
  );
}
