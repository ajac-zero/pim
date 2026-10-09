import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { sessionTitle, useNewChat } from "~/components/app-sidebar";
import { Composer } from "~/components/chat/composer";
import { Thread } from "~/components/chat/thread";
import { CHATGPT_USAGE_URL, ChatGPTLogo } from "~/components/chatgpt-logo";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { useElementHeight } from "~/hooks/use-element-size";
import { CHATGPT_PROVIDER } from "~/lib/pim-api";
import { pimClient, usePimClient } from "~/lib/pim-client";
import { modelQuery, sessionsQuery } from "~/lib/queries";

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
      <Button variant="outline" onClick={() => newChat.mutate()}>
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
  }, [sessionId]);

  const followed = usePimClient((state) => state.session);
  const view = usePimClient((state) => state.view);
  const pendingText = usePimClient((state) => state.pendingText);
  const connection = usePimClient((state) => state.connection);
  const ready = followed === sessionId;

  const { ref: composerOverlayRef, height: composerHeight } =
    useElementHeight<HTMLDivElement>();
  const { ref: composerCardRef, height: composerCardHeight } =
    useElementHeight<HTMLDivElement>();

  const send = (text: string) => {
    pimClient.send(text).catch((error: Error) => toast.error(error.message));
  };
  const stop = () => {
    pimClient.stop().catch((error: Error) => toast.error(error.message));
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {ready && (
          <Thread
            sessionId={sessionId}
            view={view}
            pendingText={pendingText}
            composerHeight={composerHeight}
            composerCardHeight={composerCardHeight}
          />
        )}

        {/* Floats over the top of the thread. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
          <header className="hidden h-13 items-center gap-2 px-4 md:flex">
            <span className="pointer-events-auto max-w-[min(32rem,70%)] truncate rounded-full border bg-background px-3 py-1 font-medium text-sm shadow-sm">
              {session ? sessionTitle(session, t) : "\u00a0"}
            </span>
            {ready && connection !== "open" && (
              <span className="pointer-events-auto rounded-full border bg-background px-2.5 py-1 text-muted-foreground text-xs shadow-sm">
                {t("connecting")}
              </span>
            )}
          </header>
        </div>

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
            <Composer
              key={sessionId}
              onSend={send}
              onStop={stop}
              busy={ready && view.running}
              disabled={!ready}
              disclaimer={
                onPlan ? (
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
