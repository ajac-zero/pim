import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { type TranslationKey, useI18n } from "~/components/i18n";
import {
  ArrowLeft,
  Check,
  Copy,
  Plus,
  TriangleAlert,
} from "~/components/icons";
import { EmptyState, Page } from "~/components/page";
import { Button } from "~/components/ui/button";
import {
  type Agent,
  type Approval,
  pim,
  type Session,
  TRIGGER_HEALTHS,
  TRIGGER_LIFECYCLES,
  TRIGGER_SOURCE_KINDS,
  type Trigger,
  type TriggerDryRun,
  type TriggerExpression,
  type TriggerHealth,
  type TriggerLifecycle,
  type TriggerMigrationItem,
  type TriggerRun,
  type TriggerSourceKind,
} from "~/lib/pim-api";
import {
  agentsQuery,
  approvalsQuery,
  computerQuery,
  schedulesQuery,
  sessionsQuery,
  settingsQuery,
  triggerMigrationQuery,
  triggerQuery,
  triggerRunsQuery,
  triggersAvailableQuery,
  triggersQuery,
} from "~/lib/queries";
import {
  browserTimeZone,
  conditionText,
  conditionWords,
  cronWords,
  decideGrant,
  durationText,
  type GrantStanding,
  HEALTH_PROBLEMS,
  HEALTH_TEXT,
  healthChip,
  LIFECYCLE_TEXT,
  MAX_PAGES,
  MIGRATION_STATUS_TEXT,
  migrationReason,
  needsReload,
  nextLine,
  observesSource,
  PROBLEM_TEXT,
  RUN_REASON,
  RUN_TEXT,
  runsCommands,
  runsOnComputer,
  SOURCE_TEXT,
  type TriggerProblem,
  triggerProblem,
  triggerZone,
  upperFirst,
  withHealth,
} from "~/lib/triggers";
import { cn } from "~/lib/utils";

/*
 * Triggers: work an agent does when something happens (docs/triggers.md).
 * Everything here reads the API's answers as they are: a lifecycle is what
 * the person wants and health is how the source is doing, shown apart; a
 * date shows only where Pim gave one; and a run that ended says the agent
 * finished, never that the work in the world succeeded.
 */

/** Whether the space has triggers. False, or not yet known, shows nothing of them. */
export function useTriggersAvailable(): boolean {
  const { data } = useQuery(triggersAvailableQuery());
  return data === true;
}

type Tone = "muted" | "done" | "problem" | "active";

const PILL_TONES: Record<Tone, string> = {
  muted: "bg-muted text-foreground",
  active: "bg-muted text-foreground",
  done: "bg-muted text-foreground",
  problem: "bg-muted text-foreground",
};
const DOT_TONES: Record<Tone, string> = {
  muted: "bg-muted-foreground/60",
  active: "bg-foreground/70",
  done: "bg-success",
  problem: "bg-destructive",
};

/** A status pill: a dot and a label, with what it is the status of for screen readers. */
function Pill({
  tone,
  of,
  children,
}: {
  tone: Tone;
  of: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px]",
        PILL_TONES[tone],
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", DOT_TONES[tone])}
      />
      <span className="sr-only">{of}: </span>
      {children}
    </span>
  );
}

export function LifecyclePill({ lifecycle }: { lifecycle: TriggerLifecycle }) {
  const { t } = useI18n();
  return (
    <Pill
      tone={lifecycle === "enabled" ? "done" : "muted"}
      of={t("triggerLifecycle")}
    >
      {t(LIFECYCLE_TEXT[lifecycle])}
    </Pill>
  );
}

/** The health chip, or nothing for a trigger that isn't on. Its words say what it means; only the dot is colored, and green is for healthy alone. */
export function HealthPill({ trigger }: { trigger: Trigger }) {
  const { t } = useI18n();
  const chip = healthChip(trigger);
  if (!chip) return null;
  const { health } = trigger;
  const tone: Tone = chip.reason
    ? "muted"
    : HEALTH_PROBLEMS.includes(health)
      ? "problem"
      : health === "healthy"
        ? "done"
        : "muted";
  return (
    <>
      <Pill tone={tone} of={t("triggerHealth")}>
        {t(chip.text)}
      </Pill>
      {chip.reason && (
        <span className="basis-full text-[13px] text-muted-foreground">
          {chip.reason}
        </span>
      )}
    </>
  );
}

