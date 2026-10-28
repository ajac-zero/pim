import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { PimMark } from "~/components/app-sidebar";
import { ArtifactCard, artifactReference } from "~/components/artifact";
import {
  AssistantMessage,
  EmailedMessage,
  EventNotice,
  GeneratedImage,
  generatedImagePath,
  ThinkingDot,
  type ToolApps,
  UserMessage,
  WorkedSteps,
} from "~/components/chat/items";
import { mentionsUser, useUserNames } from "~/components/chat/markdown";
import { sentImages } from "~/components/chat/reply-blocks";
import { MembersWorking, Speaker } from "~/components/chat/room";
import { TASK_POLL_MS, TaskCard, TaskJump } from "~/components/chat/tasks";
import { CHATGPT_USAGE_URL } from "~/components/chatgpt-logo";
import { type TranslationKey, useI18n } from "~/components/i18n";
import { AlertCircle, ArrowUp, Clock } from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationMentionButton,
  ConversationScrollButton,
} from "~/components/ui/conversation";
import { SentWidgets, shownWidgets } from "~/components/widgets";
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  MessageItem,
} from "~/lib/openresponses";
import { pim, type Room, type UserContent } from "~/lib/pim-api";
import {
  layoutThread,
  type ModelProblem,
  type SessionView,
  type ThreadEntry,
  taskHistory,
  userItem,
} from "~/lib/pim-view";
import {
  agentsQuery,
  appDirectoryQuery,
  approvalsQuery,
  appsQuery,
} from "~/lib/queries";

/** Tools whose answer names an artifact version, shown as the artifact itself: one made, changed or shown again. */
const ARTIFACT_TOOLS = new Set([
  "artifact_create",
  "artifact_update",
  "artifact_show",
]);

/** The tool whose answer names an image it saved to your files, shown as the image. */
const IMAGE_TOOL = "generate_image";

/** The description a `generate_image` call drew from, for the image's alt text. */
function promptOf(call: FunctionCallItem): string | undefined {
  try {
    const { prompt } = JSON.parse(call.arguments) as { prompt?: unknown };
    return typeof prompt === "string" ? prompt : undefined;
  } catch {
    return undefined;
  }
}

/** What each model problem tells the person; never the provider's own text. */
const PROBLEM_TEXT: Record<ModelProblem, TranslationKey> = {
  usage_limit: "modelUsageLimit",
  quota: "modelQuota",
  sign_in: "modelSignIn",
  too_long: "modelTooLong",
  busy: "modelBusy",
  other: "modelOther",
};

/* Insets clearing the floating header and composer (see the chat route). */
const DEFAULT_COMPOSER_INSET = 160;
const COMPOSER_INSET_GAP = 16;
const DEFAULT_COMPOSER_CARD_HEIGHT = 56;
const SCROLL_BUTTON_GAP = 16;
const HEADER_INSET = 24;

/**
 * Where each chat was scrolled to, by session, for this page's lifetime. A
 * chat read to the bottom has no entry: it opens at the bottom and follows
 * new messages.
 */
const scrollPositions = new Map<string, number>();
/** How close to the bottom counts as there, as `use-stick-to-bottom` counts it. */
const NEAR_BOTTOM = 70;

/** Pim's copies of images a group chat message shows, which it names by their own addresses. */
function postedImages(text: string): Record<string, string> {
  return Object.fromEntries(
    [...text.matchAll(/\/api\/images\/[\w-]+/g)].map(([url]) => [url, url]),
  );
}

