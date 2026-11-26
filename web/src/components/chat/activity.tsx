import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  usePendingApprovals,
  useSummaryOpen,
} from "~/components/chat/activity-toggle";
import { BoxSection } from "~/components/chat/box-section";
import { ChatLinkMenu } from "~/components/chat/chat-link";
import { ContextMeter } from "~/components/chat/context-meter";
import {
  CopyChatId,
  CopyConversation,
  PinChat,
} from "~/components/chat/copy-conversation";
import { ApprovalBlock } from "~/components/chat/items";
import { Markdown } from "~/components/chat/markdown-lazy";
import { RoomMenu } from "~/components/chat/room";
import { SessionCostMenu } from "~/components/chat/session-cost";
import { useI18n } from "~/components/i18n";
import { Activity, AlertCircle, FileText, Loader2 } from "~/components/icons";
import { ChatRunActivity } from "~/components/run-activity";
import { pim } from "~/lib/pim-api";

/**
 * The chat's options, in a popup floating over its top right corner: the agents in
 * the chat, copying the conversation or its id, its public link, and what it
 * has cost, and how full its context is; then what the agent is doing now, and a quick summary of it and its next steps, from the utility
 * model. Approvals the chat
 * is waiting on come first, and open the box even when it's closed. Nothing is
 * written until the summary dropdown is open. While open, it asks again only
 * when the chat has settled with new entries (`entries`),
 * and Pim writes a new summary only if something more was said.
 */
export function ActivityBox({
  sessionId,
  entries,
  settled,
}: {
  sessionId: string;
  entries: number;
  settled: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useSummaryOpen();
  const box = useRef<HTMLElement>(null);
  const approvals = usePendingApprovals(sessionId);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const summary = useQuery({
    queryKey: ["summary", sessionId, entries],
    queryFn: () => pim.summary(sessionId),
    enabled: open && summaryOpen && settled && entries > 0,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    retry: false,
  });
  // A press outside the popup closes it. The header button toggles it itself, and
  // the menus the popup opens render outside it, so they count as inside.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !box.current?.contains(target) &&
        !target.closest(
          "[data-activity-toggle], [role=menu], [role=dialog], [data-radix-popper-content-wrapper]",
        )
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, setOpen]);
  if (!open && approvals.length === 0) return null;

  return (
    <aside
      ref={box}
      className="absolute top-2 right-(--scrollbar) z-30 flex max-h-[calc(100%-1rem)] w-80 max-w-[calc(100%-1.5rem)] flex-col pr-3 md:pr-0"
    >
      <div className="fade-in-0 min-h-0 animate-in overflow-y-auto rounded-[18px] border bg-popover text-popover-foreground shadow-[0_8px_30px_-6px_rgb(0_0_0/0.18)] duration-150">
        {approvals.length > 0 && (
          <section className="space-y-2 border-b p-3">
            <h2 className="px-1 text-[13px] text-muted-foreground">
              {t("waitingForYou")}
            </h2>
            {approvals.map((approval) => (
              <ApprovalBlock key={approval.id} approval={approval} />
            ))}
          </section>
        )}
        {open && (
          <>
            <div className="flex items-center gap-1 border-b px-2 py-1.5">
              <RoomMenu sessionId={sessionId} />
              <span className="ml-auto flex gap-0.5">
                <CopyConversation sessionId={sessionId} />
                <PinChat sessionId={sessionId} />
                <CopyChatId sessionId={sessionId} />
                <ChatLinkMenu sessionId={sessionId} />
                <ContextMeter sessionId={sessionId} />
                <SessionCostMenu sessionId={sessionId} />
              </span>
            </div>
            {/* The section's content mounts only while it's open, so the chat's activity is fetched only then. */}
            <BoxSection
              open={activityOpen}
              onOpenChange={setActivityOpen}
              label={
                <>
                  <Activity />
                  {t("activitySection")}
                </>
              }
            >
              <ChatRunActivity key={sessionId} chat={sessionId} />
            </BoxSection>
            <BoxSection
              open={summaryOpen}
              onOpenChange={setSummaryOpen}
              label={
                <>
                  <FileText />
                  {t("summary")}
                  {summary.isFetching && summary.data !== undefined && (
                    <Loader2
                      className="size-3 animate-spin"
                      aria-label={t("summarizing")}
                    />
                  )}
                </>
              }
            >
              {entries === 0 || summary.data === null ? (
                <p className="text-muted-foreground">
                  {t("nothingToSummarize")}
                </p>
              ) : summary.data !== undefined ? (
                <Markdown
                  text={summary.data}
                  untrusted
                  className="text-sm leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm"
                />
              ) : summary.error ? (
                <p className="flex items-start gap-2 text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  {summary.error.message}
                </p>
              ) : (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("summarizing")}
                </p>
              )}
            </BoxSection>
          </>
        )}
      </div>
    </aside>
  );
}
