import { useQuery } from "@tanstack/react-query";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { sessionContextQuery, sessionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A ring that fills as the context does, in the same box as the icons beside it, with a tick where the conversation is compacted. It reddens once it passes the tick. */
function Ring({
  fraction,
  compactAt,
}: {
  fraction: number;
  compactAt: number | null;
}) {
  return (
    <svg viewBox="0 0 18 18" className="size-4.5" aria-hidden="true">
      <circle
        cx="9"
        cy="9"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="opacity-25"
      />
      <circle
        cx="9"
        cy="9"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        transform="rotate(-90 9 9)"
        className={cn(
          compactAt !== null && fraction > compactAt && "text-destructive",
        )}
      />
      {compactAt !== null && (
        <line
          x1="9"
          y1="0.5"
          x2="9"
          y2="4"
          stroke="currentColor"
          strokeWidth="1.5"
          transform={`rotate(${compactAt * 360} 9 9)`}
        />
      )}
    </svg>
  );
}

/**
 * How much of its model's context this chat has used, as pi-durable counts it for its own compaction: the size of what the model was last asked with, and its answer.
 * The ring follows the chat live, from its line in the sidebar; the numbers are asked for when the context changes. Not offered before the chat's first answer, or in a
 * visit, whose agent is someone else's.
 */
export function ContextMeter({ sessionId }: { sessionId: string }) {
  const { t, formatNumber } = useI18n();
  const { data: sessions } = useQuery(sessionsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const tokens = session?.contextTokens;
  const { data: context } = useQuery({
    ...sessionContextQuery(sessionId, tokens),
    enabled: tokens !== undefined && !session?.visit,
  });
  if (!session || session.visit || tokens === undefined || !context)
    return null;
  const fraction = Math.min(1, context.tokens / context.window);
  const compactAt =
    context.compactAt === null ? null : context.compactAt / context.window;
  const percent = formatNumber(fraction, {
    style: "percent",
    maximumFractionDigits: 0,
  });
  const label = t("contextMeterUsed", { percent });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 self-center"
          aria-label={label}
          title={label}
        >
          <Ring fraction={fraction} compactAt={compactAt} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="font-medium text-sm">
          {label}
        </DropdownMenuLabel>
        <DropdownMenuLabel className="font-normal text-muted-foreground text-xs leading-5">
          {t("contextMeterTokens", {
            used: formatNumber(context.tokens),
            window: formatNumber(context.window),
            model: context.model,
          })}
          {context.compactAt !== null &&
            ` ${t("contextMeterCompacts", { compactAt: formatNumber(context.compactAt) })}`}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
