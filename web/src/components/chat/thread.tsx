import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Clock } from "lucide-react";
import { Fragment, memo, useMemo } from "react";
import { PimMark } from "~/components/app-sidebar";
import { ArtifactCard, artifactReference } from "~/components/artifact";
import {
  ApprovalBlock,
  AssistantMessage,
  EmailedMessage,
  EventNotice,
  ThinkingDot,
  UserMessage,
} from "~/components/chat/items";
import { CHATGPT_USAGE_URL } from "~/components/chatgpt-logo";
import { type TranslationKey, useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "~/components/ui/conversation";
import { SentWidgets } from "~/components/widgets";
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  MessageItem,
} from "~/lib/openresponses";
import type { UserContent } from "~/lib/pim-api";
import {
  layoutThread,
  type ModelProblem,
  type SessionView,
  type ThreadEntry,
  userItem,
} from "~/lib/pim-view";
import { approvalsQuery } from "~/lib/queries";

/** Tools whose answer names an artifact version, shown as the artifact itself. */
const ARTIFACT_TOOLS = new Set(["artifact_create", "artifact_update"]);

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

export const Thread = memo(function Thread({
  sessionId,
  visit,
  view,
  pending,
  composerHeight,
  composerCardHeight,
}: {
  sessionId: string;
  /** The username whose Pim this conversation is with, when it's someone else's. */
  visit?: string;
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
      });
    }
    return [...all, ...view.live];
  }, [view.entries, view.live, pending]);

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
  /* Pending approvals of this chat with no call in view (filed before a reset). */
  const unplaced = useMemo(() => {
    return (approvals ?? [])
      .filter(
        (approval) =>
          // A team member's request shows in the chat it works for.
          (approval.member?.session ?? approval.session) === sessionId &&
          approval.status === "pending" &&
          !placed.has(approval.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [approvals, placed, sessionId]);
  const liveKeys = useMemo(
    () => new Set(view.live.map((entry) => entry.key)),
    [view.live],
  );

  /* Only user-facing approvals and artifacts are drawn from tool calls. */
  const rows = useMemo(
    () =>
      layoutThread(entries, {
        shown: (call) =>
          approvalsByCall.has(call.call_id) ||
          (ARTIFACT_TOOLS.has(call.name) &&
            artifactReference(outputs.get(call.call_id)?.output) !== null),
        refused: (call) => outputs.get(call.call_id)?.status === "incomplete",
      }),
    [entries, approvalsByCall, outputs],
  );

  const empty =
    !view.running &&
    unplaced.length === 0 &&
    entries.every((entry) => entry.kind === "notice");

  return (
    <Conversation className="scrollbar-thin">
      <ConversationContent
        className="mx-auto min-h-full w-full max-w-3xl px-4 [&>[data-speaker=assistant]+[data-speaker=assistant]]:-mt-3 [&>[data-speaker=user]+[data-speaker=user]]:-mt-3"
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
                item={{
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: row.sent.message }],
                }}
                streaming={liveKeys.has(row.key)}
                notified={row.sent.notify}
                attachments={
                  row.sent.widgets.length > 0 ? (
                    <SentWidgets
                      requested={row.sent.widgets.length}
                      output={outputs.get(row.call.call_id)?.output}
                    />
                  ) : null
                }
              />
            );
          }
          const { entry } = row;
          if (entry.kind === "notice") {
            // A decision whose approval shows as a card is told by the card.
            if (entry.notice.approval && placed.has(entry.notice.approval)) {
              return <Fragment key={entry.key} />;
            }
            return <EventNotice key={entry.key} notice={entry.notice} />;
          }
          const { item } = entry;
          if (item.type === "message") {
            return <UserMessage key={entry.key} item={item as MessageItem} />;
          }
          if (item.type === "function_call") {
            const call = item as FunctionCallItem;
            const approval = approvalsByCall.get(call.call_id);
            if (approval) {
              return <ApprovalBlock key={entry.key} approval={approval} />;
            }
            const artifact = artifactReference(
              outputs.get(call.call_id)?.output,
            );
            if (artifact) {
              return <ArtifactCard key={entry.key} reference={artifact} />;
            }
          }
          return null;
        })}

        {unplaced.map((approval) => (
          <ApprovalBlock key={approval.id} approval={approval} />
        ))}

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

        {view.running && <ThinkingDot />}

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
                        <Link to="/settings">{t("settings")}</Link>
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

      <ConversationScrollButton
        bottomOffset={
          (composerCardHeight ?? DEFAULT_COMPOSER_CARD_HEIGHT) +
          SCROLL_BUTTON_GAP
        }
      />
    </Conversation>
  );
});
