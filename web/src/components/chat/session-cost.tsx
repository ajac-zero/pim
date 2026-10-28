import { useQuery } from "@tanstack/react-query";
import { useI18n } from "~/components/i18n";
import { DollarSign } from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { sessionCostQuery, sessionsQuery } from "~/lib/queries";

/**
 * What this chat has cost so far, in total and by model. Not offered in a
 * visit, whose agent is someone else's. A model without a price, such as a
 * custom provider's, shows its tokens and costs nothing.
 */
export function SessionCostMenu({ sessionId }: { sessionId: string }) {
  const { t, formatNumber } = useI18n();
  const { data: sessions } = useQuery(sessionsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const { data: cost, refetch } = useQuery({
    ...sessionCostQuery(sessionId),
    enabled: !!session && !session.visit,
  });
  if (!session || session.visit) return null;
  const label = t("sessionCost");
  const money = (value: number) =>
    formatNumber(value, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: value < 1 ? 4 : 2,
    });
  return (
    <DropdownMenu onOpenChange={(open) => open && void refetch()}>
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
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="font-medium text-sm">
          {cost ? t("sessionCostTotal", { amount: money(cost.total) }) : label}
        </DropdownMenuLabel>
        {cost && cost.models.length === 0 && (
          <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
            {t("sessionCostNone")}
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
              {t("sessionCostRequests", { count: row.requests })} ·{" "}
              {t("sessionCostTokens", {
                input: formatNumber(row.input),
                output: formatNumber(row.output),
                cached: formatNumber(row.cacheRead + row.cacheWrite),
              })}
            </div>
          </DropdownMenuLabel>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
