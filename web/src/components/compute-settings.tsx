import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Section } from "~/components/account-settings";
import { type TranslationKey, useI18n } from "~/components/i18n";
import { Loader2, Plus, Server } from "~/components/icons";
import { SandboxPoolsPart } from "~/components/sandbox-pools";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import {
  admin,
  type ComputeHealth,
  type ComputeKind,
  type ComputeMinutes,
  type ComputeProvider,
  type ComputeProviderInput,
  type ComputeQuota,
} from "~/lib/pim-api";
import { accountQuery, computeQuery } from "~/lib/queries";

/** What a provider's fields are called: the ones the server's kinds have. */
const FIELD_LABELS: Record<string, TranslationKey> = {
  managerUrl: "computeFieldManagerUrl",
  token: "computeFieldToken",
};

const QUOTAS: [keyof ComputeQuota, TranslationKey][] = [
  ["maxConcurrentWorkspaces", "computeQuotaConcurrent"],
  ["monthlySandboxMinutes", "computeQuotaMonthly"],
  ["maxSessionMinutes", "computeQuotaSession"],
];

/**
 * Compute, the admin's: the third-party services whose sandboxes run
 * everyone's coding threads, which this Pim's owner pays for; how much of
 * them each person may use; and what has been used this month.
 */
export function ComputeSection() {
  const { data } = useQuery(computeQuery());
  if (!data) return null;
  return (
    <div className="space-y-10">
      <ProvidersPart providers={data.providers} kinds={data.kinds} />
      <SandboxPoolsPart />
      <QuotaPart quota={data.quota} />
      <UsagePart usage={data.usage} />
    </div>
  );
}

