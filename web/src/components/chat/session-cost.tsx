import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "~/components/i18n";
import { ChevronDown, ChevronRight, DollarSign } from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  sessionCostQuery,
  sessionsQuery,
  sessionTurnsQuery,
} from "~/lib/queries";

/**
 * What this chat has cost so far, in total and by model, with every agent
 * that has talked in it and every context it has had. Not offered in a
 * visit, whose agent is someone else's. A model without a price, such as a
 * custom provider's, shows its tokens and costs nothing.
 */
export function SessionCostMenu({ sessionId }: { sessionId: string }) {
  const { t, formatNumber } = useI18n();
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: sessions } = useQuery(sessionsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const { data: cost, refetch } = useQuery({
    ...sessionCostQuery(sessionId),
    enabled: !!session && !session.visit,
  });
  const turns = useQuery({
    ...sessionTurnsQuery(sessionId),
    enabled: !!session && !session.visit && historyOpen,
  });
  if (!session || session.visit) return null;
  const percent = (ratio: number) =>
    formatNumber(ratio, { style: "percent", maximumFractionDigits: 0 });
  const label = t("sessionCost");
  const money = (value: number) =>
    formatNumber(value, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: value < 1 ? 4 : 2,
    });
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void refetch();
        else setHistoryOpen(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 self-center"
          aria-label={label}
          title={label}
        >
          <DollarSign className="size-4.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(22rem,calc(100vw-1rem))]"
      >
        <DropdownMenuLabel className="font-medium text-sm">
          {cost ? t("sessionCostTotal", { amount: money(cost.total) }) : label}
        </DropdownMenuLabel>
        {cost && cost.models.length === 0 && (
          <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
            {t("sessionCostNone")}
          </DropdownMenuLabel>
        )}
        {cost && cost.models.length > 0 && (
          <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
            {cost.cacheHitRatio === null
              ? t("sessionCostHitRateUnknown")
              : t("sessionCostHitRate", {
                  percent: percent(cost.cacheHitRatio),
                })}
          </DropdownMenuLabel>
        )}
        {cost?.models.map((row) => (
          <DropdownMenuLabel
            key={`${row.provider}/${row.model}`}
            className="font-normal"
          >
            <div className="flex justify-between gap-3 text-sm">
              <span className="truncate">{row.model}</span>
              <span className="shrink-0">{money(row.cost)}</span>
            </div>
            <div className="text-muted-foreground text-xs leading-5">
              {t("sessionCostTokens", {
                input: formatNumber(row.input),
                output: formatNumber(row.output),
                cached: formatNumber(row.cacheRead + row.cacheWrite),
              })}
            </div>
          </DropdownMenuLabel>
        ))}
        {cost && cost.models.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setHistoryOpen((open) => !open);
              }}
              aria-expanded={historyOpen}
              className="text-sm"
            >
              {historyOpen ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
              {t("sessionCostTurns")}
            </DropdownMenuItem>
            {historyOpen && (
              <div className="h-64 overflow-y-auto overscroll-contain px-2 pb-1">
                {turns.isError ? (
                  <p className="px-1 py-2 text-muted-foreground text-xs">
                    {t("sessionCostTurnsFailed")}
                  </p>
                ) : !turns.data ? (
                  <p className="px-1 py-2 text-muted-foreground text-xs">
                    {t("sessionCostTurnsLoading")}
                  </p>
                ) : turns.data.length === 0 ? (
                  <p className="px-1 py-2 text-muted-foreground text-xs">
                    {t("sessionCostTurnsNone")}
                  </p>
                ) : (
                  <ul>
                    {turns.data.map((turn) => (
                      <li
                        key={turn.id}
                        className="border-border border-t py-1.5 first:border-t-0"
                      >
                        <div className="flex justify-between gap-3 text-xs tabular-nums">
                          <span className="min-w-0 truncate">
                            {new Date(turn.at).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}{" "}
                            · {turn.model}
                          </span>
                          <span className="shrink-0">
                            {turn.hitRatio === null
                              ? "–"
                              : percent(turn.hitRatio)}{" "}
                            · {money(turn.cost)}
                          </span>
                        </div>
                        <div className="text-muted-foreground text-xs leading-5 tabular-nums">
                          {t("sessionCostTurnTokens", {
                            input: formatNumber(turn.input),
                            read: formatNumber(turn.cacheRead),
                            write: formatNumber(turn.cacheWrite),
                            output: formatNumber(turn.output),
                          })}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
