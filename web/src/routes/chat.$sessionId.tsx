import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useNewChat } from "~/components/app-sidebar";
import { ArtifactView } from "~/components/artifact-view";
import { ChatLinkMenu } from "~/components/chat/chat-link";
import { Composer } from "~/components/chat/composer";
import { CopyConversation } from "~/components/chat/copy-conversation";
import { SummaryBox, SummaryToggle } from "~/components/chat/summary";
import { ChatTabs } from "~/components/chat/tabs";
import { TaskPanel } from "~/components/chat/tasks";
import { Thread } from "~/components/chat/thread";
import { CHATGPT_USAGE_URL, ChatGPTLogo } from "~/components/chatgpt-logo";
import { useI18n } from "~/components/i18n";
import { Loader2, Users } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { ResizeHandle, useStoredSize } from "~/components/ui/resize-handle";
import { useElementHeight } from "~/hooks/use-element-size";
import { CHATGPT_PROVIDER, pim, type UserContent } from "~/lib/pim-api";
import { pimClient, usePimClient } from "~/lib/pim-client";
import { modelQuery, sessionsQuery } from "~/lib/queries";
import { showTab, useTabs } from "~/lib/tabs";
import { cn } from "~/lib/utils";

/** The canvas's width, as a percentage of the page beside the sidebar, which the person can drag. */
const CANVAS_WIDTH = { default: 56, min: 30, max: 75 };

/** An artifact open in the canvas beside the chat, and which of its versions. */
type ChatSearch = { artifact?: string; v?: number };

export const Route = createFileRoute("/chat/$sessionId")({
  validateSearch: (search: Record<string, unknown>): ChatSearch => {
    const v = Number(search.v);
    return {
      ...(typeof search.artifact === "string" &&
        search.artifact && { artifact: search.artifact }),
      ...(Number.isSafeInteger(v) && v > 0 && { v }),
    };
  },
  loader: async ({ context, params, preload }) => {
    // The pointer rests on a link to this chat (the router preloads on intent).
    if (preload) pimClient.warm(params.sessionId);
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
  const { artifact, v } = Route.useSearch();
  const navigate = useNavigate();
  const page = useRef<HTMLElement>(null);
  const [canvasWidth, setCanvasWidth] = useStoredSize(
    "pim-canvas-width",
    CANVAS_WIDTH.default,
  );
  const showArtifact = (search: ChatSearch) =>
    void navigate({
      to: "/chat/$sessionId",
      params: { sessionId },
      search,
      replace: true,
    });
  const { data: sessions } = useQuery(sessionsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const { data: model } = useQuery(modelQuery());
  const onPlan = model?.model.provider === CHATGPT_PROVIDER;

  // The socket outlives this page, so notifications and approvals keep
  // arriving elsewhere in the app; it switches when another chat opens.
  // Before paint, so a chat shown before appears at once, as it was left.
  useLayoutEffect(() => {
    pimClient.open(sessionId);
    showTab(sessionId);
  }, [sessionId]);

  const followed = usePimClient((state) => state.session);
  const view = usePimClient((state) => state.view);
  const loaded = usePimClient((state) => state.loaded);
  const synced = usePimClient((state) => state.synced);
  const pending = usePimClient((state) => state.pending);
  const connection = usePimClient((state) => state.connection);
  const ready = followed === sessionId;

  const queryClient = useQueryClient();
  const { mutate: markRead } = useMutation({
    mutationFn: ({ id, responseAt }: { id: string; responseAt: number }) =>
      pim.readSession(id, responseAt),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (error) => toast.error(error.message),
  });
  const responseAt = session?.responseAt;
  const unread = session?.unread;
  useEffect(() => {
    // Wait for the transcript, not just its route. A hidden tab hasn't seen the reply.
    if (!ready || !loaded || view.running || !unread || responseAt == null)
      return;
    const read = () => {
      if (document.visibilityState === "visible")
        markRead({ id: sessionId, responseAt });
    };
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, [ready, loaded, view.running, unread, responseAt, sessionId, markRead]);

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
    pimClient.send(content).catch((error: Error) => toast.error(error.message));
  };
  const stop = () => {
    pimClient.stop().catch((error: Error) => toast.error(error.message));
  };

  const shelf = useTabs().length > 1;

  return (
    <main ref={page} className="flex min-h-0 min-w-0 flex-1">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "hidden h-13 shrink-0 gap-2 pr-4 md:flex",
            // The tabs sit on a shelf; a lone chat's title sits on the canvas.
            shelf && "bg-sidebar",
          )}
        >
          <ChatTabs activeId={sessionId} />
          {reconnecting && (
            <span className="shrink-0 self-center text-muted-foreground text-[13px]">
              {t("connecting")}
            </span>
          )}
          <CopyConversation sessionId={sessionId} />
          <ChatLinkMenu sessionId={sessionId} />
          <SummaryToggle className="shrink-0 self-center" />
        </header>
        {/* The summary box takes a column of its own, so the thread makes room
         * for it rather than sitting under it: at the right, or on top on phones. */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Until its snapshot arrives a chat opened for the first time
             * would look empty; a message just sent is already worth showing. */}
            {ready && (loaded || pending !== null) ? (
              <Thread
                key={sessionId}
                sessionId={sessionId}
                synced={synced}
                visit={session?.visit?.username}
                view={view}
                pending={pending}
                composerHeight={composerHeight}
                composerCardHeight={composerCardHeight}
              />
            ) : (
              // Fades in late, so a chat that loads at once doesn't flash it.
              <div className="flex flex-1 animate-in items-center justify-center pb-40 delay-300 duration-300 fade-in fill-mode-backwards">
                <Loader2
                  className="size-5 animate-spin text-muted-foreground"
                  aria-label={t("loading")}
                />
              </div>
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
                  <TaskPanel
                    sessionId={sessionId}
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
          {ready && !artifact && (
            <SummaryBox
              sessionId={sessionId}
              entries={view.entries.length}
              settled={!view.running}
            />
          )}
        </div>
      </div>
      {artifact && (
        // The canvas: beside the chat, as wide as the person last made it, or over it on phones.
        <aside
          style={{ "--canvas-width": `${canvasWidth}%` } as CSSProperties}
          className="fixed inset-0 z-40 flex min-h-0 flex-col bg-background md:relative md:inset-auto md:z-auto md:w-(--canvas-width) md:min-w-96 md:max-w-[calc(100%-22rem)] md:shrink-0 md:border-l"
        >
          <ResizeHandle
            label={t("resizeCanvas")}
            edge="left"
            value={canvasWidth}
            min={CANVAS_WIDTH.min}
            max={CANVAS_WIDTH.max}
            step={2}
            onChange={setCanvasWidth}
            onReset={() => setCanvasWidth(null)}
            fromPointer={(x) => {
              const box = page.current?.getBoundingClientRect();
              return box
                ? Math.round(((box.right - x) / box.width) * 1000) / 10
                : canvasWidth;
            }}
            className="hidden md:block"
          />
          <ArtifactView
            key={artifact}
            artifactId={artifact}
            version={v}
            onVersion={(version) => showArtifact({ artifact, v: version })}
            onDeleted={() => showArtifact({})}
            onClose={() => showArtifact({})}
          />
        </aside>
      )}
    </main>
  );
}