function ProvidersPart({
  providers,
  kinds,
}: {
  providers: ComputeProvider[];
  kinds: ComputeKind[];
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const free = kinds.filter(
    (kind) => !providers.some((provider) => provider.kind === kind.kind),
  );
  return (
    <Section
      title={t("computeProviders")}
      description={t("computeProvidersBody")}
    >
      {providers.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground text-sm">
          {t("computeNoProviders")}
        </p>
      ) : (
        <ul
          className="divide-y overflow-hidden rounded-2xl border bg-muted/20"
          aria-label={t("computeProviders")}
        >
          {providers.map((provider) => (
            <li key={provider.id}>
              <ProviderRow
                provider={provider}
                kind={kinds.find((kind) => kind.kind === provider.kind)}
              />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <ProviderForm kinds={free} onDone={() => setAdding(false)} />
      ) : (
        free.length > 0 && (
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            {t("computeAddProvider")}
          </Button>
        )
      )}
    </Section>
  );
}

function ProviderRow({
  provider,
  kind,
}: {
  provider: ComputeProvider;
  kind: ComputeKind | undefined;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [health, setHealth] = useState<ComputeHealth | null>(null);
  const changed = () =>
    queryClient.invalidateQueries({ queryKey: ["compute"] });
  const check = useMutation({
    mutationFn: () => admin.validateComputeProvider(provider.id),
    onSuccess: setHealth,
    onError: (error) => toast.error(error.message),
  });
  const toggle = useMutation({
    mutationFn: (codingSandbox: boolean) =>
      admin.updateComputeProvider(provider.id, { codingSandbox }),
    onSuccess: changed,
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: () => admin.removeComputeProvider(provider.id),
    onSuccess: () => {
      changed();
      toast.success(t("computeRemoved", { name: provider.name }));
    },
    onError: (error) => toast.error(error.message),
  });
  const detail = [
    kind?.name,
    ...Object.values(provider.settings),
    ...Object.entries(provider.credentialsSet).map(
      ([name, set]) =>
        `${t(FIELD_LABELS[name] ?? "computeFieldToken")}: ${t(set ? "computeCredentialSet" : "computeCredentialMissing")}`,
    ),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Server className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">
              {provider.name}
            </span>
            {health && (
              <Badge
                variant={health.ok ? "success" : "destructive"}
                className="text-[11px]"
              >
                {t(health.ok ? "computeHealthy" : "computeUnhealthy")}
              </Badge>
            )}
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            {detail}
          </span>
          {health && (
            <span role="status" className="block text-muted-foreground text-xs">
              {health.message}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => check.mutate()}
            disabled={check.isPending}
            aria-label={t("computeCheckNamed", { name: provider.name })}
          >
            {check.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              t("computeCheck")
            )}
          </Button>
          {!editing && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                aria-label={t("computeEditNamed", { name: provider.name })}
              >
                {t("edit")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                aria-label={t("computeRemoveNamed", { name: provider.name })}
              >
                {t("remove")}
              </Button>
            </>
          )}
        </span>
      </div>
      <label className="mt-3 flex items-center justify-between gap-3 text-sm">
        {t("computeCodingSandbox")}
        <Switch
          checked={provider.codingSandbox}
          onCheckedChange={(on) => toggle.mutate(on)}
          disabled={toggle.isPending}
        />
      </label>
      {editing && (
        <ProviderForm
          kinds={kind ? [kind] : []}
          provider={provider}
          onDone={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/** Adds a provider of a kind not set up yet, or changes one: a credential left empty stays as it is. */
function ProviderForm({
  kinds,
  provider,
  onDone,
}: {
  kinds: ComputeKind[];
  provider?: ComputeProvider;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [kindId, setKindId] = useState(provider?.kind ?? kinds[0]?.kind ?? "");
  const kind = kinds.find((candidate) => candidate.kind === kindId);
  const [values, setValues] = useState<Record<string, string>>(
    provider?.settings ?? {},
  );
  const [name, setName] = useState(provider?.name ?? "");
  const [agentComputer, setAgentComputer] = useState(
    provider?.agentComputer ?? false,
  );
  const save = useMutation({
    mutationFn: () => {
      const settings: Record<string, string> = {};
      const credentials: Record<string, string> = {};
      for (const field of kind?.fields ?? []) {
        const value = values[field.name]?.trim() ?? "";
        if (field.secret) {
          if (value) credentials[field.name] = value;
        } else settings[field.name] = value;
      }
      const input: ComputeProviderInput = {
        ...(name.trim() && { name: name.trim() }),
        settings,
        credentials,
        agentComputer,
      };
      return provider
        ? admin.updateComputeProvider(provider.id, input)
        : admin.addComputeProvider({ ...input, kind: kindId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["compute"] });
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  const complete = (kind?.fields ?? []).every(
    (field) =>
      !field.required ||
      values[field.name]?.trim() ||
      (field.secret && provider?.credentialsSet[field.name]),
  );
  return (
    <form
      onSubmit={submit}
      className="mt-3 space-y-3 rounded-xl border bg-background p-4"
    >
      {!provider && kinds.length > 1 && (
        <div role="group" aria-label={t("computeKind")} className="flex gap-2">
          {kinds.map((candidate) => (
            <button
              key={candidate.kind}
              type="button"
              aria-pressed={kindId === candidate.kind}
              onClick={() => {
                setKindId(candidate.kind);
                setValues({});
              }}
              className={`rounded-md border px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${kindId === candidate.kind ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      )}
      <label className="block space-y-1">
        <span className="text-[13px] text-muted-foreground">
          {t("providerName")}
        </span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={kind?.name}
          className="h-9"
        />
      </label>
      {(kind?.fields ?? []).map((field) => (
        <label key={field.name} className="block space-y-1">
          <span className="text-[13px] text-muted-foreground">
            {t(FIELD_LABELS[field.name] ?? "computeFieldToken")}
          </span>
          <Input
            // A credential is typed in and never shown again.
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            value={values[field.name] ?? ""}
            onChange={(event) =>
              setValues({ ...values, [field.name]: event.target.value })
            }
            placeholder={
              field.secret && provider?.credentialsSet[field.name]
                ? t("computeCredentialKeep")
                : undefined
            }
            className={`h-9 ${field.secret ? "" : "font-mono text-xs"}`}
          />
        </label>
      ))}
      {kind && kind.fields.length === 0 && (
        <p className="text-muted-foreground text-xs">
          {t("computeNoCredentials")}
        </p>
      )}
      <label className="flex items-center justify-between gap-3 text-sm">
        {t("computeAgentComputer")}
        <Switch checked={agentComputer} onCheckedChange={setAgentComputer} />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={!kind || !complete || save.isPending}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />}
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

/** The deployment's default quota: each field a whole number, or empty for no limit. */
function QuotaPart({ quota }: { quota: ComputeQuota }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [edited, setEdited] = useState<
    Partial<Record<keyof ComputeQuota, string>>
  >({});
  const shown = (name: keyof ComputeQuota) =>
    edited[name] ?? (quota[name] === null ? "" : String(quota[name]));
  const save = useMutation({
    mutationFn: () =>
      admin.setComputeQuota(
        Object.fromEntries(
          QUOTAS.map(([name]) => {
            const text = shown(name).trim();
            return [name, text === "" ? null : Number(text)];
          }),
        ),
      ),
    onSuccess: () => {
      setEdited({});
      queryClient.invalidateQueries({ queryKey: ["compute"] });
      toast.success(t("computeQuotaSaved"));
    },
    onError: (error) => toast.error(error.message),
  });
  const valid = QUOTAS.every(([name]) => {
    const text = shown(name).trim();
    return text === "" || /^\d+$/.test(text);
  });
  return (
    <Section title={t("computeQuota")} description={t("computeQuotaBody")}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
        className="space-y-3 rounded-xl border bg-muted/20 p-4"
      >
        {QUOTAS.map(([name, label]) => (
          <label
            key={name}
            className="flex items-center justify-between gap-3 text-sm"
          >
            {t(label)}
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={shown(name)}
              placeholder={t("computeNoLimit")}
              onChange={(event) =>
                setEdited({ ...edited, [name]: event.target.value })
              }
              className="h-9 w-32 text-right"
            />
          </label>
        ))}
        <p className="text-muted-foreground text-xs">{t("computeQuotaHint")}</p>
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={
              !valid || Object.keys(edited).length === 0 || save.isPending
            }
          >
            {save.isPending && <Loader2 className="size-4 animate-spin" />}
            {t("save")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function UsagePart({
  usage,
}: {
  usage: {
    month: string;
    minutes: number;
    running: number;
    byProvider: ComputeMinutes[];
    top: { username: string | null; minutes: number; running: number }[];
  };
}) {
  const { t, formatNumber } = useI18n();
  return (
    <Section
      title={t("computeUsage", { month: usage.month })}
      description={t("computeUsageBody")}
    >
      <dl className="grid grid-cols-2 gap-3">
        <Stat label={t("computeMinutes")} value={formatNumber(usage.minutes)} />
        <Stat label={t("computeRunning")} value={formatNumber(usage.running)} />
      </dl>
      {usage.byProvider.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground text-sm">
          {t("computeUsageEmpty")}
        </p>
      ) : (
        <>
          <Table
            caption={t("computeByProvider")}
            rows={usage.byProvider.map((row) => [row.provider, row])}
          />
          <Table
            caption={t("computeTopUsers")}
            rows={usage.top.map((row) => [row.username ?? "—", row])}
          />
        </>
      )}
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 font-semibold text-lg tabular-nums">{value}</dd>
    </div>
  );
}

function Table({
  caption,
  rows,
}: {
  caption: string;
  rows: [string, { minutes: number; running: number }][];
}) {
  const { t, formatNumber } = useI18n();
  return (
    <table className="w-full text-sm">
      <caption className="pb-1 text-left text-muted-foreground text-xs">
        {caption}
      </caption>
      <tbody className="divide-y rounded-xl border">
        {rows.map(([name, row]) => (
          <tr key={name}>
            <th scope="row" className="px-3 py-2 text-left font-normal">
              {name}
            </th>
            <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
              {row.running > 0 &&
                `${t("computeRunningCount", { count: formatNumber(row.running) })} · `}
              {t("computeMinutesCount", { minutes: formatNumber(row.minutes) })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The person's own compute: what they may use, and what they have used this month and before. */
export function ComputeUsageSection() {
  const { t, formatNumber } = useI18n();
  const { data: account } = useQuery(accountQuery());
  const compute = account?.compute;
  if (!compute) return null;
  const { quota, usage } = compute;
  const peak = Math.max(1, ...usage.history.map((month) => month.minutes));
  return (
    <Section
      title={t("computeYourUsage")}
      description={t("computeYourUsageBody")}
    >
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label={t("computeMinutesOf", { month: usage.month })}
          value={`${formatNumber(usage.minutes)} / ${quota.monthlySandboxMinutes === null ? "∞" : formatNumber(quota.monthlySandboxMinutes)}`}
        />
        <Stat
          label={t("computeRunning")}
          value={`${formatNumber(usage.running)} / ${quota.maxConcurrentWorkspaces === null ? "∞" : formatNumber(quota.maxConcurrentWorkspaces)}`}
        />
        <Stat
          label={t("computeQuotaSession")}
          value={
            quota.maxSessionMinutes === null
              ? "∞"
              : formatNumber(quota.maxSessionMinutes)
          }
        />
      </dl>
      {usage.byProvider.length > 0 && (
        <Table
          caption={t("computeByProvider")}
          rows={usage.byProvider.map((row) => [row.provider, row])}
        />
      )}
      <div
        role="img"
        aria-label={t("computeHistory")}
        className="flex h-16 items-end gap-1"
      >
        {usage.history.map((month) => (
          <div
            key={month.month}
            title={`${month.month}: ${t("computeMinutesCount", { minutes: formatNumber(month.minutes) })}`}
            className="flex-1 rounded-sm bg-foreground/60"
            style={{ height: `${Math.max(4, (month.minutes / peak) * 100)}%` }}
          />
        ))}
      </div>
      <p className="text-muted-foreground text-xs">{t("computeResets")}</p>
    </Section>
  );
}
