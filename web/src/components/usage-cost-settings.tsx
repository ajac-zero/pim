import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Section } from "~/components/account-settings";
import { useI18n } from "~/components/i18n";
import { Loader2, TriangleAlert } from "~/components/icons";
import type { CostReport, TopSpender } from "~/lib/pim-api";
import { agentsQuery, sessionsQuery, usageCostsQuery } from "~/lib/queries";
import {
  type Dimension,
  OTHER,
  stackSeries,
  UNTAGGED,
} from "~/lib/usage-costs";
import { cn } from "~/lib/utils";

const RANGES = [7, 30, 90] as const;
const DIMENSIONS: [
  Dimension,
  "usageByAgent" | "usageByModel" | "usageByRunKind",
][] = [
  ["agent", "usageByAgent"],
  ["model", "usageByModel"],
  ["runKind", "usageByRunKind"],
];

const colorOf = (series: string, index: number) =>
  series === OTHER
    ? "hsl(0 0% 60%)"
    : `hsl(${(index * 47 + 215) % 360} 55% 55%)`;

const choiceClass = (on: boolean) =>
  cn(
    "rounded-md border px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
    on
      ? "bg-foreground text-background"
      : "text-muted-foreground hover:bg-muted",
  );

/** What the agents' model calls cost: totals, cost per day, and who spends it. */
export function UsageCostSection() {
  const { t } = useI18n();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const { data: report, isPending, isError } = useQuery(usageCostsQuery(days));
  return (
    <Section title={t("usageCostTitle")} description={t("usageCostBody")}>
      <div
        role="group"
        aria-label={t("usageRangeLabel")}
        className="flex gap-2"
      >
        {RANGES.map((range) => (
          <button
            key={range}
            type="button"
            aria-pressed={days === range}
            className={choiceClass(days === range)}
            onClick={() => setDays(range)}
          >
            {t("usageRangeDays", { days: range })}
          </button>
        ))}
      </div>
      {isPending ? (
        <Loader2
          className="mx-auto my-8 size-5 animate-spin text-muted-foreground"
          role="status"
          aria-label="Loading"
        />
      ) : isError ? (
        <p role="alert" className="text-destructive text-sm">
          {t("usageLoadFailed")}
        </p>
      ) : report.calls === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground text-sm">
          {t("usageEmpty")}
        </p>
      ) : (
        <CostReportView report={report} />
      )}
    </Section>
  );
}

export function CostReportView({ report }: { report: CostReport }) {
  const { t, formatNumber } = useI18n();
  return (
    <div className="space-y-6">
      {report.unpricedCalls > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-medium">
              {t("usageUnpriced", {
                count: formatNumber(report.unpricedCalls),
              })}
            </span>{" "}
            {t("usageUnpricedBody")}
          </p>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label={t("usageTotalCost")}
          value={dollars(report.totalCostUsd, formatNumber)}
        />
        <Stat label={t("usageCalls")} value={formatNumber(report.calls)} />
        <Stat
          label={t("usageCostPer1k")}
          value={
            report.costPer1kOutputTokens === null
              ? "–"
              : dollars(report.costPer1kOutputTokens, formatNumber)
          }
        />
        <Stat
          label={t("usageCacheHit")}
          value={percent(report.cacheHitRatio, formatNumber)}
        />
      </dl>
      <CostChart report={report} />
      <CacheChart report={report} />
      <TopTable title={t("usageTopChats")} rows={report.topChats} kind="chat" />
      <TopTable
        title={t("usageTopCodingThreads")}
        rows={report.topCodingThreads}
        kind="coding"
      />
    </div>
  );
}

type Format = (value: number, options?: Intl.NumberFormatOptions) => string;

const dollars = (value: number, format: Format) =>
  format(value, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  });

const percent = (ratio: number | null, format: Format) =>
  ratio === null
    ? "–"
    : format(ratio, { style: "percent", maximumFractionDigits: 0 });

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 font-semibold text-lg tabular-nums">{value}</dd>
    </div>
  );
}

