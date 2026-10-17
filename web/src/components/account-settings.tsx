import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LanguageSelect, useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  auth,
  authSessionQuery,
  connectionsQuery,
  tokensQuery,
} from "~/lib/auth";
import {
  type Account,
  type ApprovalPolicy,
  EXPORT_URL,
  type PimSettings,
  pim,
} from "~/lib/pim-api";
import { accountQuery, majordomoQuery, settingsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
      {description && (
        <p className="text-[13px] text-muted-foreground">{description}</p>
      )}
      {children}
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? t("copied") : t("copy")}
    </Button>
  );
}

/** Who you are on this Pim, what you used today, and your recovery codes. */
export function AccountSection() {
  const { t, formatNumber } = useI18n();
  const { data: account } = useQuery(accountQuery());
  if (!account) return null;
  const { today, limits } = account.usage;
  const meters = [
    { label: t("usageTokens"), used: today.tokens, limit: limits.dailyTokens },
    { label: t("usageRuns"), used: today.runs, limit: limits.dailyRuns },
    {
      label: t("usageModelRequests"),
      used: today.modelRequests,
      limit: limits.dailyModelRequests,
    },
  ];
  return (
    <section className="mb-10 rounded-2xl border bg-muted/20 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          @{account.username}
          {account.role === "admin" && (
            <span className="rounded-full border px-2 py-0.5 font-normal text-muted-foreground text-xs">
              {t("adminBadge")}
            </span>
          )}
        </h2>
        <Button variant="outline" size="sm" asChild>
          <a href={EXPORT_URL} download>
            <Download />
            {t("exportData")}
          </a>
        </Button>
      </div>
      <p className="mt-1 text-muted-foreground text-sm">
        {t("accountUsageToday")}
      </p>
      <dl className="mt-4 space-y-3">
        {meters.map(({ label, used, limit }) => (
          <div key={label}>
            <div className="flex justify-between text-sm">
              <dt>{label}</dt>
              <dd className="text-muted-foreground tabular-nums">
                {limit === null
                  ? formatNumber(used)
                  : t("usedOf", {
                      used: formatNumber(used),
                      limit: formatNumber(limit),
                    })}
              </dd>
            </div>
            {limit !== null && (
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full bg-primary",
                    used >= limit && "bg-destructive",
                  )}
                  style={{
                    width: `${Math.min(100, limit === 0 ? 100 : (used / limit) * 100)}%`,
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </dl>
      {today.planTokens > 0 && (
        <p className="mt-3 text-muted-foreground text-xs">
          {t("planTokensToday", { tokens: formatNumber(today.planTokens) })}
        </p>
      )}
      <RecoveryCodesRow account={account} />
    </section>
  );
}

function RecoveryCodesRow({ account }: { account: Account }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [codes, setCodes] = useState<string[] | null>(null);
  const renew = useMutation({
    mutationFn: auth.newRecoveryCodes,
    onSuccess: (fresh) => {
      setCodes(fresh);
      queryClient.invalidateQueries({ queryKey: ["account"] });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="mt-5 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {t("recoveryCodesLeft", { count: account.recoveryCodesLeft })}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => renew.mutate()}
          disabled={renew.isPending}
        >
          {renew.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <KeyRound />
          )}
          {t("newRecoveryCodes")}
        </Button>
      </div>
      {codes && (
        <div className="mt-3 space-y-2">
          <p className="text-muted-foreground text-xs">
            {t("newRecoveryCodesBody")}
          </p>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border px-3 py-2 font-mono text-sm">
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <CopyButton text={codes.join("\n")} />
        </div>
      )}
    </div>
  );
}

/** The person's own settings: time zone, language, and who answers approvals. */
export function PreferencesSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQuery());
  const { data: majordomo } = useQuery({
    ...majordomoQuery(),
    select: (state) => state.agent,
  });
  const update = useMutation({
    mutationFn: pim.updateSettings,
    onSuccess: (next) => {
      queryClient.setQueryData(["settings"], next);
      toast.success(t("settingsSaved"));
    },
    onError: (error) => toast.error(error.message),
  });
  if (!settings) return null;
  const zones = timeZones(settings.timeZone);
  const policies: { value: ApprovalPolicy; title: string; body: string }[] = [
    {
      value: "majordomo",
      title: t("approvalMajordomo"),
      body: t("approvalMajordomoBody", { name: majordomo?.name ?? "" }),
    },
    {
      value: "explicit",
      title: t("approvalExplicit"),
      body: t("approvalExplicitBody"),
    },
    { value: "auto", title: t("approvalAuto"), body: t("approvalAutoBody") },
  ];
  return (
    <Section title={t("preferences")}>
      <label className="flex flex-col gap-2 rounded-2xl border bg-muted/20 px-4 py-4">
        <span className="text-muted-foreground text-[13px]">
          {t("timeZone")}
        </span>
        <select
          value={settings.timeZone}
          onChange={(event) => update.mutate({ timeZone: event.target.value })}
          disabled={update.isPending}
          className="h-10 w-full rounded-xl border bg-background px-3 text-sm"
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <LanguageSelect />
      <div className="space-y-2">
        <p className="pt-2 text-[13px] text-muted-foreground">
          {t("approvalPolicyDescription")}
        </p>
        <ul
          className="divide-y overflow-hidden rounded-2xl border bg-muted/20"
          aria-label={t("approvalPolicy")}
        >
          {policies.map((policy) => (
            <PolicyChoice
              key={policy.value}
              policy={policy}
              settings={settings}
              pending={update.isPending}
              onChoose={() => update.mutate({ approvalPolicy: policy.value })}
            />
          ))}
        </ul>
      </div>
    </Section>
  );
}

function PolicyChoice({
  policy,
  settings,
  pending,
  onChoose,
}: {
  policy: { value: ApprovalPolicy; title: string; body: string };
  settings: PimSettings;
  pending: boolean;
  onChoose: () => void;
}) {
  const selected = settings.approvalPolicy === policy.value;
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        disabled={selected || pending}
        onClick={onChoose}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 disabled:cursor-default",
          selected && "hover:bg-transparent",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sm">{policy.title}</span>
          <span className="block text-muted-foreground text-xs">
            {policy.body}
          </span>
        </span>
        {selected && <Check className="mt-0.5 size-4 text-primary" />}
      </button>
    </li>
  );
}

/** Every IANA zone the browser knows, with the current one kept even if it doesn't. */
function timeZones(current: string): string[] {
  const known =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return known.includes(current) ? known : [current, ...known];
}

/** API tokens, for apps and scripts that talk to Pim. */
export function TokensSection() {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const { data: session } = useQuery(authSessionQuery());
  // Tokens are managed signed in to the app: the dev server's token can't make more.
  const signedIn =
    session?.method === "passkey" || session?.method === "identity";
  const { data: tokens } = useQuery({ ...tokensQuery(), enabled: signedIn });
  const [name, setName] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["auth", "tokens"] });
  const create = useMutation({
    mutationFn: () => auth.createToken(name.trim()),
    onSuccess: (token) => {
      setMade(token.token);
      setName("");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: auth.revokeToken,
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  if (!tokens) return null;
  return (
    <Section title={t("apiTokens")} description={t("apiTokensDescription")}>
      {tokens.length > 0 && (
        <ul
          className="divide-y rounded-2xl border bg-muted/20"
          aria-label={t("apiTokens")}
        >
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center gap-3 px-4 py-3">
              <KeyRound className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">
                  {token.name}
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  {t("tokenDates", {
                    created: formatDate(new Date(token.createdAt), {
                      dateStyle: "medium",
                    }),
                    used: token.lastUsedAt
                      ? formatDate(new Date(token.lastUsedAt), {
                          dateStyle: "medium",
                        })
                      : t("never"),
                  })}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t("revokeToken", { name: token.name })}
                onClick={() => revoke.mutate(token.id)}
                disabled={revoke.isPending && revoke.variables === token.id}
              >
                {revoke.isPending && revoke.variables === token.id ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Trash2 />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {made && (
        <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3">
          <p className="text-sm">{t("tokenShownOnce")}</p>
          <code className="block break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
            {made}
          </code>
          <CopyButton text={made} />
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("tokenNamePlaceholder")}
          aria-label={t("tokenName")}
          className="h-9 flex-1"
          maxLength={64}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={!name.trim() || create.isPending}
        >
          {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
          {t("createToken")}
        </Button>
      </form>
    </Section>
  );
}

/** Pim's MCP server: its address, and the clients the person let in, to disconnect. */
export function McpSection() {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const { data: session } = useQuery(authSessionQuery());
  // Clients are let in, and seen, signed in to the app, as tokens are.
  const signedIn =
    session?.method === "passkey" || session?.method === "identity";
  const { data: connections } = useQuery({
    ...connectionsQuery(),
    enabled: signedIn,
  });
  const disconnect = useMutation({
    mutationFn: auth.disconnect,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["auth", "connections"] }),
    onError: (error) => toast.error(error.message),
  });
  if (!connections) return null;
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <Section title={t("mcpServer")} description={t("mcpServerBody")}>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-xl bg-muted px-3 py-2 font-mono text-xs">
          {mcpUrl}
        </code>
        <CopyButton text={mcpUrl} />
      </div>
      {connections.length > 0 && (
        <ul
          className="divide-y rounded-2xl border bg-muted/20"
          aria-label={t("mcpConnections")}
        >
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex items-center gap-3 px-4 py-3"
            >
              <Plug className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">
                  {connection.name}
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  {t("mcpConnected", {
                    created: formatDate(new Date(connection.createdAt), {
                      dateStyle: "medium",
                    }),
                  })}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t("disconnectClient", { name: connection.name })}
                onClick={() => disconnect.mutate(connection.id)}
                disabled={
                  disconnect.isPending && disconnect.variables === connection.id
                }
              >
                {disconnect.isPending &&
                disconnect.variables === connection.id ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Trash2 />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Deleting your account, after typing its username. */
export function DeleteAccountSection() {
  const { t } = useI18n();
  const { data: account } = useQuery(accountQuery());
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  // Set when the account is closed but erasing its data hasn't finished.
  const [stillErasing, setStillErasing] = useState(false);
  const remove = useMutation({
    mutationFn: ({ username }: Account) => pim.deleteAccount(username),
    onSuccess: (result) => {
      if (!result.deleted) {
        setStillErasing(true);
        return;
      }
      // Signed out: back to the sign-in screen.
      window.location.assign("/");
    },
    onError: (error) => toast.error(error.message),
  });
  if (!account) return null;
  if (stillErasing) {
    return (
      <Section title={t("deleteAccount")}>
        <div role="status" className="space-y-3 rounded-2xl border px-4 py-3">
          <p className="font-medium text-sm">{t("accountClosedTitle")}</p>
          <p className="text-muted-foreground text-sm">
            {t("accountClosedBody")}
          </p>
          <Button variant="outline" asChild>
            <a href="/">{t("leave")}</a>
          </Button>
        </div>
      </Section>
    );
  }
  return (
    <Section title={t("deleteAccount")}>
      <div className="space-y-3 rounded-2xl border px-4 py-3">
        <p className="flex items-start gap-2 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          {t("deleteAccountBody", { username: account.username })}
        </p>
        {confirming ? (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed === account.username) remove.mutate(account);
            }}
          >
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={account.username}
              aria-label={t("typeUsernameToConfirm", {
                username: account.username,
              })}
              className="h-9 flex-1"
              autoFocus
            />
            <Button
              type="submit"
              variant="destructive"
              disabled={typed !== account.username || remove.isPending}
            >
              {remove.isPending && <Loader2 className="animate-spin" />}
              {t("deleteForever")}
            </Button>
          </form>
        ) : (
          <Button
            variant="destructive"
            className="text-destructive"
            onClick={() => setConfirming(true)}
          >
            {t("deleteAccountButton")}
          </Button>
        )}
      </div>
    </Section>
  );
}
