import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Clock } from "lucide-react";
import { Fragment, memo, useMemo } from "react";
import { PimMark } from "~/components/app-sidebar";
import {
  ApprovalBlock,
  AssistantMessage,
  EventNotice,
  ReasoningBlock,
  ThinkingDot,
  ToolCallBlock,
  UnknownItemBlock,
  UserMessage,
} from "~/components/chat/items";
import { CHATGPT_USAGE_URL } from "~/components/chatgpt-logo";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "~/components/ui/conversation";
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  MessageItem,
  ReasoningItem,
} from "~/lib/openresponses";
import type { Approval } from "~/lib/pim-api";
import {
  approvalIdOf,
  type SessionView,
  type ThreadEntry,
} from "~/lib/pim-view";
import { approvalsQuery } from "~/lib/queries";

/* Insets clearing the floating header and composer (see the chat route). */
const DEFAULT_COMPOSER_INSET = 160;
const COMPOSER_INSET_GAP = 16;
const DEFAULT_COMPOSER_CARD_HEIGHT = 56;
const SCROLL_BUTTON_GAP = 16;
const HEADER_INSET = 52;

export const Thread = memo(function Thread({
  sessionId,
  view,
  pendingText,
  composerHeight,
  composerCardHeight,
}: {
  sessionId: string;
  view: SessionView;
  /** A message sent but not yet in the transcript, shown right away. */
  pendingText: string | null;
  composerHeight?: number;
  composerCardHeight?: number;
}) {
  const { t } = useI18n();

  const entries = useMemo<ThreadEntry[]>(() => {
    const all = [...view.entries];
    if (pendingText !== null) {
      all.push({
        key: "pending",
        kind: "item",
        source: "user",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: pendingText }],
        },
      });
    }
    return [...all, ...view.live];
  }, [view.entries, view.live, pendingText]);

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
  /* A gated tool call renders as the approval it filed. */
  const { data: approvals } = useQuery(approvalsQuery());
  const approvalsByCall = useMemo(() => {
    const byId = new Map(approvals?.map((approval) => [approval.id, approval]));
    const map = new Map<string, Approval>();
    for (const [callId, output] of outputs) {
      const id =
        typeof output.output === "string" ? approvalIdOf(output.output) : null;
      const approval = id ? byId.get(id) : undefined;
      if (approval) map.set(callId, approval);
    }
    return map;
  }, [approvals, outputs]);
  const placed = useMemo(
    () => new Set([...approvalsByCall.values()].map((approval) => approval.id)),
    [approvalsByCall],
  );
  /* Pending approvals of this chat with no call in view (filed before a reset). */
  const unplaced = useMemo(() => {
    return (approvals ?? [])
      .filter(
        (approval) =>
          approval.session === sessionId &&
          approval.status === "pending" &&
          !placed.has(approval.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [approvals, placed, sessionId]);
  const runningTools = useMemo(
    () => new Map(view.tools.map((tool) => [tool.callId, tool])),
    [view.tools],
  );
  const liveKeys = useMemo(
    () => new Set(view.live.map((entry) => entry.key)),
    [view.live],
  );

  const showThinking =
    view.running && view.live.length === 0 && view.tools.length === 0;
  const empty =
    !view.running &&
    unplaced.length === 0 &&
    entries.every((entry) => entry.kind === "notice");

  return (
    <Conversation className="scrollbar-thin">
      <ConversationContent
        className="mx-auto min-h-full w-full max-w-3xl px-4"
        style={{
          paddingTop: HEADER_INSET,
          paddingBottom:
            (composerHeight ?? DEFAULT_COMPOSER_INSET) + COMPOSER_INSET_GAP,
        }}
      >
        {entries.map((entry) => {
          if (entry.kind === "notice") {
            // A decision whose approval shows as a card is told by the card.
            if (entry.notice.approval && placed.has(entry.notice.approval)) {
              return <Fragment key={entry.key} />;
            }
            return <EventNotice key={entry.key} notice={entry.notice} />;
          }
          const { item } = entry;
          const streaming = liveKeys.has(entry.key);

          if (item.type === "message") {
            const message = item as MessageItem;
            return message.role === "user" ? (
              <UserMessage key={entry.key} item={message} />
            ) : (
              <AssistantMessage
                key={entry.key}
                item={message}
                streaming={streaming}
              />
            );
          }
          if (item.type === "reasoning") {
            return (
              <ReasoningBlock
                key={entry.key}
                item={item as ReasoningItem}
                streaming={streaming}
              />
            );
          }
          if (item.type === "function_call") {
            const call = item as FunctionCallItem;
            const approval = approvalsByCall.get(call.call_id);
            if (approval) {
              return <ApprovalBlock key={entry.key} approval={approval} />;
            }
            const running = runningTools.get(call.call_id);
            return (
              <ToolCallBlock
                key={entry.key}
                call={call}
                output={outputs.get(call.call_id) ?? null}
                running={running !== undefined}
                liveOutput={running?.output}
              />
            );
          }
          if (item.type === "function_call_output") {
            // Rendered with its call.
            return <Fragment key={entry.key} />;
          }
          return <UnknownItemBlock key={entry.key} item={item} />;
        })}

        {unplaced.map((approval) => (
          <ApprovalBlock key={approval.id} approval={approval} />
        ))}

        {empty && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
            <PimMark className="size-10" />
            <p className="font-medium text-xl">{t("emptyChatTitle")}</p>
            <p className="max-w-sm text-muted-foreground text-sm">
              {t("emptyChatHint")}
            </p>
          </div>
        )}

        {showThinking && <ThinkingDot />}

        {view.retry && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Clock className="size-4 shrink-0" />
            {t("retryingAfterError", { error: view.retry.error })}
          </div>
        )}

        {view.queued > 0 && (
          <div className="text-muted-foreground text-sm">
            {t("queuedMessages", { count: view.queued })}
          </div>
        )}

        {view.error && !view.running && (
          <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="flex-1 space-y-2">
              <p>{view.error}</p>
              {/* The ChatGPT plan's usage limit: OpenAI's settings show and lift it. */}
              {/chatgpt\.com\/settings\/usage|subscription_sharing_usage/.test(
                view.error,
              ) && (
                <Button asChild size="sm" variant="outline">
                  <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                    {t("manageUsage")}
                  </a>
                </Button>
              )}
            </div>
          </div>
        )}
      </ConversationContent>

      <ConversationScrollButton
        bottomOffset={
          (composerCardHeight ?? DEFAULT_COMPOSER_CARD_HEIGHT) +
          SCROLL_BUTTON_GAP
        }
      />
    </Conversation>
  );
});
