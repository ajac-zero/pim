import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { FoldVertical, Loader2 } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { ApiError, pim } from "~/lib/pim-api";
import { sessionContextQuery, sessionsQuery } from "~/lib/queries";

/** How long to wait for the runtime to start summarizing before concluding it found nothing to summarize. */
const START_WAIT_MS = 10_000;
/** The sidebar row's context size and its compaction state arrive as separate updates; the outcome is read once both have. */
const SETTLE_MS = 600;

/** `failed` is the task of the last failure the chat showed, so a failure that was there already is not taken for this one's. */
type Request = { tokens: number; failed: number | null; started: boolean };

/**
 * Summarizes the chat's older messages now, the way the runtime does by itself near the end of the model's window: every message stays in the chat, and the model is sent the
 * summary and the most recent part from then on. It is offered while the agent is idle and the context holds more than a compaction keeps as it is. The chat's row in the sidebar
 * says when a compaction is under way and what the context holds after it, so the outcome (tokens before and after, nothing to summarize, or the error) is read from there.
 */
export function CompactChat({ sessionId }: { sessionId: string }) {
  const { t, formatNumber } = useI18n();
  const { data: sessions } = useQuery(sessionsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const tokens = session?.contextTokens;
  const { data: context } = useQuery({
    ...sessionContextQuery(sessionId, tokens),
    enabled: tokens !== undefined && !session?.visit,
  });
  const [request, setRequest] = useState<Request | null>(null);
  const failure = session?.compactionFailure ?? null;
  const latest = useRef({ tokens, failure });
  latest.current = { tokens, failure };
  const compacting = session?.compacting === true;

  // Once the runtime has started summarizing, its end is the outcome, or the context changing (a short compaction can start and end between two updates); if neither comes, it had nothing to summarize.
  useEffect(() => {
    if (request === null) return;
    if (compacting && !request.started) {
      setRequest({ ...request, started: true });
      return;
    }
    if (compacting) return;
    const timer = setTimeout(
      () => {
        const { tokens: after, failure } = latest.current;
        if (failure !== null && failure.task !== request.failed)
          toast.error(t("compactFailed", { error: failure.error }));
        else if (after !== undefined && after < request.tokens)
          toast.success(
            t("compactDone", {
              before: formatNumber(request.tokens),
              after: formatNumber(after),
            }),
          );
        else toast(t("compactUnchanged"));
        setRequest(null);
      },
      request.started || tokens !== request.tokens ? SETTLE_MS : START_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, [request, compacting, tokens, t, formatNumber]);

  let reason: string | null = null;
  if (session?.visit) reason = t("compactVisit");
  else if (session?.busy) reason = t("compactBusy");
  else if (
    tokens === undefined ||
    (context && context.tokens <= context.keepRecent)
  )
    reason = t("compactNothing");
  const working = request !== null || compacting;
  const label = working ? t("compactingChat") : (reason ?? t("compactChat"));
  return (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0 self-center"
      aria-label={label}
      title={label}
      aria-busy={working}
      disabled={working || reason !== null}
      onClick={async () => {
        if (tokens === undefined) return;
        setRequest({
          tokens,
          failed: failure?.task ?? null,
          started: false,
        });
        try {
          await pim.compactSession(sessionId);
        } catch (error) {
          setRequest(null);
          toast.error(
            error instanceof ApiError
              ? error.message
              : t("compactFailed", { error: String(error) }),
          );
        }
      }}
    >
      {working ? (
        <Loader2 className="size-4.5 animate-spin" />
      ) : (
        <FoldVertical className="size-4.5" />
      )}
    </Button>
  );
}