function useFormats() {
  const { t, locale, formatDate } = useI18n();
  // The zone is always written out, so an exact time never depends on hovering.
  const date = (at: number, timeZone?: string) =>
    formatDate(new Date(at), {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      ...(timeZone ? { timeZone } : {}),
    });
  /**
   * A time in the trigger's own zone, named by its place, with UTC after it:
   * "Nov 9, 8:00 AM Lisbon time (7:00 AM UTC)". Without a zone, the plain date.
   */
  const zonedParts = (at: number, timeZone?: string) => {
    if (!timeZone || timeZone === "UTC" || timeZone === "Etc/UTC") {
      return { plain: date(at, timeZone), zone: null };
    }
    const when = new Date(at);
    const day: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    const time: Intl.DateTimeFormatOptions = {
      hour: "numeric",
      minute: "2-digit",
    };
    // The year shows only when it isn't this one, the zone's own year included.
    const year = (zone: string) =>
      formatDate(when, { year: "numeric", timeZone: zone }) ===
      formatDate(new Date(), { year: "numeric", timeZone: zone })
        ? {}
        : { year: "numeric" as const };
    try {
      const local = formatDate(when, {
        ...year(timeZone),
        ...day,
        ...time,
        timeZone,
      });
      const sameDay =
        formatDate(when, { ...day, timeZone }) ===
        formatDate(when, { ...day, timeZone: "UTC" });
      const utc = formatDate(when, {
        ...(sameDay ? {} : { ...year("UTC"), ...day }),
        ...time,
        timeZone: "UTC",
        timeZoneName: "short",
      });
      const place = (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");
      return { plain: null, zone: { local, place, utc } };
    } catch {
      return { plain: date(at), zone: null };
    }
  };
  const zoned = (at: number, timeZone?: string) => {
    const parts = zonedParts(at, timeZone);
    return parts.zone ? t("triggerZonedTime", parts.zone) : parts.plain;
  };
  /** The same time as markup: the zone's time first, UTC after it in smaller, muted text. */
  const zonedNode = (at: number, timeZone?: string): ReactNode => {
    const parts = zonedParts(at, timeZone);
    if (!parts.zone) return parts.plain;
    return (
      <>
        {t("triggerZonedPrimary", parts.zone)}
        <span className="text-[0.85em] text-muted-foreground">
          {t("triggerZonedUtc", parts.zone)}
        </span>
      </>
    );
  };
  /** A sentence with `{date}` in it, whose time is the markup above. */
  const sentence = (
    key: TranslationKey,
    params: Record<string, string | number>,
    at: number,
    timeZone?: string,
  ): ReactNode => {
    const [before, after = ""] = t(key, { ...params, date: "\u0000" }).split(
      "\u0000",
    );
    return (
      <>
        {before}
        {zonedNode(at, timeZone)}
        {after}
      </>
    );
  };
  const duration = (ms: number) => durationText(ms, locale);
  return { t, date, zoned, zonedNode, sentence, duration };
}

/** When a trigger acts next, in words, with a date only where Pim gave one. */
export function NextText({ trigger }: { trigger: Trigger }) {
  const { t, sentence, duration } = useFormats();
  const next = nextLine(trigger);
  const params = {
    ...(next.minutes === undefined ? {} : { minutes: next.minutes }),
    ...(next.everyMs === undefined ? {} : { duration: duration(next.everyMs) }),
  };
  return next.at === undefined ? (
    <>{t(next.key, params)}</>
  ) : (
    <>{sentence(next.key, params, next.at, triggerZone(trigger))}</>
  );
}

/** When a one-time trigger would run, in the person's own zone. */
export function NextAtText({ at }: { at: number }) {
  const { t, zoned } = useFormats();
  return <>{t("triggerNextAt", { date: zoned(at, browserTimeZone()) })}</>;
}

/** A refusal or failure, in words, with what the person can do about it. */
export function ProblemNotice({
  problem,
  onReload,
}: {
  problem: TriggerProblem;
  /** Loads the trigger again so the person can review it; for a revision conflict or a missing revision. */
  onReload?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm"
    >
      <p className="flex items-start gap-2 text-destructive">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          {t(PROBLEM_TEXT[problem.code])}
          {problem.code === "revision_conflict" &&
            problem.currentRevision !== undefined &&
            ` ${t("triggerConflictRevision", { revision: problem.currentRevision })}`}
        </span>
      </p>
      {/* Pim's message names fields, never values; it says which one. */}
      {(problem.code === "invalid_request" ||
        problem.code === "unknown" ||
        problem.field) && (
        <p className="text-muted-foreground">{problem.message}</p>
      )}
      {needsReload(problem) && onReload && (
        <div>
          <Button type="button" variant="secondary" onClick={onReload}>
            {t("triggerReloadReview")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Shown in place of the screens where the space has no triggers. */
export function Unavailable() {
  const { t } = useI18n();
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-muted-foreground">{t("triggersUnavailable")}</p>
    </main>
  );
}

/** The visible focus ring of a link, as buttons and fields have. */
const LINK_RING =
  "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const FIELD_CLASS =
  "h-10 w-full rounded-xl border bg-background px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring";

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | "";
  options: readonly { value: T; label: string }[];
  onChange: (value: T | "") => void;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="flex w-36 shrink-0 flex-col gap-1.5 md:w-auto md:min-w-0">
      <label htmlFor={id} className="text-[13px] text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as T | "")}
        className={FIELD_CLASS}
      >
        <option value="">{t("triggerFilterAll")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const agentName = (agents: readonly Agent[] | undefined, id: string) =>
  agents?.find((agent) => agent.id === id)?.name ?? id;

/** Every trigger of the space, filtered, a page at a time. */
export function TriggersPage() {
  const { t } = useI18n();
  const [lifecycle, setLifecycle] = useState<TriggerLifecycle | "">("");
  const [health, setHealth] = useState<TriggerHealth | "">("");
  const [sourceKind, setSourceKind] = useState<TriggerSourceKind | "">("");
  const [agentId, setAgentId] = useState("");
  const filters = {
    ...(lifecycle ? { lifecycle } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(agentId ? { agentId } : {}),
  };
  const list = useInfiniteQuery(triggersQuery(filters));
  const { data: agents } = useQuery(agentsQuery());
  const migration = useQuery(triggerMigrationQuery());
  const { data: schedules } = useQuery(schedulesQuery());
  const failure = list.error ? triggerProblem(list.error) : null;
  if (failure?.code === "unavailable") return <Unavailable />;
  // A failed refetch keeps the earlier list; only a first load that failed is an error state.
  const stale = !!list.data && !!failure;
  const problem = stale ? null : failure;

  const loaded = list.data?.pages.flatMap((page) => page.triggers) ?? [];
  const shown = withHealth(loaded, health || undefined);
  const pages = list.data?.pages.length ?? 0;
  const applied = [lifecycle, health, sourceKind, agentId].filter(
    Boolean,
  ).length;
  const filtered = applied > 0;
  // Schedules and watches still delivered as before: a shadow's on its trigger's row, the rest in a list of their own, by the filters that apply to them.
  const stillLegacy = (migration.data ?? []).filter(
    (item) => item.owner === "legacy",
  );
  const legacyOf = new Map(
    stillLegacy.flatMap((item) =>
      item.triggerId === null ? [] : [[item.triggerId, item] as const],
    ),
  );
  const legacy =
    lifecycle || health
      ? []
      : stillLegacy.filter(
          (item) =>
            item.triggerId === null &&
            (!agentId || item.agentId === agentId) &&
            (!sourceKind ||
              sourceKind ===
                (item.kind === "schedule" ? "time" : "connector_event")),
        );
  const clearFilters = () => {
    setLifecycle("");
    setHealth("");
    setSourceKind("");
    setAgentId("");
  };

  return (
    <Page title={t("triggers")} description={t("triggersDescription")}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Button asChild>
          <Link to="/triggers/new">
            <Plus />
            {t("newTrigger")}
          </Link>
        </Button>
      </div>
      <div className="relative mb-4">
        <fieldset className="-mx-1 flex min-w-0 gap-3 overflow-x-auto px-1 pb-1 md:mx-0 md:grid md:grid-cols-4 md:overflow-visible md:px-0 max-md:pr-12">
          <legend className="sr-only">{t("triggerFilters")}</legend>
          <FilterSelect
            label={t("triggerLifecycle")}
            value={lifecycle}
            onChange={setLifecycle}
            options={TRIGGER_LIFECYCLES.map((value) => ({
              value,
              label: t(LIFECYCLE_TEXT[value]),
            }))}
          />
          <FilterSelect
            label={t("triggerSource")}
            value={sourceKind}
            onChange={setSourceKind}
            options={TRIGGER_SOURCE_KINDS.map((value) => ({
              value,
              label: t(SOURCE_TEXT[value]),
            }))}
          />
          <FilterSelect
            label={t("triggerAgent")}
            value={agentId}
            onChange={setAgentId}
            options={(agents ?? []).map((agent) => ({
              value: agent.id,
              label: agent.name,
            }))}
          />
          <FilterSelect
            label={t("triggerHealth")}
            value={health}
            onChange={setHealth}
            options={TRIGGER_HEALTHS.map((value) => ({
              value,
              label: t(HEALTH_TEXT[value]),
            }))}
          />
        </fieldset>
        {/* The fade is a gradient laid over a wrapper, not a mask on the scrolling fieldset: a mask there never showed. */}
        <div
          aria-hidden="true"
          data-testid="filters-fade"
          className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-linear-to-r from-transparent to-background md:hidden"
        />
      </div>
      {filtered && (
        <div className="mb-4 flex items-center gap-3 text-[13px] text-muted-foreground">
          <span>
            {t(applied === 1 ? "triggerFiltersOne" : "triggerFiltersCount", {
              count: applied,
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearFilters}
          >
            {t("triggerFiltersClear")}
          </Button>
        </div>
      )}
      {stale && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm"
        >
          <p className="flex items-start gap-2 text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {t("triggersStale")}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={list.isFetching}
            onClick={() => list.refetch()}
          >
            {t("triggersRetry")}
          </Button>
        </div>
      )}
      {health && (
        <p className="mb-4 text-[13px] text-muted-foreground">
          {t("triggerHealthFilterNote")}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {problem
          ? t(PROBLEM_TEXT[problem.code])
          : list.isPending
            ? t("triggersLoading")
            : list.data
              ? t(filtered ? "triggersShownFiltered" : "triggersShown", {
                  count: shown.length,
                })
              : ""}
      </p>
      {problem ? (
        <ProblemNotice problem={problem} />
      ) : list.isPending ? (
        <p className="py-6 text-muted-foreground text-sm">
          {t("triggersLoading")}
        </p>
      ) : shown.length === 0 ? (
        filtered ? (
          <EmptyState icon={<Plus />} text={t("triggersNoneMatch")} />
        ) : (
          <NoTriggers />
        )
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((trigger) => (
            <TriggerRow
              key={trigger.id}
              trigger={trigger}
              agent={agentName(agents, trigger.agentId)}
              migration={legacyOf.get(trigger.id)}
            />
          ))}
        </ul>
      )}
      {list.hasNextPage &&
        (pages < MAX_PAGES ? (
          <div className="mt-4">
            <Button
              type="button"
              variant="secondary"
              disabled={list.isFetchingNextPage}
              onClick={() => list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? t("loading") : t("triggersMore")}
            </Button>
          </div>
        ) : (
          <p className="mt-4 text-[13px] text-muted-foreground">
            {t("triggersBounded", { count: loaded.length })}
          </p>
        ))}
      {legacy.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[15px]">{t("triggerLegacyTitle")}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {t("triggerLegacyHint")}
          </p>
          <ul className="mt-2 divide-y divide-border">
            {legacy.map((item) => (
              <LegacyRow
                key={`${item.kind}:${item.legacyId}`}
                item={item}
                instruction={
                  schedules?.find((schedule) => schedule.id === item.legacyId)
                    ?.instruction
                }
                agent={item.agentId ? agentName(agents, item.agentId) : null}
              />
            ))}
          </ul>
        </section>
      )}
      {migration.isError && (
        <p role="alert" className="mt-8 text-[13px] text-destructive">
          {t("triggerLegacyFailed")}
        </p>
      )}
    </Page>
  );
}

/** Where a schedule or watch stands in its move to triggers. */
function MigrationPill({ item }: { item: TriggerMigrationItem }) {
  const { t } = useI18n();
  const { key, tone } = MIGRATION_STATUS_TEXT[item.status];
  return (
    <Pill tone={tone} of={t("triggerMigration")}>
      {t(key)}
    </Pill>
  );
}

/** Why a schedule or watch stands where it does, in words. */
function MigrationReason({ item }: { item: TriggerMigrationItem }) {
  const { t } = useI18n();
  const why = migrationReason(item);
  return (
    <p className="mt-0.5 break-words text-[13px] text-muted-foreground">
      {t(why.key, why.reason ? { reason: why.reason } : undefined)}
    </p>
  );
}

/**
 * A schedule or watch that hasn't moved to triggers and has no trigger to
 * show it: what it is, when it runs next, and why it stays. A schedule can
 * be cancelled here, as the old Schedules list could.
 */
function LegacyRow({
  item,
  instruction,
  agent,
}: {
  item: TriggerMigrationItem;
  /** The schedule's instruction, for one without a label. */
  instruction: string | undefined;
  agent: string | null;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const kind = t(
    item.kind === "schedule" ? "triggerLegacySchedule" : "triggerLegacyWatch",
  );
  // Cancelling asks twice: the first click turns the button into a confirmation.
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => pim.cancelSchedule(item.legacyId),
    onSuccess: () => {
      toast.success(t("scheduleCancelled"));
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["triggers", "migration"] });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <li className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px]" title={instruction}>
          {item.label ?? instruction ?? kind}
        </p>
        <p className="mt-0.5 break-words text-[14px]">
          {item.nextFiringAt !== null ? (
            <NextAtText at={item.nextFiringAt} />
          ) : (
            t(
              item.kind === "schedule"
                ? "triggerNextLegacySchedule"
                : "triggerNextLegacyWatch",
            )
          )}
        </p>
        <p className="mt-0.5 break-words text-[12px] text-muted-foreground">
          {agent ? `${agent} · ${kind}` : kind}
        </p>
        <MigrationReason item={item} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <MigrationPill item={item} />
        {item.kind === "schedule" && (
          <Button
            type="button"
            variant={confirming ? "destructive" : "ghost"}
            size="sm"
            disabled={cancel.isPending}
            onClick={() => (confirming ? cancel.mutate() : setConfirming(true))}
          >
            {t(confirming ? "confirmCancelSchedule" : "cancelSchedule")}
          </Button>
        )}
      </div>
    </li>
  );
}

const EXAMPLE_PROMPTS = [
  "triggerExample1",
  "triggerExample2",
  "triggerExample3",
] as const;

/** What a person with no triggers sees: what they are, and prompts to ask an agent for one. */
function NoTriggers() {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-3 py-6">
      <div>
        <h2 className="text-[15px]">{t("triggersNone")}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t("triggersNoneHint")}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {EXAMPLE_PROMPTS.map((key) => (
          <li
            key={key}
            className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
          >
            <span className="min-w-0 text-[14px]">{t(key)}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={async () => {
                await navigator.clipboard.writeText(t(key));
                setCopied(key);
              }}
            >
              {copied === key ? <Check /> : <Copy />}
              {t(copied === key ? "copied" : "copy")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TriggerRow({
  trigger,
  agent,
  migration,
}: {
  trigger: Trigger;
  agent: string;
  /** Where the schedule or watch this trigger shadows stands, while that still delivers it. */
  migration?: TriggerMigrationItem;
}) {
  const { t } = useI18n();
  return (
    <li className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <Link
          to="/triggers/$triggerId"
          params={{ triggerId: trigger.id }}
          className={cn(
            "block truncate text-[15px] underline-offset-2 hover:underline focus-visible:underline",
            LINK_RING,
          )}
        >
          {trigger.label}
        </Link>
        <p className="mt-0.5 break-words text-[14px]">
          <NextText trigger={trigger} />
        </p>
        <p className="mt-0.5 break-words text-[12px] text-muted-foreground">
          {agent} · {t(SOURCE_TEXT[trigger.source.kind])}
        </p>
        {migration && <MigrationReason item={migration} />}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <LifecyclePill lifecycle={trigger.lifecycle} />
        <HealthPill trigger={trigger} />
        {migration && <MigrationPill item={migration} />}
      </div>
    </li>
  );
}

export function BackLink() {
  const { t } = useI18n();
  return (
    <Link
      to="/triggers"
      className={cn(
        "inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground",
        LINK_RING,
      )}
    >
      <ArrowLeft className="size-4" />
      {t("allTriggers")}
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="mb-2 text-[13px] text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-[13px] text-muted-foreground sm:w-44">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-[15px]">{children}</dd>
    </div>
  );
}

const GRANT_TEXT: Record<Trigger["grant"]["state"], TranslationKey> = {
  not_required: "triggerGrantNotRequired",
  missing: "triggerGrantMissing",
  pending_approval: "triggerGrantPending",
  current: "triggerGrantCurrent",
  not_current: "triggerGrantNotCurrent",
};

function capabilityKey(capability: Trigger["capability"]): TranslationKey {
  if (capability.status === "available") return "triggerCapabilityAvailable";
  if (capability.reason === "computer_not_paired") {
    return "triggerPairComputerFirst";
  }
  if (capability.status === "draft_only") return "triggerCapabilityDraftOnly";
  return "triggerCapabilityUnavailable";
}

/** A line under words that gives what they were made from, smaller. */
function Exact({ children }: { children: ReactNode }) {
  return (
    <span className="block text-[13px] text-muted-foreground">{children}</span>
  );
}

/** A cron expression in words, with the expression and its zone beneath; as it is when it has no words. */
function CronText({
  expression,
  timeZone,
}: {
  expression: string;
  timeZone: string;
}) {
  const i18n = useI18n();
  const words = cronWords(expression, timeZone, i18n);
  if (words === null) {
    return <>{i18n.t("triggerCronIn", { expression, timeZone })}</>;
  }
  return (
    <>
      {words}
      <Exact>
        <code className="font-mono">{expression}</code> · {timeZone}
      </Exact>
    </>
  );
}

/** A condition in words, with the expression beneath; as it is when it has no words. */
export function ConditionText({
  expression,
}: {
  expression: TriggerExpression;
}) {
  const i18n = useI18n();
  const words = conditionWords(expression, i18n);
  const exact = (
    <code className="font-mono text-sm">{conditionText(expression)}</code>
  );
  if (words === null) return exact;
  return (
    <>
      {upperFirst(words, i18n.locale)}
      <Exact>{exact}</Exact>
    </>
  );
}

/** What a source watches, in words. Arguments a connector takes aren't shown, only that it has some. */
export function SourceText({ source }: { source: Trigger["source"] }) {
  const { t, date, duration } = useFormats();
  switch (source.kind) {
    case "time":
      if (source.schedule === "cron") {
        return (
          <CronText expression={source.expression} timeZone={source.timeZone} />
        );
      }
      return (
        <>
          {source.schedule === "once"
            ? t("triggerOnceAt", { date: date(source.at) })
            : t("triggerEvery", { duration: duration(source.everyMs) })}
        </>
      );
    case "connector_event":
      return (
        <>
          {t("triggerConnectorEvent", {
            event: source.event,
            connector: source.connectorId,
          })}
          {Object.keys(source.arguments ?? {}).length > 0 && (
            <Exact>{t("triggerArgumentsHidden")}</Exact>
          )}
        </>
      );
    case "poll":
    case "stream":
      return (
        <>
          {source.kind === "poll"
            ? t("triggerPollEvery", { duration: duration(source.intervalMs) })
            : t("triggerStreamLines")}
          <code className="mt-1 block whitespace-pre-wrap break-all rounded-lg bg-muted px-2 py-1 font-mono text-sm">
            {source.command}
          </code>
          {source.cwd && (
            <span className="block text-[13px] text-muted-foreground">
              {t("triggerInFolder", { cwd: source.cwd })}
            </span>
          )}
        </>
      );
    case "process":
      return (
        <>
          {t("triggerProcessExit", {
            handle: source.handle,
            date: date(source.expiresAt),
          })}
        </>
      );
    case "file":
      return <>{t("triggerFileChanges", { path: source.path })}</>;
  }
}

/** Commands from a computer source run as the person's own user, with all its access. */
export function ComputerDisclosure() {
  const { t } = useI18n();
  return (
    <p className="rounded-xl bg-muted px-4 py-3 text-sm">
      {t("triggerComputerAccess")}
    </p>
  );
}

/**
 * Says a computer source needs a paired computer, near the top of its page
 * and form. It shows only once the status says none is paired: never while
 * it loads or fails to load, so it can't claim what isn't known.
 */
export function PairComputerNote({
  kind,
}: {
  kind: Trigger["source"]["kind"];
}) {
  const { t } = useI18n();
  const computer = useQuery({
    ...computerQuery(),
    enabled: runsOnComputer(kind),
  });
  if (!runsOnComputer(kind) || computer.data?.state !== "none") return null;
  return (
    <p role="note" className="mt-4 rounded-xl bg-muted px-4 py-3 text-sm">
      {t("triggerPairComputerNote")}
    </p>
  );
}

/** When a source acts, in words, from its own fields. */
export function WhenText({ source }: { source: Trigger["source"] }) {
  const { t, duration } = useFormats();
  switch (source.kind) {
    case "time":
      return <SourceText source={source} />;
    case "connector_event":
      return (
        <>
          {t("triggerFrequencyConnector", {
            event: source.event,
            connector: source.connectorId,
          })}
        </>
      );
    case "poll":
      return (
        <>{t("triggerEvery", { duration: duration(source.intervalMs) })}</>
      );
    case "stream":
      return <>{t("triggerFrequencyStream")}</>;
    case "process":
      return <>{t("triggerFrequencyProcess")}</>;
    case "file":
      return <>{t("triggerFrequencyFile", { path: source.path })}</>;
  }
}

/** What a source looks at, in words; a time source looks at nothing. */
export function ObservedText({ source }: { source: Trigger["source"] }) {
  const { t, date } = useFormats();
  switch (source.kind) {
    case "time":
      return <>{t("triggerObserveNothing")}</>;
    case "connector_event":
      return (
        <>
          {t("triggerConnectorEvent", {
            event: source.event,
            connector: source.connectorId,
          })}
        </>
      );
    case "poll":
      return <>{t("triggerObservePoll", { command: source.command })}</>;
    case "stream":
      return <>{t("triggerObserveStream", { command: source.command })}</>;
    case "process":
      return (
        <>
          {t("triggerObserveProcess", {
            handle: source.handle,
            date: date(source.expiresAt),
          })}
        </>
      );
    case "file":
      return <>{t("triggerFileChanges", { path: source.path })}</>;
  }
}

/**
 * What turning a computer source on lets it do, read before the person
 * confirms. The trigger doesn't name its computer, so the name is the one the
 * space's computer last reported; the script's version is the trigger's
 * revision, which turning it on names; and approvals are the person's
 * approval policy, left out when it can't be read.
 */
export function ComputerSourceDisclosure({ trigger }: { trigger: Trigger }) {
  const { t } = useI18n();
  const computer = useQuery(computerQuery());
  const hostname = computer.data?.computer?.hostname;
  // Only waiting for the person asks them before acting; the majordomo or a timeout may answer otherwise.
  const policy = useQuery(settingsQuery()).data?.approvalPolicy;
  const fact = (label: string, value: ReactNode) => (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-[13px] text-muted-foreground sm:w-32">
        {label}
      </dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
  return (
    <div role="note" className="rounded-xl bg-muted px-4 py-3 text-sm">
      <p>{t("triggerComputerScriptAccess")}</p>
      <dl className="mt-3 flex flex-col gap-2">
        {fact(
          t("triggerComputerName"),
          hostname ??
            (computer.isPending ? t("loading") : t("triggerNotReported")),
        )}
        {fact(
          t("triggerScriptVersion"),
          t("triggerRunRevision", { revision: trigger.revision }),
        )}
        {fact(t("triggerFrequency"), <WhenText source={trigger.source} />)}
        {policy &&
          fact(
            t("triggerApprovalPolicy"),
            <>
              {t(
                policy === "explicit"
                  ? "triggerAsksBeforeExternal"
                  : policy === "auto"
                    ? "triggerApprovesAfterTimeout"
                    : "triggerMajordomoMayApprove",
              )}
              <span className="block text-[13px] text-muted-foreground">
                {t("triggerAlwaysApproveNote")}
              </span>
            </>,
          )}
      </dl>
    </div>
  );
}

export function TriggerDetail({ trigger }: { trigger: Trigger }) {
  const { t, zonedNode, sentence, duration } = useFormats();
  const { data: agents } = useQuery(agentsQuery());
  const { data: sessions } = useQuery(sessionsQuery());
  const runs = useInfiniteQuery(triggerRunsQuery(trigger.id));
  const latestRun = runs.data?.pages[0]?.runs[0];
  const lastEvent = latestRun?.dueAt ?? null;
  const zone = triggerZone(trigger);
  const next = nextLine(trigger);
  const chatTitle = (id: string) =>
    sessions?.find((session: Session) => session.id === id)?.title ??
    t("triggerAChat");
  const policies = trigger.policies;
  const lateness = policies.lateness;
  return (
    <>
      <h1 className="mt-6 break-words font-semibold text-xl">
        {trigger.label}
      </h1>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <LifecyclePill lifecycle={trigger.lifecycle} />
        <HealthPill trigger={trigger} />
      </div>
      <PairComputerNote kind={trigger.source.kind} />
      {trigger.migration && trigger.migration.phase === "shadow" && (
        <p role="note" className="mt-4 rounded-xl bg-muted px-4 py-3 text-sm">
          {t(
            trigger.migration.owner === "trigger"
              ? trigger.migration.kind === "schedule"
                ? "triggerTookOverSchedule"
                : "triggerTookOverWatch"
              : trigger.migration.kind === "schedule"
                ? "triggerOwnedBySchedule"
                : "triggerOwnedByWatch",
          )}
        </p>
      )}
      <Section title={t("triggerInstruction")}>
        <p className="whitespace-pre-wrap break-words text-[15px]">
          {trigger.instruction}
        </p>
      </Section>
      <Section title={t("triggerWhen")}>
        <dl className="divide-y divide-border">
          <Row label={t(SOURCE_TEXT[trigger.source.kind])}>
            <SourceText source={trigger.source} />
          </Row>
          {trigger.condition && (
            <Row label={t("triggerCondition")}>
              <ConditionText expression={trigger.condition.when} />
            </Row>
          )}
          {trigger.lifecycle === "ended" ? (
            <Row label={t("triggerResult")}>
              {latestRun ? (
                sentence(
                  latestRun.outcomeKnown
                    ? "triggerResultKnown"
                    : "triggerResultUnknown",
                  { state: t(RUN_TEXT[latestRun.state].key) },
                  latestRun.endedAt ?? latestRun.dueAt,
                  zone,
                )
              ) : (
                <span className="text-muted-foreground">
                  {runs.isPending ? t("loading") : t("triggerResultNone")}
                </span>
              )}
            </Row>
          ) : (
            <Row label={t("triggerNext")}>
              {next.key === "triggerNextAt" && next.at !== undefined ? (
                zonedNode(next.at, zone)
              ) : (
                <NextText trigger={trigger} />
              )}
            </Row>
          )}
          {trigger.schedule?.nextCheckAt != null &&
            trigger.schedule.nextCheckAt !== next.at && (
              <Row label={t("triggerNextCheck")}>
                {zonedNode(trigger.schedule.nextCheckAt, zone)}
              </Row>
            )}
          {observesSource(trigger.source.kind) && (
            <Row label={t("triggerLastCheck")}>
              <span className="text-muted-foreground">
                {t("triggerNotReported")}
              </span>
            </Row>
          )}
          <Row label={t("triggerLastEvent")}>
            {lastEvent === null ? (
              <span className="text-muted-foreground">
                {runs.isPending ? t("loading") : t("triggerNoEventYet")}
              </span>
            ) : (
              zonedNode(lastEvent, zone)
            )}
          </Row>
        </dl>
      </Section>
      <Section title={t("triggerWhoWhere")}>
        <dl className="divide-y divide-border">
          <Row label={t("triggerAgent")}>
            {agentName(agents, trigger.agentId)}
          </Row>
          <Row label={t("triggerDestination")}>
            {trigger.destination.type === "new_chat" ? (
              t("triggerNewChatEachTime")
            ) : (
              <Link
                to="/chat/$sessionId"
                params={{ sessionId: trigger.destination.chatId }}
                className={cn(
                  "text-link underline-offset-2 hover:underline",
                  LINK_RING,
                )}
              >
                {chatTitle(trigger.destination.chatId)}
              </Link>
            )}
          </Row>
          <Row label={t("triggerMadeIn")}>
            {trigger.origin.type === "api" ? (
              t("triggerMadeHere")
            ) : (
              <Link
                to="/chat/$sessionId"
                params={{ sessionId: trigger.origin.chatId }}
                className={cn(
                  "text-link underline-offset-2 hover:underline",
                  LINK_RING,
                )}
              >
                {chatTitle(trigger.origin.chatId)}
              </Link>
            )}
          </Row>
        </dl>
      </Section>
      <Section title={t("triggerAccess")}>
        <dl className="divide-y divide-border">
          <Row label={t("triggerCapability")}>
            {t(capabilityKey(trigger.capability))}
          </Row>
          <Row label={t("triggerGrant")}>
            {t(GRANT_TEXT[trigger.grant.state])}
            {trigger.grant.required && (
              <Link
                to="/triggers/$triggerId/grant"
                params={{ triggerId: trigger.id }}
                className="mt-1 block text-link text-sm underline-offset-2 hover:underline"
              >
                {t(
                  trigger.grant.state === "pending_approval"
                    ? "triggerGrantReview"
                    : "triggerGrantSee",
                )}
              </Link>
            )}
          </Row>
        </dl>
        {runsCommands(trigger.source.kind) && (
          <div className="mt-3">
            <ComputerDisclosure />
          </div>
        )}
      </Section>
      <Section title={t("triggerPolicies")}>
        <dl className="divide-y divide-border">
          {lateness && "maxLatenessMs" in lateness && (
            <Row label={t("triggerLateness")}>
              {t("triggerLatenessOnce", {
                duration: duration(lateness.maxLatenessMs),
              })}
            </Row>
          )}
          {lateness && "catchUpMs" in lateness && (
            <Row label={t("triggerLateness")}>
              {t("triggerLatenessRecurring", {
                duration: duration(lateness.catchUpMs),
              })}
            </Row>
          )}
          {policies.maxPendingEvents !== null && (
            <Row label={t("triggerQueue")}>
              {t("triggerQueueEvents", { count: policies.maxPendingEvents })}
            </Row>
          )}
          <Row label={t("triggerAtOnce")}>
            {t("triggerRunsAtOnce", { count: policies.runsAtOnce })}
          </Row>
          <Row label={t("triggerDeliveryTtl")}>
            {duration(policies.deliveryTtlMs)}
            <span className="block text-[13px] text-muted-foreground">
              {t("triggerDeliveryTtlHint")}
            </span>
          </Row>
          {policies.replayHorizonMs !== null && (
            <Row label={t("triggerReplay")}>
              {duration(policies.replayHorizonMs)}
            </Row>
          )}
          {policies.staleAfterMs !== null && (
            <Row label={t("triggerStale")}>
              {duration(policies.staleAfterMs)}
            </Row>
          )}
          <Row label={t("triggerSamples")}>{t("triggerSamplesOff")}</Row>
        </dl>
      </Section>
    </>
  );
}

type Action = "pause" | "resume" | "delete";

const CONFIRM_TEXT: Record<Action, [TranslationKey, TranslationKey]> = {
  pause: ["triggerConfirmPause", "triggerPause"],
  resume: ["triggerConfirmResume", "triggerResume"],
  delete: ["triggerConfirmDelete", "triggerDelete"],
};

/** What the person can do with a trigger, each change confirmed first and made only at the revision shown. */
export function TriggerActions({
  trigger,
  onEdit,
  onReload,
}: {
  trigger: Trigger;
  onEdit: () => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState<TriggerProblem | null>(null);
  const [test, setTest] = useState<TriggerDryRun | null>(null);
  const settle = (changed: Trigger) => {
    queryClient.setQueryData(triggerQuery(changed.id).queryKey, changed);
    void queryClient.invalidateQueries({ queryKey: ["triggers", "list"] });
    void queryClient.invalidateQueries({ queryKey: ["triggers", "runs"] });
  };
  const act = useMutation({
    mutationFn: async (action: Action) => {
      if (action === "pause") {
        return pim.pauseTrigger(trigger.id, trigger.revision);
      }
      if (action === "resume") {
        return pim.resumeTrigger(trigger.id, trigger.revision);
      }
      return (await pim.deleteTrigger(trigger.id, trigger.revision)).trigger;
    },
    onMutate: () => {
      setProblem(null);
      setStatus("");
    },
    onSuccess: (changed, action) => {
      setConfirming(null);
      settle(changed);
      const done = t(
        action === "pause"
          ? "triggerPausedNow"
          : action === "resume"
            ? "triggerResumedNow"
            : "triggerDeletedNow",
      );
      setStatus(done);
      if (action === "delete") {
        // Its schedule, if it was made from one, is cancelled with it.
        if (trigger.migration) {
          void queryClient.invalidateQueries({ queryKey: ["schedules"] });
          void queryClient.invalidateQueries({
            queryKey: ["triggers", "migration"],
          });
        }
        toast.success(done);
        void navigate({ to: "/triggers" });
      }
    },
    onError: (error) => {
      setConfirming(null);
      setProblem(triggerProblem(error));
    },
  });
  const dryRun = useMutation({
    mutationFn: () => pim.testTrigger(trigger.id),
    onMutate: () => {
      setProblem(null);
      setTest(null);
      setStatus(t("triggerTesting"));
    },
    onSuccess: (result) => {
      setTest(result);
      setStatus(t("triggerTestDone"));
    },
    onError: (error) => {
      setStatus("");
      setProblem(triggerProblem(error));
    },
  });
  // A shadow changes only through the migration, whichever side owns it: the API refuses anything else but deleting it, which ends its schedule or watch too.
  const locked = trigger.migration?.phase === "shadow";
  const gone = trigger.lifecycle === "deleted";
  const canEdit = !locked && !gone && trigger.lifecycle !== "ended";
  const canPause = !locked && trigger.lifecycle === "enabled";
  // A source nothing delivers can't be turned on; the access section says why, and so does a note here.
  // One that waits only for a computer offers Turn on, whose confirmation says to pair one first.
  const turnable =
    trigger.lifecycle === "draft" || trigger.lifecycle === "paused";
  const canResume =
    !locked &&
    turnable &&
    (trigger.capability.delivers ||
      trigger.capability.reason === "computer_not_paired");
  return (
    <Section title={t("triggerActions")}>
      <div className="flex flex-wrap gap-2">
        {canResume && (
          <Button type="button" onClick={() => setConfirming("resume")}>
            {t("triggerResume")}
          </Button>
        )}
        {canEdit && (
          <Button type="button" variant="secondary" onClick={onEdit}>
            {t("triggerEdit")}
          </Button>
        )}
        {!gone && (
          <Button
            type="button"
            variant="secondary"
            disabled={dryRun.isPending}
            onClick={() => dryRun.mutate()}
          >
            {dryRun.isPending ? t("triggerTesting") : t("triggerTest")}
          </Button>
        )}
        {canPause && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setConfirming("pause")}
          >
            {t("triggerPause")}
          </Button>
        )}
        {!gone && (
          <Button
            type="button"
            variant="destructive"
            onClick={() => setConfirming("delete")}
          >
            {t("triggerDelete")}
          </Button>
        )}
      </div>
      {!locked && !canResume && !trigger.capability.delivers && turnable && (
        <p role="note" className="mt-3 text-[13px] text-muted-foreground">
          {t(capabilityKey(trigger.capability))}
        </p>
      )}
      {confirming && (
        <ConfirmAction
          // Each action's confirmation starts afresh, so a box checked for one is never carried to another.
          key={confirming}
          trigger={trigger}
          action={confirming}
          pending={act.isPending}
          onConfirm={() => act.mutate(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
      <p role="status" aria-live="polite" className="mt-3 text-sm empty:hidden">
        {status}
      </p>
      {problem && (
        <div className="mt-3">
          <ProblemNotice
            problem={problem}
            onReload={() => {
              setProblem(null);
              onReload();
            }}
          />
        </div>
      )}
      {test && <TestResult result={test} />}
    </Section>
  );
}

/**
 * Confirming one of a trigger's actions. Turning on a script or watch on the
 * computer first says what it can reach, and waits until the person checks
 * that they understand it has their computer user's access.
 */
export function ConfirmAction({
  trigger,
  action,
  pending,
  onConfirm,
  onCancel,
}: {
  trigger: Trigger;
  action: Action;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const consent = action === "resume" && runsOnComputer(trigger.source.kind);
  const computer = useQuery({ ...computerQuery(), enabled: consent });
  // Turning it on needs a computer to run on, so never claim one before the status says so.
  const blocked = !consent
    ? undefined
    : computer.data
      ? computer.data.state === "none"
        ? t("triggerPairComputerFirst")
        : undefined
      : computer.isError
        ? t("triggerComputerCheckFailed")
        : t("triggerComputerChecking");
  // Deleting a trigger made from a schedule or watch ends that too, and says so first.
  const from =
    action === "delete" && trigger.migration?.phase === "shadow"
      ? trigger.migration.kind
      : null;
  return (
    <Confirm
      text={t(
        from === "schedule"
          ? "triggerConfirmDeleteSchedule"
          : from === "watch"
            ? "triggerConfirmDeleteWatch"
            : CONFIRM_TEXT[action][0],
      )}
      action={t(CONFIRM_TEXT[action][1])}
      destructive={action === "delete"}
      pending={pending}
      onConfirm={onConfirm}
      onCancel={onCancel}
      extra={consent ? <ComputerSourceDisclosure trigger={trigger} /> : null}
      acknowledge={consent ? t("triggerUnderstandComputerAccess") : undefined}
      blocked={blocked}
    />
  );
}

/**
 * A confirmation in place, focused when it opens, so the person reads what
 * will happen first. With `acknowledge`, the action waits until the person
 * checks that statement; each opening starts unchecked.
 */
export function Confirm({
  text,
  action,
  destructive,
  pending,
  extra,
  acknowledge,
  blocked,
  onConfirm,
  onCancel,
}: {
  text: string;
  action: string;
  destructive?: boolean;
  pending?: boolean;
  extra?: ReactNode;
  acknowledge?: string;
  /** Why the action can't be taken now, shown beside it. */
  blocked?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="mt-4 flex flex-col gap-3 rounded-2xl border px-4 py-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <p id={id} className="text-sm">
        {text}
      </p>
      {extra}
      {acknowledge && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            required
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5 size-4 accent-primary"
          />
          {acknowledge}
        </label>
      )}
      <div className="flex flex-wrap justify-between gap-2">
        <Button ref={cancel} type="button" variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          type="button"
          variant={destructive ? "destructive" : "default"}
          disabled={
            pending ||
            blocked !== undefined ||
            (acknowledge !== undefined && !acknowledged)
          }
          onClick={onConfirm}
        >
          {action}
        </Button>
        {blocked && (
          <p
            role="status"
            className="basis-full text-right text-sm text-muted-foreground"
          >
            {blocked}
          </p>
        )}
      </div>
    </div>
  );
}

const BLOCKER_TEXT: Record<string, TranslationKey> = {
  source_not_wired: "triggerErrorNotWired",
  grant_required: "triggerErrorGrantRequired",
  grant_not_current: "triggerErrorGrantNotCurrent",
  schedule_exhausted: "triggerErrorExhausted",
  owned_elsewhere: "triggerErrorOwnedElsewhere",
};

/** A dry run's answer: what it would do, and what would stop it being turned on. */
export function TestResult({ result }: { result: TriggerDryRun }) {
  const { t, date } = useFormats();
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-2xl bg-muted px-4 py-4 text-sm">
      <p className="text-muted-foreground">{t("triggerTestNoEffects")}</p>
      {result.blockers.length > 0 ? (
        <div>
          <p>{t("triggerTestBlockers")}</p>
          <ul className="mt-1 list-disc pl-5">
            {result.blockers.map((blocker) => (
              <li key={blocker}>
                {BLOCKER_TEXT[blocker]
                  ? t(BLOCKER_TEXT[blocker])
                  : t("triggerErrorUnknown")}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p>{t("triggerTestNoBlockers")}</p>
      )}
      {result.firings && (
        <div>
          <p>
            {result.firings.length > 0
              ? t("triggerTestFirings")
              : t("triggerNextNone")}
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.firings.map((firing) => (
              <li key={firing.at}>
                <time dateTime={new Date(firing.at).toISOString()}>
                  {date(firing.at, firing.timeZone)}
                </time>{" "}
                <span className="text-muted-foreground">
                  ({firing.timeZone})
                </span>
              </li>
            ))}
          </ul>
          {result.exhausted && (
            <p className="mt-1 text-muted-foreground">
              {t("triggerTestExhausted")}
            </p>
          )}
        </div>
      )}
      {result.evaluations && result.evaluations.length === 0 && (
        <p className="text-muted-foreground">{t("triggerTestNoSamples")}</p>
      )}
    </div>
  );
}

/** A trigger's runs, newest first, each as far as Pim knows how it went. */
export function RunHistory({ trigger }: { trigger: Trigger }) {
  const { t } = useI18n();
  const runs = useInfiniteQuery(triggerRunsQuery(trigger.id));
  const list = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const pages = runs.data?.pages.length ?? 0;
  const problem = runs.error ? triggerProblem(runs.error) : null;
  return (
    <Section title={t("triggerRuns")}>
      {problem ? (
        <ProblemNotice problem={problem} />
      ) : runs.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t("loading")}
        </p>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("triggerNoRuns")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((run) => (
            <RunRow key={run.id} run={run} timeZone={triggerZone(trigger)} />
          ))}
        </ul>
      )}
      {runs.hasNextPage &&
        (pages < MAX_PAGES ? (
          <div className="mt-3">
            <Button
              type="button"
              variant="secondary"
              disabled={runs.isFetchingNextPage}
              onClick={() => runs.fetchNextPage()}
            >
              {runs.isFetchingNextPage ? t("loading") : t("triggerMoreRuns")}
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-[13px] text-muted-foreground">
            {t("triggerRunsBounded", { count: list.length })}
          </p>
        ))}
    </Section>
  );
}

export function RunRow({
  run,
  timeZone,
}: {
  run: TriggerRun;
  timeZone?: string;
}) {
  const { t, zoned, zonedNode } = useFormats();
  const { key, tone } = RUN_TEXT[run.state];
  const when = zoned(run.dueAt, timeZone);
  return (
    <li className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[15px]">
          <time dateTime={new Date(run.dueAt).toISOString()}>
            {zonedNode(run.dueAt, timeZone)}
          </time>
        </p>
        <p className="text-[13px] text-muted-foreground">
          {t(RUN_REASON[run.state])}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={tone} of={t("triggerRunState")}>
          {t(key)}
        </Pill>
        {run.chatId && (
          <Link
            to="/chat/$sessionId"
            params={{ sessionId: run.chatId }}
            className={cn(
              "text-link text-sm underline-offset-2 hover:underline",
              LINK_RING,
            )}
            aria-label={t("triggerRunChatFor", { date: when })}
          >
            {t("openChat")}
          </Link>
        )}
      </div>
    </li>
  );
}

type Decided = Exclude<GrantStanding, { kind: "not_required" | "none" }>;

const STANDING_TEXT: Record<Decided["kind"], [TranslationKey, Tone]> = {
  pending: ["triggerGrantStandingPending", "active"],
  approved: ["triggerGrantStandingApproved", "done"],
  declined: ["triggerGrantStandingDeclined", "muted"],
  expired: ["triggerGrantStandingExpired", "muted"],
  outdated: ["triggerGrantStandingOutdated", "problem"],
};

function standingNote(standing: Decided): TranslationKey | null {
  if (standing.kind === "outdated") {
    return standing.reason === "changed"
      ? "triggerGrantOutdatedChanged"
      : "triggerGrantOutdatedEnded";
  }
  if (standing.kind === "expired") {
    return standing.reason === "timeout"
      ? "triggerGrantExpiredTimeout"
      : "triggerGrantExpiredSource";
  }
  return null;
}

/**
 * A request to let a trigger's source run on the person's computer: what
 * Pim asks in its own words, exactly what a grant would cover, and the
 * decision. Only a request for the source the trigger has now, still in
 * time, can be approved; any other still waiting can only be declined.
 * `currentHash` is `sourceConfigHash` of the trigger's source.
 */
export function GrantReview({
  trigger,
  standing,
  currentHash,
}: {
  trigger: Trigger;
  standing: GrantStanding;
  currentHash: string;
}) {
  const { t, date } = useFormats();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const said = useRef<HTMLParagraphElement>(null);
  const decide = useMutation({
    mutationFn: ({
      id,
      decision,
    }: {
      id: string;
      decision: "approve" | "deny";
    }) => decideGrant(id, decision),
    onMutate: ({ decision }) => {
      setFailure(null);
      setStatus(
        t(
          decision === "approve"
            ? "triggerGrantApproving"
            : "triggerGrantDeclining",
        ),
      );
    },
    onSuccess: ({ approval, already }) => {
      queryClient.setQueryData<Approval[]>(
        approvalsQuery().queryKey,
        (approvals) =>
          approvals?.map((candidate) =>
            candidate.id === approval.id ? approval : candidate,
          ),
      );
      void queryClient.invalidateQueries({
        queryKey: triggerQuery(trigger.id).queryKey,
      });
      void queryClient.invalidateQueries({ queryKey: ["triggers", "list"] });
      setStatus(
        t(
          already
            ? "triggerGrantAlready"
            : approval.status === "approved"
              ? "triggerGrantApprovedNow"
              : "triggerGrantDeclinedNow",
        ),
      );
      // The buttons are gone: the outcome takes the focus, so it is read.
      said.current?.focus();
    },
    onError: (error) => {
      setStatus("");
      setFailure(error.message);
    },
  });
  const header = (
    <>
      <Link
        to="/triggers/$triggerId"
        params={{ triggerId: trigger.id }}
        className={cn(
          "inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground",
          LINK_RING,
        )}
      >
        <ArrowLeft className="size-4" />
        {t("triggerGrantBack", { label: trigger.label })}
      </Link>
      <h1 className="mt-6 break-words font-semibold text-xl">
        {t("triggerGrantTitle", { label: trigger.label })}
      </h1>
    </>
  );
  if (!("approval" in standing)) {
    return (
      <>
        {header}
        <p className="mt-4 text-[15px]">
          {standing.kind === "not_required"
            ? t("triggerGrantNotRequiredHere")
            : t(GRANT_TEXT[trigger.grant.state])}
        </p>
        {standing.kind === "none" && (
          <p className="mt-1 text-[13px] text-muted-foreground">
            {t("triggerGrantNoneWaiting")}
          </p>
        )}
      </>
    );
  }
  const { approval, scope } = standing;
  const [standingKey, tone] = STANDING_TEXT[standing.kind];
  const note = standingNote(standing);
  const exact = scope.configHash === currentHash;
  const waiting = approval.status === "pending";
  const approvable = standing.kind === "pending";
  return (
    <>
      {header}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Pill tone={tone} of={t("triggerGrantRequest")}>
          {t(standingKey)}
        </Pill>
      </div>
      {note && (
        <p role="note" className="mt-4 rounded-xl bg-muted px-4 py-3 text-sm">
          {t(note)}
        </p>
      )}
      <Section title={t("triggerGrantAsked")}>
        {/* Pim's own words for the request, which name the command, how often, and as whom. */}
        <p className="whitespace-pre-wrap break-words text-[15px]">
          {approval.summary}
        </p>
        {runsCommands(trigger.source.kind) && (
          <div className="mt-3">
            <ComputerDisclosure />
          </div>
        )}
      </Section>
      <Section title={t("triggerGrantScope")}>
        <dl className="divide-y divide-border">
          <Row label={t("triggerGrantScopeTrigger")}>
            {trigger.label}
            <span className="block text-[13px] text-muted-foreground">
              {t("triggerGrantOnlyTrigger")}
            </span>
          </Row>
          <Row label={t("triggerSource")}>
            {exact ? (
              <>
                <SourceText source={trigger.source} />
                <span className="block text-[13px] text-muted-foreground">
                  {t("triggerGrantSourceExact")}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                {t("triggerGrantSourceChanged")}
              </span>
            )}
          </Row>
          <Row label={t("triggerGrantScopeComputer")}>
            {t("triggerGrantComputerOnly")}
            <code className="mt-1 block break-all font-mono text-[13px] text-muted-foreground">
              {scope.runtimeId}
            </code>
          </Row>
          <Row label={t("triggerGrantAskedAt")}>{date(approval.createdAt)}</Row>
          {waiting && approval.expiresAt !== null && (
            <Row label={t("triggerGrantExpiresAt")}>
              {date(approval.expiresAt)}
            </Row>
          )}
          {approval.decidedAt !== null && (
            <Row label={t("triggerGrantDecidedAt")}>
              {date(approval.decidedAt)}
            </Row>
          )}
          {standing.kind === "approved" && (
            <Row label={t("triggerGrant")}>
              {t(GRANT_TEXT[trigger.grant.state])}
            </Row>
          )}
          {standing.kind === "approved" && approval.result && (
            <Row label={t("triggerGrantRecorded")}>
              <span className="whitespace-pre-wrap">{approval.result}</span>
            </Row>
          )}
        </dl>
        {standing.kind === "declined" && (
          <p className="mt-3 text-sm">
            {t("triggerGrantDeclinedNote")}
            {approval.note && (
              <span className="block text-muted-foreground">
                “{approval.note}”
              </span>
            )}
          </p>
        )}
      </Section>
      {waiting && (
        <Section title={t("triggerActions")}>
          {approvable && (
            <p className="mb-3 text-[13px] text-muted-foreground">
              {t("triggerGrantLimits")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {approvable && (
              <Button
                type="button"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ id: approval.id, decision: "approve" })
                }
              >
                {t("triggerGrantApprove")}
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate({ id: approval.id, decision: "deny" })
              }
            >
              {t("triggerGrantDecline")}
            </Button>
          </div>
        </Section>
      )}
      <p
        ref={said}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="mt-3 text-sm outline-none empty:hidden"
      >
        {status}
      </p>
      {failure && (
        <div
          role="alert"
          className="mt-3 flex flex-col gap-1 rounded-xl bg-destructive/10 px-4 py-3 text-sm"
        >
          <p className="flex items-start gap-2 text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {t("triggerGrantDecideFailed")}
          </p>
          <p className="text-muted-foreground">{failure}</p>
        </div>
      )}
    </>
  );
}