export const Thread = memo(function Thread({
  sessionId,
  synced,
  visit,
  host,
  room,
  view,
  pending,
  composerHeight,
  composerCardHeight,
}: {
  sessionId: string;
  /** Whether `view` is current, rather than the chat as it was last left. */
  synced: boolean;
  /** The username whose space this conversation is with, when it's someone else's. */
  visit?: string;
  /** The agent the chat is with; in a group chat, its host. */
  host?: { id: string; name: string } | null;
  /** The other agents in a group chat, if it is one. */
  room?: Room | null;
  view: SessionView;
  /** A message sent but not yet in the transcript, shown right away. */
  pending: UserContent | null;
  composerHeight?: number;
  composerCardHeight?: number;
}) {
  const { t } = useI18n();

  const entries = useMemo<ThreadEntry[]>(() => {
    const all = [...view.entries];
    if (pending !== null) {
      all.push({
        key: "pending",
        kind: "item",
        source: "user",
        item: userItem(pending),
        // Sent just now; Pim's own time replaces it once it places the message.
        at: Date.now(),
      });
    }
    return [...all, ...view.live];
  }, [view.entries, view.live, pending]);

  // The entries the chat had when it was shown: an artifact made after them,
  // while the person watches, opens in the canvas by itself. A chat shown as
  // it was left counts from its snapshot, which has what was made meanwhile.
  const shownWith = useRef<{ session: string; keys: Set<string> } | null>(null);
  if (
    synced &&
    view.entries.length > 0 &&
    shownWith.current?.session !== sessionId
  ) {
    shownWith.current = {
      session: sessionId,
      keys: new Set(view.entries.map((entry) => entry.key)),
    };
  }

  /* A tool call renders with its result (call ids are unique per session). */
  const outputs = useMemo(() => {
    const map = new Map<string, FunctionCallOutputItem>();
    for (const entry of entries) {
      if (entry.kind === "item" && entry.item.type === "function_call_output") {
        const output = entry.item as FunctionCallOutputItem;
        map.set(output.call_id, output);
      }
    }
    return map;
  }, [entries]);
  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks", sessionId],
    queryFn: () => pim.tasks(sessionId),
    enabled: !visit,
    refetchInterval: (query) =>
      view.running || query.state.data?.some((task) => task.state === "working")
        ? TASK_POLL_MS
        : false,
  });
  const history = useMemo(() => taskHistory(entries, tasks), [entries, tasks]);
  /* A gated tool call is a step like any other, marked with the answer to its approval, which waits in the summary box. */
  const { data: allApprovals } = useQuery(approvalsQuery());
  // Requests from people in your circles belong to their conversations, not yours.
  const approvals = useMemo(
    () => allApprovals?.filter((approval) => !approval.requestedBy),
    [allApprovals],
  );
  const approvalsByCall = useMemo(
    () =>
      new Map(
        // A team member's call ids are its own conversation's, not this one's.
        (approvals ?? []).flatMap((approval) =>
          approval.callId && !approval.member
            ? [[approval.callId, approval] as const]
            : [],
        ),
      ),
    [approvals],
  );
  const placed = useMemo(
    () => new Set([...approvalsByCall.values()].map((approval) => approval.id)),
    [approvalsByCall],
  );
  /* The connected app of each app tool, for the steps that used it. */
  const { data: connected } = useQuery(appsQuery());
  const { data: directory } = useQuery(appDirectoryQuery());
  const toolApps = useMemo<ToolApps>(
    () =>
      new Map(
        (connected ?? []).flatMap((server) => {
          const app = directory?.find((entry) => entry.ref === server.app);
          const look = {
            name: app?.name ?? server.name,
            icon: app?.icon ?? null,
          };
          return server.tools.map((tool) => [tool.name, look] as const);
        }),
      ),
    [connected, directory],
  );
  const liveKeys = useMemo(
    () => new Set(view.live.map((entry) => entry.key)),
    [view.live],
  );
  /* In a group chat each agent's message says who wrote it, once for messages in a row from one agent. */
  const { data: agents } = useQuery(agentsQuery());
  // A chat whose other agents all left still says who wrote what they said.
  const grouped =
    (room?.members.length ?? 0) > 0 ||
    entries.some((entry) => entry.kind === "post");
  /* A message that mentions the person is marked, for the button to the next one. */
  const userNames = useUserNames();
  const mention = (key: string, text: string) =>
    !visit && mentionsUser(text, userNames) ? key : undefined;
  const working = room?.members.filter((member) => member.busy) ?? [];
  let lastSpeaker: string | null = null;
  const speaker = (name: string, id?: string) => {
    if (!grouped || lastSpeaker === name) return undefined;
    lastSpeaker = name;
    const agent =
      agents?.find((candidate) => candidate.id === id) ??
      agents?.find((candidate) => candidate.name === name);
    return <Speaker name={name} agent={agent} />;
  };

  /*
   * Only user-facing approvals, tasks, artifacts and images are drawn from tool
   * calls. An image a visit's agent made is in that space's files, which
   * this app can't open.
   */
  const rows = useMemo(
    () =>
      layoutThread(entries, {
        shown: (call) =>
          history.delegations.has(call.call_id) ||
          (ARTIFACT_TOOLS.has(call.name) &&
            artifactReference(outputs.get(call.call_id)?.output) !== null) ||
          (!visit &&
            call.name === IMAGE_TOOL &&
            generatedImagePath(outputs.get(call.call_id)?.output) !== null),
        refused: (call) => outputs.get(call.call_id)?.status === "incomplete",
        work: {
          running: view.running,
          // What the person approved is read as it was asked, not as the utility model put it.
          lines: {
            ...view.lines,
            ...Object.fromEntries(
              [...approvalsByCall].map(([call, approval]) => [
                call,
                approval.summary,
              ]),
            ),
          },
          approvals: Object.fromEntries(
            [...approvalsByCall].map(([call, approval]) => [
              call,
              approval.status,
            ]),
          ),
        },
      }),
    [
      entries,
      approvalsByCall,
      history.delegations,
      outputs,
      visit,
      view.running,
      view.lines,
    ],
  );

  // A reply being written in the chat shows the work going on by itself.
  const replying = rows.some(
    (row) =>
      row.kind === "sent" &&
      row.sent.channel === "chat" &&
      liveKeys.has(row.key),
  );

  const empty =
    !view.running &&
    working.length === 0 &&
    entries.every((entry) => entry.kind === "notice");

  return (
    <Conversation
      className="scrollbar-thin"
      // A chat opens where it was left, already there: gliding down through
      // the whole transcript reads as loading.
      initial={scrollPositions.has(sessionId) ? false : "instant"}
    >
      <ConversationContent
        className="mx-auto min-h-full w-full max-w-4xl px-4 md:px-8 [&>[data-speaker=assistant]+[data-notice=task]]:-mt-5 [&>[data-speaker=assistant]+[data-speaker=assistant]]:-mt-2 [&>[data-speaker=assistant]+[data-speaker=assistant]]:border-border/60 [&>[data-speaker=assistant]+[data-speaker=assistant]]:border-t [&>[data-speaker=assistant]+[data-speaker=assistant]]:pt-4 [&>[data-speaker=user]+[data-speaker=assistant]]:-mt-5 [&>[data-speaker=user]+[data-speaker=user]]:-mt-3 [&>[data-speaker=user]+[data-work]]:-mt-5 [&>[data-work]+[data-speaker=assistant]]:-mt-2 [&>[data-work]+[data-thinking]]:-mt-3"
        style={{
          paddingTop: HEADER_INSET,
          paddingBottom:
            (composerHeight ?? DEFAULT_COMPOSER_INSET) + COMPOSER_INSET_GAP,
        }}
      >
        {rows.map((row) => {
          if (row.kind === "sent" && row.sent.channel === "email") {
            return (
              <EmailedMessage
                key={row.key}
                subject={
                  row.sent.title ?? row.sent.message.split("\n")[0] ?? ""
                }
                text={row.sent.message}
              />
            );
          }
          if (row.kind === "sent") {
            return (
              <AssistantMessage
                key={row.key}
                speaker={host ? speaker(host.name, host.id) : undefined}
                item={{
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: row.sent.message }],
                }}
                at={row.at}
                mention={mention(row.key, row.sent.message)}
                streaming={liveKeys.has(row.key)}
                images={
                  outputs.has(row.call.call_id)
                    ? sentImages(outputs.get(row.call.call_id)?.output)
                    : null
                }
                attachments={
                  row.sent.widgets.length > 0 ? (
                    <SentWidgets
                      requested={row.sent.widgets.length}
                      widgets={shownWidgets(
                        outputs.get(row.call.call_id)?.output,
                      )}
                    />
                  ) : null
                }
              />
            );
          }
          if (row.kind === "work") {
            return (
              <WorkedSteps
                key={row.key}
                steps={row.steps}
                ms={row.ms}
                live={row.live}
                apps={toolApps}
              />
            );
          }
          const { entry } = row;
          if (entry.kind === "post") {
            return (
              <AssistantMessage
                key={entry.key}
                speaker={speaker(entry.from)}
                item={{
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: entry.text }],
                }}
                at={entry.at}
                mention={mention(entry.key, entry.text)}
                images={postedImages(entry.text)}
              />
            );
          }
          // Anything else between two of an agent's messages names it again.
          lastSpeaker = null;
          if (entry.kind === "notice") {
            // A decision whose approval is a step in the work is told there.
            if (entry.notice.approval && placed.has(entry.notice.approval)) {
              return <Fragment key={entry.key} />;
            }
            return (
              <EventNotice
                key={entry.key}
                notice={entry.notice}
                id={
                  entry.notice.kind === "task"
                    ? `task-update-${entry.key}`
                    : undefined
                }
                at={entry.at}
              >
                {(history.notices.get(entry.key)?.length ?? 0) > 0 && (
                  <div className="flex flex-col items-center gap-2 text-xs">
                    {history.notices.get(entry.key)?.map((task) => (
                      <TaskJump key={task.id} target={`task-start-${task.id}`}>
                        <ArrowUp className="size-3" />
                        {t("backToTask", { agent: task.agent.name })}
                      </TaskJump>
                    ))}
                  </div>
                )}
              </EventNotice>
            );
          }
          const { item } = entry;
          if (item.type === "message") {
            return (
              <UserMessage
                key={entry.key}
                item={item as MessageItem}
                at={entry.at}
              />
            );
          }
          if (item.type === "function_call") {
            const call = item as FunctionCallItem;
            const delegated = history.delegations.get(call.call_id);
            if (delegated) {
              return (
                <TaskCard
                  key={entry.key}
                  sessionId={sessionId}
                  tasks={delegated}
                  completions={history.completions}
                />
              );
            }
            const artifact = artifactReference(
              outputs.get(call.call_id)?.output,
            );
            if (artifact) {
              return (
                <ArtifactCard
                  key={entry.key}
                  reference={artifact}
                  sessionId={sessionId}
                  live={synced && !shownWith.current?.keys.has(entry.key)}
                />
              );
            }
            const image =
              call.name === IMAGE_TOOL &&
              generatedImagePath(outputs.get(call.call_id)?.output);
            if (image && !visit) {
              return (
                <GeneratedImage
                  key={entry.key}
                  path={image}
                  prompt={promptOf(call)}
                />
              );
            }
          }
          return null;
        })}

        {empty && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
            <PimMark className="mb-2 h-8 w-16" />
            <p className="font-medium text-xl">
              {visit
                ? t("visitEmptyTitle", { username: visit })
                : t("emptyChatTitle")}
            </p>
            <p className="max-w-sm text-muted-foreground text-sm">
              {visit
                ? t("visitEmptyHint", { username: visit })
                : t("emptyChatHint")}
            </p>
          </div>
        )}

        {view.running && !replying && <ThinkingDot />}

        <MembersWorking members={working} agents={agents} />

        {view.retry && (
          <div className="flex items-center justify-center gap-2 text-muted-foreground text-[13px]">
            <Clock className="size-4 shrink-0" />
            {t("retryingAfterError")}
          </div>
        )}

        {view.queued > 0 && (
          <div className="text-center text-muted-foreground text-[13px]">
            {t("queuedMessages", { count: view.queued })}
          </div>
        )}

        {view.error && !view.running && (
          <div className="flex items-start gap-3 rounded-2xl bg-muted px-4 py-3 text-sm">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="flex-1 space-y-2">
              {"problem" in view.error ? (
                <>
                  <p>{t(PROBLEM_TEXT[view.error.problem])}</p>
                  {(view.error.problem === "usage_limit" ||
                    view.error.problem === "sign_in" ||
                    view.error.problem === "other") && (
                    <div className="flex flex-wrap gap-2">
                      {/* OpenAI's settings show the plan's usage and Pim's App limit, and raise it. */}
                      {view.error.problem === "usage_limit" && (
                        <Button asChild size="sm" variant="outline">
                          <a
                            href={CHATGPT_USAGE_URL}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("manageUsage")}
                          </a>
                        </Button>
                      )}
                      <Button asChild size="sm" variant="outline">
                        <Link
                          to="."
                          search={(prev) => ({
                            ...prev,
                            dialog: "settings",
                            tab: "model",
                          })}
                        >
                          {t("settings")}
                        </Link>
                      </Button>
                    </div>
                  )}
                </>
              ) : "taskFailed" in view.error ? (
                <p>{t("taskFailed")}</p>
              ) : (
                <p>{t("notAnswered", { reason: view.error.reason })}</p>
              )}
            </div>
          </div>
        )}
      </ConversationContent>
      {/* After the content, whose scroller its effects need. */}
      <ScrollMemory sessionId={sessionId} loaded={rows.length > 0} />

      <ConversationScrollButton
        bottomOffset={
          (composerCardHeight ?? DEFAULT_COMPOSER_CARD_HEIGHT) +
          SCROLL_BUTTON_GAP
        }
        mention={
          <ConversationMentionButton
            label={t("scrollToMention")}
            changes={rows.length}
          />
        }
      />
    </Conversation>
  );
});

/** Remembers where a chat is scrolled to, and goes back there when the chat opens again. */
function ScrollMemory({
  sessionId,
  loaded,
}: {
  sessionId: string;
  /** The transcript has rendered, so there is somewhere to go back to. */
  loaded: boolean;
}) {
  const { scrollRef } = useStickToBottomContext();

  // Only the first render with the transcript restores; `loaded` doesn't turn false again.
  // A chat read to the bottom goes there before it paints, not a frame later.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session is fixed for this thread.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!loaded || !scroller) return;
    scroller.scrollTop =
      scrollPositions.get(sessionId) ?? scroller.scrollHeight;
  }, [loaded]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const remember = () => {
      const fromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (fromBottom < NEAR_BOTTOM) scrollPositions.delete(sessionId);
      else scrollPositions.set(sessionId, scroller.scrollTop);
    };
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => scroller.removeEventListener("scroll", remember);
  }, [scrollRef, sessionId]);

  return null;
}