function CostChart({ report }: { report: CostReport }) {
  const { t, formatNumber } = useI18n();
  const [dimension, setDimension] = useState<Dimension>("agent");
  const { data: agents } = useQuery(agentsQuery());
  const { series, days } = stackSeries(report.byDay, dimension);
  const label = (key: string) =>
    key === UNTAGGED
      ? t("usageUntagged")
      : key === OTHER
        ? t("usageOther")
        : dimension === "agent"
          ? (agents?.find((agent) => agent.id === key)?.name ?? key)
          : key;
  const max = Math.max(...days.map((day) => day.total), 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">{t("usageCostPerDay")}</h3>
        <div
          role="group"
          aria-label={t("usageSplitBy")}
          className="flex gap-1.5"
        >
          {DIMENSIONS.map(([id, name]) => (
            <button
              key={id}
              type="button"
              aria-pressed={dimension === id}
              className={choiceClass(dimension === id)}
              onClick={() => setDimension(id)}
            >
              {t(name)}
            </button>
          ))}
        </div>
      </div>
      <div
        role="img"
        aria-label={t("usageCostPerDay")}
        className="flex h-40 items-end gap-px"
      >
        {days.map((day) => (
          <div
            key={day.day}
            className="flex h-full min-w-0 flex-1 flex-col-reverse"
            title={`${day.day}: ${dollars(day.total, formatNumber)}`}
          >
            {series.map((key, index) =>
              day.parts[key] ? (
                <div
                  key={key}
                  style={{
                    height: `${(day.parts[key] / max) * 100}%`,
                    background: colorOf(key, index),
                  }}
                />
              ) : null,
            )}
          </div>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {series.map((key, index) => (
          <li key={key} className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-sm"
              style={{ background: colorOf(key, index) }}
            />
            {label(key)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The cache hit ratio of each day as a line; a day with no tokens leaves a gap. */
function CacheChart({ report }: { report: CostReport }) {
  const { t, formatNumber } = useI18n();
  const count = report.byDay.length;
  const x = (index: number) => (count < 2 ? 50 : (index / (count - 1)) * 100);
  const path = report.byDay
    .map((day, index) =>
      day.cacheHitRatio === null
        ? null
        : `${index > 0 && report.byDay[index - 1]?.cacheHitRatio != null ? "L" : "M"}${x(index)},${(1 - day.cacheHitRatio) * 100}`,
    )
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-2">
      <h3 className="font-medium text-sm">{t("usageCacheHitPerDay")}</h3>
      <svg
        role="img"
        aria-label={t("usageCacheHitPerDay")}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-20 w-full rounded-lg border bg-muted/20"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          className="text-primary"
        />
        {report.byDay.map((day, index) =>
          day.cacheHitRatio === null ? null : (
            <circle
              key={day.day}
              cx={x(index)}
              cy={(1 - day.cacheHitRatio) * 100}
              r={0}
              vectorEffect="non-scaling-stroke"
            >
              <title>{`${day.day}: ${percent(day.cacheHitRatio, formatNumber)}`}</title>
            </circle>
          ),
        )}
      </svg>
    </div>
  );
}

function TopTable({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: TopSpender[];
  kind: "chat" | "coding";
}) {
  const { t, formatNumber } = useI18n();
  const { data: sessions } = useQuery({
    ...sessionsQuery(),
    enabled: kind === "chat",
  });
  if (rows.length === 0) return null;
  const name = (id: string) =>
    kind === "chat"
      ? (sessions?.find((session) => session.id === id)?.title ??
        t("usageUntitledChat"))
      : id;
  return (
    <div className="space-y-2">
      <h3 className="font-medium text-sm">{title}</h3>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 font-normal">{t("usageColName")}</th>
              <th className="px-3 py-2 text-right font-normal">
                {t("usageColCost")}
              </th>
              <th className="px-3 py-2 text-right font-normal">
                {t("usageColCalls")}
              </th>
              <th className="px-3 py-2 text-right font-normal">
                {t("usageColMaxTurns")}
              </th>
              <th className="px-3 py-2 text-right font-normal">
                {t("usageColPromptKb")}
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="max-w-48 truncate px-3 py-2">
                  {kind === "chat" ? (
                    <Link
                      to="/chat/$sessionId"
                      params={{ sessionId: row.id }}
                      className="text-link underline-offset-2 hover:underline"
                    >
                      {name(row.id)}
                    </Link>
                  ) : (
                    <Link
                      to="/coding/$threadId"
                      params={{ threadId: row.id }}
                      className="text-link underline-offset-2 hover:underline"
                    >
                      {name(row.id)}
                    </Link>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {dollars(row.costUsd, formatNumber)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatNumber(row.calls)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatNumber(row.turns)}
                </td>
                <td className="px-3 py-2 text-right">
                  {formatNumber(row.avgPromptBytes / 1024, {
                    maximumFractionDigits: 1,
                  })}{" "}
                  KB
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
