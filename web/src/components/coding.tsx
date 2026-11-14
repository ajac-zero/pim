import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Tabs } from "radix-ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { StateBadge } from "~/components/app-sidebar";
import { Composer } from "~/components/chat/composer";
import { ChatHeader } from "~/components/chat/header";
import {
  AssistantMessage,
  StepList,
  StepRow,
  stepView,
  UserMessage,
} from "~/components/chat/items";
import {
  EnvironmentFailedBanner,
  EnvironmentSection,
} from "~/components/coding-environment";
import { HarnessIcon } from "~/components/harness-icon";
import { type TranslationKey, useI18n } from "~/components/i18n";
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  Clock,
  Code,
  DollarSign,
  ExternalLink,
  GitFork,
  ListChecks,
  Loader2,
  Play,
  Server,
  TriangleAlert,
  Upload,
} from "~/components/icons";
import { EmptyState, Page } from "~/components/page";
import { RunActivity } from "~/components/run-activity";
import { Confirm } from "~/components/triggers";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "~/components/ui/conversation";
import { Input } from "~/components/ui/input";
import {
  ACTIVE_STATES,
  type ApiKeyHarness,
  type CodingApi,
  type CodingHarness,
  type CodingPushRequested,
  type CodingStreamMessage,
  type CodingTestRun,
  type CodingThreadState,
  type CodingThreadSummary,
  type CodingThreadView,
  type ConnectableHarness,
  codingApi,
  codingDiffQuery,
  codingErrorCode,
  codingStateBadge,
  codingTestsQuery,
  codingThreadQuery,
  codingThreadsQuery,
  codingTranscriptQuery,
  codingUnread,
  EMPTY_LIVE,
  GITEA_AUTHORIZE_PATH,
  HARNESS_NAMES,
  type HarnessSignIn,
  isApiKeyHarness,
  isGiteaRepo,
  MAX_TASK,
  mergeMessages,
  parseDiff,
  queueReasonKey,
  reduceLive,
  repoName,
  resultText,
  START_HARNESSES,
  STATE_TEXT,
  type StartForm,
  type StartProblems,
  startInput,
  startProblems,
  stateReasonKey,
  type TranscriptRow,
  transcriptRows,
  workspaceProviderName,
  writingMessage,
} from "~/lib/coding";
import { ApiError, pim, SignInRequired } from "~/lib/pim-api";
import { textOf } from "~/lib/pim-client";
import { accountQuery, approvalsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";
import {
  HARNESS_API_KEYS,
  HARNESS_DISCLOSURES,
} from "../../../src/coding/vault/harnesses";

/*
 * Coding threads (docs/coding-api.md): the space's list with a form to start
 * one, and each thread's page, which follows it live. The pages reach the
 * API through `CodingApiContext`, so tests give them a fake.
 */

const CodingApiContext = createContext<CodingApi>(codingApi);

export function CodingApiProvider({
  api,
  children,
}: {
  api: CodingApi;
  children: ReactNode;
}) {
  return (
    <CodingApiContext.Provider value={api}>
      {children}
    </CodingApiContext.Provider>
  );
}

export const useCodingApi = () => useContext(CodingApiContext);

const LINK_RING =
  "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const FIELD_CLASS =
  "w-full rounded-xl border bg-background px-3.5 py-2 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-invalid:border-destructive";

const isActive = (state: CodingThreadState) => ACTIVE_STATES.includes(state);

/** What a thread has spent: nothing is known of what a CLI that reports no cost spends, and a thread without a budget has no "of". */
function spendText(
  thread: Pick<CodingThreadSummary, "harness" | "spentUsd" | "budgetUsd"> & {
    providerKind?: "workspace" | "agent-hosted";
    cost?: number | null;
  },
  t: ReturnType<typeof useI18n>["t"],
  money: (usd: number) => string,
) {
  if (thread.providerKind === "agent-hosted")
    return thread.cost == null ? t("codingSpentUnmetered") : money(thread.cost);
  if (thread.harness === "amp" || thread.harness === "codex")
    return t("codingSpentUnmetered");
  if (thread.budgetUsd === null)
    return t("codingSpentNoBudget", { spent: money(thread.spentUsd) });
  return t("codingSpent", {
    spent: money(thread.spentUsd),
    budget: money(thread.budgetUsd),
  });
}

function useMoney() {
  const { formatNumber } = useI18n();
  return (usd: number) =>
    formatNumber(usd, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
}

function useDate() {
  const { formatDate } = useI18n();
  return (at: number) =>
    formatDate(new Date(at), {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
}

/** What went wrong with a call, in words: the API's own message, which says what to do. */
function problemText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CONNECTABLE_HARNESSES: ConnectableHarness[] = [
  "claude-code",
  "codex",
  "amp",
  "mistral-vibe",
];

/** A harness's mark with the thread's state on its corner, as a chat's icon has; the state is named for screen readers. */
export function CodingHarnessMark({
  harness,
  state,
  unread = false,
  className,
}: {
  harness: CodingHarness;
  state: CodingThreadState;
  unread?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const label = t(STATE_TEXT[state]);
  return (
    <span className="relative flex shrink-0">
      <HarnessIcon harness={harness} className={className} />
      <StateBadge state={codingStateBadge(state, unread)} label={label} />
      <span className="sr-only">
        {t("codingState")}: <span>{label}</span>
      </span>
    </span>
  );
}

/* The list. */

/** The space's coding threads, newest first, with the form to start one. */
export function CodingPage() {
  const { t } = useI18n();
  const api = useCodingApi();
  const list = useQuery({
    ...codingThreadsQuery(api),
    // Queued and running threads move on their own: check back while any does.
    refetchInterval: (query) =>
      query.state.data?.some((thread) => isActive(thread.state)) ? 5000 : false,
  });
  const headingId = useId();
  return (
    <Page
      title={t("coding")}
      icon={<Code className="size-5" />}
      description={t("codingDescription")}
    >
      <StartThreadForm />
      <section aria-labelledby={headingId} className="mt-10">
        <h2 id={headingId} className="mb-2 text-[13px] text-muted-foreground">
          {t("codingThreads")}
        </h2>
        {list.isPending ? (
          <p role="status" className="py-6 text-muted-foreground text-sm">
            {t("loading")}
          </p>
        ) : list.isError ? (
          <div role="alert" className="flex items-center gap-3 py-6 text-sm">
            <span className="text-destructive">{problemText(list.error)}</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => list.refetch()}
            >
              {t("codingRetry")}
            </Button>
          </div>
        ) : list.data.length === 0 ? (
          <EmptyState icon={<Code />} text={t("codingNone")} />
        ) : (
          <ul className="divide-y divide-border">
            {list.data.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}

function ThreadRow({ thread }: { thread: CodingThreadSummary }) {
  const { t } = useI18n();
  const money = useMoney();
  const date = useDate();
  return (
    <li>
      <Link
        to="/coding/$threadId"
        params={{ threadId: thread.id }}
        className="-mx-3 flex flex-col gap-1 rounded-xl px-3 py-3.5 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <CodingHarnessMark
            harness={thread.harness}
            state={thread.state}
            unread={codingUnread(thread)}
            className="size-5"
          />
          <span className="min-w-0 flex-1 truncate text-[15px]">
            {repoName(thread.repo)}
          </span>
        </span>
        <RunActivity activity={thread.activity} timeline={false} />
        <span className="truncate text-[13px] text-muted-foreground">
          {thread.task}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1 font-mono">
            <GitFork className="size-3.5 shrink-0" />
            <span className="truncate">{thread.branch}</span>
          </span>
          {thread.state === "queued" && thread.queue && (
            <span>
              {t("codingQueuePosition", { position: thread.queue.position })}
            </span>
          )}
          <span>{spendText(thread, t, money)}</span>
          <span>{date(thread.createdAt)}</span>
        </span>
      </Link>
    </li>
  );
}

/** A labelled field, with what's wrong with it once the person tried to start. */
function Field({
  label,
  hint,
  problem,
  children,
}: {
  label: string;
  hint?: string;
  problem?: TranslationKey;
  children: (props: {
    id: string;
    "aria-invalid"?: true;
    "aria-describedby"?: string;
  }) => ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  const described = [hint && `${id}-hint`, problem && `${id}-problem`]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] text-muted-foreground">
        {label}
      </label>
      {children({
        id,
        ...(problem ? { "aria-invalid": true } : {}),
        ...(described ? { "aria-describedby": described } : {}),
      })}
      {hint && (
        <p id={`${id}-hint`} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      )}
      {problem && (
        <p id={`${id}-problem`} className="text-[13px] text-destructive">
          {t(problem)}
        </p>
      )}
    </div>
  );
}

const EMPTY_FORM: StartForm = {
  repo: "",
  ref: "",
  task: "",
  budget: "",
  harness: "pi",
};

/** Starts a thread on a repository: where, what to do, and at most how much to spend. */
export function StartThreadForm() {
  const { t } = useI18n();
  const api = useCodingApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [tried, setTried] = useState(false);
  // One id per thread being started, so sending the same form twice starts it once.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const problems: StartProblems = tried ? startProblems(form) : {};
  const start = useMutation({
    mutationFn: () => api.start(startInput(form, operationId)),
    onSuccess: (thread) => {
      setForm(EMPTY_FORM);
      setTried(false);
      setOperationId(crypto.randomUUID());
      queryClient.invalidateQueries({ queryKey: ["coding", "threads"] });
      queryClient.setQueryData(["coding", "thread", thread.id], thread);
      void navigate({
        to: "/coding/$threadId",
        params: { threadId: thread.id },
      });
    },
  });
  const set = (field: keyof StartForm) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));
  const refusal = start.error
    ? codingErrorCode(start.error) === "forbidden"
      ? t("codingRepoForbidden")
      : problemText(start.error)
    : null;
  return (
    <form
      noValidate
      aria-labelledby="coding-start-title"
      className="flex flex-col gap-4 rounded-2xl border px-4 py-5 sm:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (Object.keys(startProblems(form)).length > 0) return;
        start.mutate();
      }}
    >
      <h2 id="coding-start-title" className="text-[15px]">
        {t("codingStartTitle")}
      </h2>
      <Field
        label={t("codingRepo")}
        hint={t("codingRepoHint")}
        problem={problems.repo}
      >
        {(props) => (
          <Input
            {...props}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/name"
            value={form.repo}
            onChange={(event) => set("repo")(event.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("codingRef")} hint={t("codingRefHint")}>
          {(props) => (
            <Input
              {...props}
              autoComplete="off"
              spellCheck={false}
              placeholder="main"
              value={form.ref}
              onChange={(event) => set("ref")(event.target.value)}
            />
          )}
        </Field>
        <Field
          label={t("codingBudget")}
          hint={t("codingBudgetHint")}
          problem={problems.budget}
        >
          {(props) => (
            <Input
              {...props}
              inputMode="decimal"
              placeholder="3"
              value={form.budget}
              onChange={(event) => set("budget")(event.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label={t("codingTask")} problem={problems.task}>
        {(props) => (
          <textarea
            {...props}
            rows={4}
            maxLength={MAX_TASK}
            placeholder={t("codingTaskPlaceholder")}
            className={cn(FIELD_CLASS, "min-h-24 resize-y")}
            value={form.task}
            onChange={(event) => set("task")(event.target.value)}
          />
        )}
      </Field>
      <HarnessChooser
        value={form.harness ?? "pi"}
        onChange={(harness) => setForm((current) => ({ ...current, harness }))}
      />
      {form.harness && form.harness !== "pi" && (
        <HarnessConnectPanel key={form.harness} harness={form.harness} />
      )}
      {refusal && (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={start.isPending}>
          {start.isPending ? t("codingStarting") : t("codingStart")}
        </Button>
      </div>
    </form>
  );
}

/** Which coding agent runs the thread: Pi, on the space's own models, or a vendor's CLI with the person's subscription or API key. */
function HarnessChooser({
  value,
  onChange,
}: {
  value: CodingHarness;
  onChange: (harness: CodingHarness) => void;
}) {
  const { t } = useI18n();
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-[13px] text-muted-foreground">
        {t("codingHarness")}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="inline-flex max-w-full flex-wrap self-start rounded-[1.25rem] bg-muted p-1"
      >
        {START_HARNESSES.map((harness) => (
          <button
            key={harness}
            type="button"
            role="radio"
            aria-checked={value === harness}
            onClick={() => onChange(harness)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors",
              value === harness
                ? "bg-background shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span aria-hidden className="contents">
              <HarnessIcon harness={harness} />
            </span>
            {HARNESS_NAMES[harness]}
          </button>
        ))}
      </div>
      <p className="text-[13px] text-muted-foreground">
        {t("codingHarnessHint")}
      </p>
    </div>
  );
}

/** Settings' Coding tab: which coding agents this person has signed in to, to connect or disconnect them. Never the threads. */
export function CodingConnectionsSection() {
  const { t } = useI18n();
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("coding")}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {t("codingConnectionsDescription")}
      </p>
      <div className="flex flex-col gap-3">
        {CONNECTABLE_HARNESSES.map((harness) => (
          <HarnessConnectPanel key={harness} harness={harness} />
        ))}
        <GiteaConnectPanel />
      </div>
    </section>
  );
}

const GITEA_STATUS_KEY = ["coding", "gitea"];

/** Where Gitea sends the browser back to Pim, which the OAuth application must list. */
const giteaRedirectUri = () =>
  `${window.location.origin}/api/coding/gitea/callback`;

/**
 * Pim's own Gitea sign-in, which the whole deployment shares: whether it is
 * set up, and who it is connected as. Only the admin connects it; the
 * OAuth client's ID and secret are Worker secrets, never entered here. The
 * callback sends the browser back with `?gitea=` saying how it went.
 */
export function GiteaConnectPanel() {
  const { t } = useI18n();
  const api = useCodingApi();
  const queryClient = useQueryClient();
  const titleId = useId();
  const { data: account } = useQuery(accountQuery());
  const isAdmin = account?.role === "admin";
  const status = useQuery({
    queryKey: GITEA_STATUS_KEY,
    queryFn: () => api.gitea.status(),
  });
  const disconnect = useMutation({
    mutationFn: () => api.gitea.disconnect(),
    onSuccess: (next) => queryClient.setQueryData(GITEA_STATUS_KEY, next),
  });
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("gitea");
    if (result === "connected") toast.success(t("giteaJustConnected"));
    else if (result === "denied") toast.error(t("giteaDenied"));
    else if (result === "failed") toast.error(t("giteaFailed"));
    if (result)
      void queryClient.invalidateQueries({ queryKey: GITEA_STATUS_KEY });
  }, [queryClient, t]);
  const current = status.data;
  const state = !current?.configured
    ? null
    : current.needsReconnect
      ? "reconnect"
      : current.connected
        ? "connected"
        : "disconnected";
  const connect = (label: TranslationKey) =>
    isAdmin ? (
      <Button size="sm" asChild>
        <a href={GITEA_AUTHORIZE_PATH}>{t(label)}</a>
      </Button>
    ) : (
      <p className="text-muted-foreground text-sm">{t("giteaOwnerOnly")}</p>
    );
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-2xl border px-4 py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={titleId} className="min-w-0 flex-1 text-[15px]">
          {t("giteaTitle")}
        </h3>
        {current && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[13px]">
            {t(
              state === "connected" ? "codingConnected" : "codingNotConnected",
            )}
          </span>
        )}
      </div>
      {current &&
        (state === null ? (
          <p className="text-muted-foreground text-sm">
            {t("giteaNotConfigured", { redirect: giteaRedirectUri() })}
          </p>
        ) : state === "connected" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-muted-foreground text-sm">
              {t("giteaConnectedAs", { login: current.login ?? "" })}
            </p>
            {isAdmin && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                {t("codingDisconnect")}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-muted-foreground text-sm">
              {t(
                state === "reconnect"
                  ? "giteaNeedsReconnect"
                  : "giteaNotConnected",
              )}
            </p>
            {connect(state === "reconnect" ? "giteaReconnect" : "giteaConnect")}
          </div>
        ))}
      {disconnect.error && (
        <p role="alert" className="text-destructive text-sm">
          {disconnect.error.message}
        </p>
      )}
    </section>
  );
}

/** How often a sign-in that finishes by itself (Codex's device code) is asked where it is. */
export const SIGN_IN_POLL_MS = 2000;

/** Connecting a harness with the person's own account: their subscription, or an API key of theirs. */
export function HarnessConnectPanel({
  harness,
}: {
  harness: ConnectableHarness;
}) {
  return isApiKeyHarness(harness) ? (
    <ApiKeyConnectPanel harness={harness} />
  ) : (
    <SubscriptionConnectPanel harness={harness} />
  );
}

/** The panel's heading: the harness's mark and name, and whether it is connected once that is known. */
function ConnectPanelHeading({
  harness,
  titleId,
  connected,
}: {
  harness: ConnectableHarness;
  titleId: string;
  connected: boolean | undefined;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <HarnessIcon harness={harness} />
      <h3 id={titleId} className="min-w-0 flex-1 text-[15px]">
        {t("codingConnectTitle", { harness: HARNESS_NAMES[harness] })}
      </h3>
      {connected !== undefined && (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[13px]",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-success" : "bg-muted-foreground/60",
            )}
          />
          {connected ? t("codingConnected") : t("codingNotConnected")}
        </span>
      )}
    </div>
  );
}

/** Where a person makes each API-key harness's key, and what the field for it is called. */
const API_KEY_TEXT: Record<
  ApiKeyHarness,
  { where: TranslationKey; label: TranslationKey; site: string }
> = {
  "mistral-vibe": {
    where: "codingApiKeyWhereMistral",
    label: "codingApiKeyLabel",
    site: "console.mistral.ai",
  },
  amp: {
    where: "codingApiKeyWhereAmp",
    label: "codingAccessTokenLabel",
    site: "ampcode.com/settings",
  },
};

/**
 * Connecting a harness with an API key of the person's: what they accept by
 * connecting, where to make a key, and a masked field to save it in. Pim
 * never sends the key back, so once saved the panel only says it is
 * connected, and offers to disconnect, which deletes it.
 */
function ApiKeyConnectPanel({ harness }: { harness: ApiKeyHarness }) {
  const { t } = useI18n();
  const api = useCodingApi();
  const queryClient = useQueryClient();
  const titleId = useId();
  const keyId = useId();
  const name = HARNESS_NAMES[harness];
  const disclosure = HARNESS_DISCLOSURES[harness];
  const text = API_KEY_TEXT[harness];
  const GITEA_STATUS_KEY = ["coding", "vault", harness];
  const status = useQuery({
    queryKey: GITEA_STATUS_KEY,
    queryFn: () => api.vault.status(harness),
  });
  const [apiKey, setApiKey] = useState("");
  const save = useMutation({
    mutationFn: () => api.vault.saveApiKey(harness, apiKey.trim()),
    onSuccess: (next) => {
      // The key leaves the page as soon as it is saved.
      setApiKey("");
      // The answer is the vault's own status: the panel says connected at once.
      queryClient.setQueryData(GITEA_STATUS_KEY, next);
      // Threads that waited for the key go on.
      queryClient.invalidateQueries({ queryKey: ["coding", "thread"] });
      queryClient.invalidateQueries({ queryKey: ["coding", "threads"] });
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.vault.disconnect(harness),
    onSuccess: (next) => {
      save.reset();
      queryClient.setQueryData(GITEA_STATUS_KEY, next);
    },
  });
  const isConnected = status.data?.connected === true;
  const failed = save.error ?? disconnect.error;
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-2xl border px-4 py-4"
    >
      <ConnectPanelHeading
        harness={harness}
        titleId={titleId}
        connected={status.data?.connected}
      />
      {isConnected ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-muted-foreground text-sm">
            {t("codingApiKeyConnectedNote", { harness: name })}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {t("codingDisconnect")}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 text-muted-foreground text-sm">
            <p className="text-foreground">{disclosure.title}</p>
            {disclosure.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor={keyId}
                className="text-[13px] text-muted-foreground"
              >
                {t(text.label)}
              </label>
              <Input
                id={keyId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (apiKey.trim() && !save.isPending) save.mutate();
                }}
              />
              <p className="text-[13px] text-muted-foreground">
                {t(text.where)}{" "}
                <a
                  href={HARNESS_API_KEYS[harness].url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "inline-flex items-center gap-1 text-link underline-offset-2 hover:underline",
                    LINK_RING,
                  )}
                >
                  {text.site}
                  <ExternalLink className="size-3" />
                </a>
              </p>
            </div>
            <div>
              <Button
                type="button"
                size="sm"
                disabled={save.isPending || !apiKey.trim()}
                onClick={() => save.mutate()}
              >
                {save.isPending
                  ? t("codingApiKeySaving")
                  : t("codingApiKeySave")}
              </Button>
            </div>
          </div>
        </>
      )}
      {failed && (
        <p role="alert" className="text-destructive text-sm">
          {problemText(failed)}
        </p>
      )}
    </section>
  );
}

/**
 * Connecting a harness with the person's own subscription: what they accept
 * by connecting, whether it is connected, and its CLI's own sign-in, relayed:
 * the page to sign in at, and a field for the code that page shows (Claude
 * Code), or the code to enter on that page while the sign-in is polled until
 * the CLI finishes (Codex).
 */
function SubscriptionConnectPanel({
  harness,
}: {
  harness: Exclude<ConnectableHarness, ApiKeyHarness>;
}) {
  const { t } = useI18n();
  const api = useCodingApi();
  const queryClient = useQueryClient();
  const titleId = useId();
  const codeId = useId();
  const name = HARNESS_NAMES[harness];
  const disclosure = HARNESS_DISCLOSURES[harness];
  const GITEA_STATUS_KEY = ["coding", "vault", harness];
  const status = useQuery({
    queryKey: GITEA_STATUS_KEY,
    queryFn: () => api.vault.status(harness),
  });
  const [signIn, setSignIn] = useState<HarnessSignIn | null>(null);
  const [code, setCode] = useState("");
  const connected = (next: HarnessSignIn) => {
    setSignIn(next.state === "connected" ? null : next);
    setCode("");
    // Whatever ended the sign-in, the vault's own status is the truth: ask it again.
    queryClient.invalidateQueries({ queryKey: GITEA_STATUS_KEY });
    if (next.state === "connected") {
      queryClient.invalidateQueries({ queryKey: GITEA_STATUS_KEY });
      // Threads that waited for the login go on.
      queryClient.invalidateQueries({ queryKey: ["coding", "thread"] });
      queryClient.invalidateQueries({ queryKey: ["coding", "threads"] });
    }
  };
  // Counts the sign-ins started, to tell one's polling from the last one's.
  const [attempt, setAttempt] = useState(0);
  const start = useMutation({
    mutationFn: () => api.vault.signIn(harness),
    onSuccess: (next) => {
      setAttempt((count) => count + 1);
      setSignIn(next);
    },
  });
  const send = useMutation({
    mutationFn: () => api.vault.sendCode(harness, code.trim()),
    onSuccess: connected,
  });
  const cancel = useMutation({
    mutationFn: () => api.vault.cancelSignIn(harness),
    onSuccess: () => setSignIn(null),
  });
  // A device-code sign-in ends without the person sending anything here: it is asked where it is until it does.
  const device = signIn?.state === "waiting_code" && signIn.userCode !== null;
  const polled = useQuery({
    // Each sign-in's own key, so one never reads what an earlier one ended with, even one that got the same code and whose old answer isn't collected yet.
    queryKey: [...GITEA_STATUS_KEY, "sign-in", attempt, signIn?.userCode],
    queryFn: () => api.vault.signInStatus(harness),
    enabled: device,
    refetchInterval: SIGN_IN_POLL_MS,
    // The person is on the vendor's page in another tab meanwhile.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    gcTime: 0,
  });
  const update = polled.data;
  useEffect(() => {
    if (device && update && update.state !== "waiting_code") connected(update);
  });
  const disconnect = useMutation({
    mutationFn: () => api.vault.disconnect(harness),
    onSuccess: (next) => queryClient.setQueryData(GITEA_STATUS_KEY, next),
  });
  const isConnected = status.data?.connected === true;
  const waiting = signIn?.state === "waiting_code" && signIn.url;
  const userCode = waiting ? signIn.userCode : null;
  const error =
    (signIn?.state === "failed" ? signIn.error : null) ??
    ((start.error ?? send.error ?? cancel.error ?? disconnect.error)
      ? problemText(
          start.error ?? send.error ?? cancel.error ?? disconnect.error,
        )
      : null);
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-2xl border px-4 py-4"
    >
      <ConnectPanelHeading
        harness={harness}
        titleId={titleId}
        connected={status.data?.connected}
      />
      {isConnected ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-muted-foreground text-sm">
            {t("codingConnectedNote", { harness: name })}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {t("codingDisconnect")}
          </Button>
        </div>
      ) : waiting && userCode ? (
        <div className="flex flex-col gap-3">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              <a
                href={signIn.url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex items-center gap-1 text-link underline-offset-2 hover:underline",
                  LINK_RING,
                )}
              >
                {t("codingConnectOpen", { harness: name })}
                <ExternalLink className="size-3.5" />
              </a>
            </li>
            <li className="flex flex-col gap-1.5">
              <span>{t("codingConnectEnterCode")}</span>
              <code className="self-start rounded-lg bg-muted px-3 py-1.5 font-mono text-[17px] tracking-widest">
                {userCode}
              </code>
            </li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <p
              aria-live="polite"
              className="flex items-center gap-1.5 text-muted-foreground text-sm"
            >
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              {t("codingConnectWaiting")}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {t("codingCancel")}
            </Button>
          </div>
        </div>
      ) : waiting ? (
        <div className="flex flex-col gap-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>
              <a
                href={signIn.url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex items-center gap-1 text-link underline-offset-2 hover:underline",
                  LINK_RING,
                )}
              >
                {t("codingConnectOpen", { harness: name })}
                <ExternalLink className="size-3.5" />
              </a>
            </li>
            <li>{t("codingConnectPaste")}</li>
          </ol>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={codeId}
              className="text-[13px] text-muted-foreground"
            >
              {t("codingConnectCode")}
            </label>
            <Input
              id={codeId}
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (code.trim() && !send.isPending) send.mutate();
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={send.isPending || !code.trim()}
              onClick={() => send.mutate()}
            >
              {send.isPending ? t("codingConnecting") : t("codingConnectSend")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {t("codingCancel")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 text-muted-foreground text-sm">
            <p className="text-foreground">{disclosure.title}</p>
            {disclosure.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              {start.isPending
                ? t("codingConnectStarting")
                : t("codingConnect", { harness: name })}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </section>
  );
}

/* A thread's page. */

/** The chat view's content width and side padding, so a thread lines up with a chat. */
const FRAME = "mx-auto w-full max-w-4xl px-4 md:px-8";

function BackLink() {
  const { t } = useI18n();
  return (
    <Link
      to="/coding"
      className={cn(
        "inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground",
        LINK_RING,
      )}
    >
      <ArrowLeft className="size-4" />
      {t("codingAll")}
    </Link>
  );
}

/** One thread: what it works on and how far, its conversation live, its diff and tests, and what can be done with it now. */
export function CodingThreadPage({ id }: { id: string }) {
  const { t } = useI18n();
  const api = useCodingApi();
  const thread = useQuery({
    ...codingThreadQuery(api, id),
    refetchInterval: (query) =>
      query.state.data &&
      (isActive(query.state.data.state) ||
        ["building", "restoring"].includes(query.state.data.environment.state))
        ? 4000
        : false,
  });
  useMarkSeen(id, thread.data?.updatedAt);
  if (thread.isError && !thread.data) {
    return (
      <main className={cn(FRAME, "py-8")}>
        <BackLink />
        <p role="alert" className="mt-6 text-sm">
          {codingErrorCode(thread.error) === "not_found"
            ? t("codingNotFound")
            : problemText(thread.error)}
        </p>
      </main>
    );
  }
  if (!thread.data) {
    return (
      <main className={cn(FRAME, "py-8")}>
        <p role="status" className="text-muted-foreground text-sm">
          {t("loading")}
        </p>
      </main>
    );
  }
  return <ThreadView thread={thread.data} />;
}

/** Tells Pim the person is viewing the thread when its page opens and as new turns end, so the list doesn't mark it unread. */
function useMarkSeen(id: string, updatedAt: number | undefined) {
  const api = useCodingApi();
  useEffect(() => {
    if (updatedAt !== undefined) api.seen(id).catch(() => {});
  }, [api, id, updatedAt]);
}

function ThreadView({ thread }: { thread: CodingThreadView }) {
  const { t } = useI18n();
  const [tab, setTab] = useState("conversation");
  // Above the panels: what the thread works on, why it waits, its environment and what can be done with it.
  const controls = useThreadControls(thread);
  const top = (
    <>
      <ThreadSummary thread={thread} />
      <RunActivity activity={thread.activity} />
      <StateNotice thread={thread} />
      <EnvironmentFailedBanner thread={thread} />
      <EnvironmentSection thread={thread} />
      <ThreadActions thread={thread} controls={controls} />
    </>
  );
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Tabs.Root
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col"
      >
        <ChatHeader
          title={<ThreadTitle thread={thread} />}
          actions={
            <>
              <Tabs.List
                aria-label={t("codingPanels")}
                className="flex shrink-0 gap-1"
              >
                {(
                  [
                    ["conversation", "codingConversation"],
                    ["changes", "codingChanges"],
                    ["tests", "codingTests"],
                  ] as const
                ).map(([value, label]) => (
                  <Tabs.Trigger
                    key={value}
                    value={value}
                    className="rounded-full px-2.5 py-1.5 text-[15px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-muted data-[state=active]:text-foreground md:px-3"
                  >
                    {t(label)}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              <ThreadControls thread={thread} controls={controls} />
            </>
          }
        />
        {tab === "conversation" ? (
          <Conversation className="scrollbar-thin" initial="instant">
            <ConversationContent
              scrollClassName="overflow-auto"
              className={cn(FRAME, "min-h-full gap-3 pt-2 pb-4")}
            >
              {top}
              <Tabs.Content value="conversation" className="outline-none">
                <Transcript thread={thread} />
              </Tabs.Content>
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <div className={cn(FRAME, "flex flex-col gap-3 pt-2 pb-8")}>
              {top}
              <Tabs.Content value="changes" className="outline-none">
                <DiffPanel id={thread.id} />
              </Tabs.Content>
              <Tabs.Content value="tests" className="outline-none">
                <TestsPanel id={thread.id} />
              </Tabs.Content>
            </div>
          </div>
        )}
      </Tabs.Root>
      {/* The message box sits under every panel, as a chat's does. */}
      <div className="shrink-0 bg-background pb-2">
        <div className={cn("mx-auto w-full max-w-4xl px-4")}>
          <SteerForm thread={thread} abort={controls.abort} />
        </div>
      </div>
    </main>
  );
}

/** The thread's mark and title, where a chat's header has its agent and title; the repository is secondary, and the title when the task has none. */
function ThreadTitle({ thread }: { thread: CodingThreadView }) {
  const { t } = useI18n();
  const title = thread.task.trim().split("\n")[0] ?? "";
  return (
    <>
      <span className="inline-flex shrink-0 items-center">
        <span className="sr-only">
          {t("codingHarness")}: <span>{HARNESS_NAMES[thread.harness]}</span>
        </span>
        <CodingHarnessMark harness={thread.harness} state={thread.state} />
      </span>
      {title && <span className="min-w-0 truncate">{title}</span>}
      <a
        href={thread.repo.url}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "truncate hover:underline",
          LINK_RING,
          title && "shrink-[2] text-[13px] text-muted-foreground",
        )}
      >
        {repoName(thread.repo.url)}
      </a>
      {thread.resolvedProfile && (
        <Badge variant="secondary" className="text-[13px] font-normal">
          {thread.resolvedProfile.provider} · {thread.resolvedProfile.model} ·{" "}
          {thread.resolvedProfile.source ?? "source unknown"}
        </Badge>
      )}
      {isGiteaRepo(thread.repo.url) && (
        <Badge variant="secondary" className="text-[11px]">
          {t("giteaTitle")}
        </Badge>
      )}
    </>
  );
}

/**
 * What the thread works on, one compact icon item each: its branch (its base
 * ref in the tooltip), the workspace provider it runs on, its spend and when
 * it started. The task itself is the
 * transcript's first message, and the repository, harness and state are in
 * the header, so none of those is said again here.
 */
function ThreadSummary({ thread }: { thread: CodingThreadView }) {
  const { t, formatDate } = useI18n();
  const money = useMoney();
  const date = useDate();
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
      <div
        className="inline-flex min-w-0 items-center gap-1"
        title={`${thread.repo.branch} ${t("codingFromRef", { ref: thread.repo.ref })}`}
      >
        <dt className="sr-only">{t("codingBranch")}</dt>
        <GitFork className="size-3.5 shrink-0" />
        <dd className="truncate font-mono">{thread.repo.branch}</dd>
      </div>
      <div
        className="inline-flex items-center gap-1"
        title={
          thread.placement
            ? t("codingRunsInPoolWhy", {
                pool: thread.placement.pool,
                provider: workspaceProviderName(thread.placement.provider),
                reason: t(PLACEMENT_REASON_KEYS[thread.placementReason]),
                priority: thread.placement.priority,
              })
            : t("codingRunsOnWhy", {
                provider: workspaceProviderName(thread.provider),
                reason: t(PLACEMENT_REASON_KEYS[thread.placementReason]),
              })
        }
      >
        <dt className="sr-only">{t("codingWorkspaceProvider")}</dt>
        <Server className="size-3.5 shrink-0" />
        <dd>
          {thread.placement
            ? thread.placement.pool
            : workspaceProviderName(thread.provider)}
          {thread.placementReason !== "priority" && (
            <span className="text-muted-foreground/70">
              {" · "}
              {t(PLACEMENT_REASON_KEYS[thread.placementReason])}
            </span>
          )}
          {thread.placement && (
            <span className="text-muted-foreground/70">
              {" · "}
              {t("codingPoolPriority", {
                priority: thread.placement.priority,
              })}
            </span>
          )}
        </dd>
      </div>
      <div className="inline-flex items-center gap-1">
        <dt className="sr-only">{t("codingSpend")}</dt>
        <DollarSign className="size-3.5 shrink-0" />
        <dd>{spendText(thread, t, money)}</dd>
      </div>
      <div
        className="inline-flex items-center gap-1"
        title={formatDate(new Date(thread.createdAt), {
          dateStyle: "full",
          timeStyle: "short",
        })}
      >
        <dt className="sr-only">{t("codingCreated")}</dt>
        <Clock className="size-3.5 shrink-0" />
        <dd>
          {thread.createdBy.type === "agent" ? (
            <Link
              to="/chat/$sessionId"
              params={{ sessionId: thread.createdBy.chat }}
              className={cn("hover:text-foreground hover:underline", LINK_RING)}
            >
              {t("codingStartedFromChat", { date: date(thread.createdAt) })}
            </Link>
          ) : (
            t("codingStartedAt", { date: date(thread.createdAt) })
          )}
        </dd>
      </div>
    </dl>
  );
}

/** Why the thread waits or stopped, in plain words, with what settles it. */
function StateNotice({ thread }: { thread: CodingThreadView }) {
  const { t } = useI18n();
  const money = useMoney();
  const api = useCodingApi();
  const update = useThreadUpdate(thread.id);
  const cancel = useMutation({
    mutationFn: () => api.cancel(thread.id),
    onSuccess: update,
  });
  const box = "flex flex-col gap-2 rounded-2xl bg-muted px-4 py-3";
  if (thread.state === "queued" || thread.state === "provisioning") {
    const queue = thread.queue;
    return (
      <section aria-live="polite" className={box}>
        <p className="text-[15px]">
          {thread.state === "queued" && queue
            ? t("codingQueuedAt", { position: queue.position })
            : t("codingProvisioning")}
        </p>
        {thread.state === "queued" && queue && (
          <p className="text-muted-foreground text-sm">
            {t(queueReasonKey(queue.reason), { reason: queue.reason })}
            {queue.detail ? ` (${queue.detail})` : ""}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {t("codingCancel")}
          </Button>
          {cancel.error && (
            <p role="alert" className="text-destructive text-sm">
              {codingErrorCode(cancel.error) === "not_cancellable"
                ? t("codingNotCancellable")
                : problemText(cancel.error)}
            </p>
          )}
        </div>
      </section>
    );
  }
  if (thread.state === "archived") {
    return (
      <p className="text-muted-foreground text-sm">{t("codingArchivedNote")}</p>
    );
  }
  const why = stateReasonKey(thread.stateReason);
  if (!why) return null;
  const failed = thread.state === "failed";
  return (
    <section
      aria-live="polite"
      className={cn(box, failed && "bg-destructive/10")}
    >
      <p
        className={cn(
          "flex items-start gap-2 text-[15px]",
          failed && "text-destructive",
        )}
      >
        {failed && <TriangleAlert className="mt-1 size-4 shrink-0" />}
        {t(why.key, {
          reason: why.reason ?? "",
          spent: money(thread.spentUsd),
          budget: thread.budgetUsd === null ? "" : money(thread.budgetUsd),
          harness: HARNESS_NAMES[thread.harness],
        })}
      </p>
      {thread.stateDetail && (
        <p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
          {thread.stateDetail}
        </p>
      )}
      {thread.stateReason === "login_required" && thread.harness !== "pi" && (
        <HarnessConnectPanel harness={thread.harness} />
      )}
    </section>
  );
}

/** Puts the thread a call answered with on the page and in the list. */
function useThreadUpdate(id: string) {
  const queryClient = useQueryClient();
  return (thread: CodingThreadView) => {
    queryClient.setQueryData(["coding", "thread", id], thread);
    queryClient.invalidateQueries({ queryKey: ["coding", "threads"] });
  };
}

/** What can be done with the thread now, and where each action stands. */
function useThreadControls(thread: CodingThreadView) {
  const api = useCodingApi();
  const update = useThreadUpdate(thread.id);
  const [confirming, setConfirming] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const push = usePush(thread.id);
  const abort = useMutation({
    mutationFn: () => api.abort(thread.id),
    onSuccess: update,
  });
  const archive = useMutation({
    mutationFn: () => api.archive(thread.id),
    onSuccess: (next) => {
      setConfirming(false);
      update(next);
    },
  });
  return {
    abort,
    archive,
    push,
    confirming,
    setConfirming,
    continuing,
    setContinuing,
  };
}

type ThreadControlsState = ReturnType<typeof useThreadControls>;

/** The thread's icon actions in its header: continue, push and archive; Stop is in the message box. */
function ThreadControls({
  thread,
  controls,
}: {
  thread: CodingThreadView;
  controls: ThreadControlsState;
}) {
  const { t } = useI18n();
  const { push, continuing, setConfirming, setContinuing } = controls;
  if (thread.state === "archived") return null;
  const waiting = thread.state === "queued" || thread.state === "provisioning";
  const stopped =
    thread.state === "failed" ||
    thread.state === "waiting_input" ||
    (thread.state === "idle" &&
      (thread.stateReason === "aborted" || thread.stateReason === "cancelled"));
  return (
    <div className="flex shrink-0 items-center self-center">
      {stopped && !continuing && thread.provider !== "amp-http" && (
        <ContinueButton thread={thread} onExpand={() => setContinuing(true)} />
      )}
      {!waiting && <PushButton thread={thread} push={push} />}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("codingArchive")}
        title={t("codingArchive")}
        className="rounded-full"
        onClick={() => setConfirming(true)}
      >
        <Archive className="size-4.5" />
      </Button>
    </div>
  );
}

/** What the header's actions ask for or report: the budget to continue with, their errors, the push's outcome and the archive's confirmation. */
function ThreadActions({
  thread,
  controls,
}: {
  thread: CodingThreadView;
  controls: ThreadControlsState;
}) {
  const { t } = useI18n();
  const {
    abort,
    archive,
    push,
    confirming,
    setConfirming,
    continuing,
    setContinuing,
  } = controls;
  if (thread.state === "archived") return null;
  const error = abort.error ?? archive.error;
  // Nothing to say most of the time: an empty block would still take room above the transcript.
  if (!continuing && !error && !push.data && !push.error && !confirming)
    return null;
  return (
    <div className="flex flex-col gap-2">
      {continuing && (
        <ContinueForm thread={thread} onDone={() => setContinuing(false)} />
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {problemText(error)}
        </p>
      )}
      <PushStatus push={push} />
      {confirming && (
        <Confirm
          text={
            thread.provider === "amp-http"
              ? "Archive this thread? It is archived on Amp too. Use Stop first to halt a run that is still going."
              : t("codingArchiveConfirm")
          }
          action={t("codingArchive")}
          destructive
          pending={archive.isPending}
          onConfirm={() => archive.mutate()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** Continue: at once after a stop, or with a budget to raise after a budget stop. */
function ContinueButton({
  thread,
  onExpand,
}: {
  thread: CodingThreadView;
  onExpand: () => void;
}) {
  const { t } = useI18n();
  const api = useCodingApi();
  const update = useThreadUpdate(thread.id);
  const go = useMutation({
    mutationFn: () =>
      api.continue(thread.id, { operationId: crypto.randomUUID() }),
    onSuccess: update,
  });
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("codingContinue")}
        title={t("codingContinue")}
        className="rounded-full"
        disabled={go.isPending}
        onClick={() =>
          thread.stateReason === "budget" ? onExpand() : go.mutate()
        }
      >
        <Play className="size-4.5" />
      </Button>
      {go.error && (
        <p role="alert" className="basis-full text-destructive text-sm">
          {problemText(go.error)}
        </p>
      )}
    </>
  );
}

/** A bigger budget to continue a thread that spent its own. */
function ContinueForm({
  thread,
  onDone,
}: {
  thread: CodingThreadView;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const api = useCodingApi();
  const update = useThreadUpdate(thread.id);
  const [budget, setBudget] = useState(
    String((thread.budgetUsd ?? thread.spentUsd) * 2),
  );
  const value = Number(budget);
  const valid = budget.trim() !== "" && value > thread.spentUsd;
  const go = useMutation({
    mutationFn: () =>
      api.continue(thread.id, {
        budgetUsd: value,
        operationId: crypto.randomUUID(),
      }),
    onSuccess: (next) => {
      update(next);
      onDone();
    },
  });
  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) go.mutate();
      }}
    >
      <Field
        label={t("codingNewBudget")}
        hint={t("codingNewBudgetHint")}
        problem={budget.trim() && !valid ? "codingNewBudgetTooLow" : undefined}
      >
        {(props) => (
          <Input
            {...props}
            inputMode="decimal"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        )}
      </Field>
      {go.error && (
        <p role="alert" className="text-destructive text-sm">
          {problemText(go.error)}
        </p>
      )}
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={!valid || go.isPending}>
          {t("codingContinue")}
        </Button>
      </div>
    </form>
  );
}

const PLACEMENT_REASON_KEYS = {
  pinned: "codingPlacementPinned",
  priority: "codingPlacementPriority",
  overflow: "codingPlacementOverflow",
} as const satisfies Record<string, TranslationKey>;

const PUSH_PROBLEM: Partial<Record<string, TranslationKey>> = {
  nothing_to_push: "codingNothingToPush",
  workspace_not_running: "codingWorkspaceNotRunning",
  push_refused: "codingPushRefused",
};

/** Asking to push: the button and the status below the buttons share it. */
function usePush(id: string) {
  const api = useCodingApi();
  return useMutation({ mutationFn: () => api.push(id) });
}

type Push = ReturnType<typeof usePush>;

function PushButton({
  thread,
  push,
}: {
  thread: CodingThreadView;
  push: Push;
}) {
  const { t } = useI18n();
  const notConfigured =
    codingErrorCode(push.error) === "github_app_not_configured";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t("codingPush")}
      title={
        thread.checkpoint === null ? t("codingNothingToPush") : t("codingPush")
      }
      className="rounded-full"
      disabled={push.isPending || notConfigured || thread.checkpoint === null}
      onClick={() => push.mutate()}
    >
      <Upload className="size-4.5" />
    </Button>
  );
}

/** What came of asking to push: the approval and where it stands, or why Pim didn't ask. */
function PushStatus({ push }: { push: Push }) {
  const { t } = useI18n();
  const requested = push.data;
  if (push.error) {
    const code = codingErrorCode(push.error);
    // Not a failure: this Pim can't push until its owner sets the App up.
    if (code === "github_app_not_configured") {
      return (
        <p role="status" className="text-muted-foreground text-sm">
          {t("codingGithubNotConfigured")}
        </p>
      );
    }
    const key = code ? PUSH_PROBLEM[code] : undefined;
    return (
      <p role="alert" className="text-destructive text-sm">
        {key ? t(key) : problemText(push.error)}
      </p>
    );
  }
  if (!requested) return null;
  return <PushApproval requested={requested} />;
}

function PushApproval({ requested }: { requested: CodingPushRequested }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: approvals } = useQuery(approvalsQuery());
  const approval = approvals?.find((each) => each.id === requested.approval);
  const status = approval?.status ?? requested.status;
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      pim.decide(requested.approval, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
  return (
    <section
      aria-live="polite"
      className="flex flex-col gap-3 rounded-[18px] bg-muted px-4 py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px]">
          {t("codingPushAsked", { branch: requested.branch })}
        </p>
        <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[13px]">
          {t(
            status === "pending"
              ? "codingPushPending"
              : status === "approved"
                ? "codingPushApproved"
                : "codingPushDenied",
          )}
        </span>
      </div>
      {requested.summary && (
        <p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
          {requested.summary}
        </p>
      )}
      {status === "pending" && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={decide.isPending}
            onClick={() => decide.mutate("deny")}
          >
            {t("deny")}
          </Button>
          <Button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            {t("approve")}
          </Button>
        </div>
      )}
      {decide.error && (
        <p role="alert" className="text-destructive text-sm">
          {problemText(decide.error)}
        </p>
      )}
    </section>
  );
}

/* The conversation, followed live. */

/**
 * Follows the thread's live stream while `follow` holds: every line is
 * folded into the transcript, and a stream that ends or fails is opened
 * again, at once the first time and then after a growing wait. The
 * snapshot each opening starts with names messages already shown, which
 * stay one row each.
 */
function useLiveTranscript(id: string, follow: boolean) {
  const api = useCodingApi();
  const queryClient = useQueryClient();
  const transcript = useQuery(codingTranscriptQuery(api, id));
  const [live, dispatch] = useReducer(reduceLive, EMPTY_LIVE);
  const [connected, setConnected] = useState(false);
  const [dropped, setDropped] = useState(false);
  const received = useRef<(message: CodingStreamMessage) => void>(() => {});
  received.current = (message) => {
    dispatch(message);
    const invalidate = (part: string) =>
      queryClient.invalidateQueries({ queryKey: ["coding", part, id] });
    if (message.type === "snapshot") {
      invalidate("thread");
      invalidate("transcript");
    }
    if (message.type !== "events") return;
    for (const event of message.events) {
      if (event.type === "run_start" || event.type === "message_end") {
        invalidate("thread");
        invalidate("transcript");
      }
      if (event.type === "run_end") {
        invalidate("thread");
        invalidate("transcript");
        invalidate("diff");
        invalidate("tests");
      }
      if (event.type === "tool_execution_end" && event.toolName === "test") {
        invalidate("tests");
      }
    }
  };
  useEffect(() => {
    if (!follow) return;
    const controller = new AbortController();
    const { signal } = controller;
    let attempt = 0;
    void (async () => {
      while (!signal.aborted) {
        try {
          for await (const message of api.events(id, signal)) {
            attempt = 0;
            setConnected(true);
            setDropped(false);
            received.current(message);
          }
        } catch (error) {
          if (signal.aborted) return;
          // Gone, someone else's, or signed out: opening it again won't help.
          if (
            error instanceof SignInRequired ||
            (error instanceof ApiError &&
              (error.status === 403 || error.status === 404))
          ) {
            setConnected(false);
            return;
          }
        }
        if (signal.aborted) return;
        setConnected(false);
        setDropped(true);
        const wait = attempt === 0 ? 0 : Math.min(1000 * 2 ** attempt, 15_000);
        attempt++;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    })();
    return () => controller.abort();
  }, [api, id, follow]);
  const messages = useMemo(
    () => mergeMessages(transcript.data ?? [], live.messages),
    [transcript.data, live.messages],
  );
  const writing = useMemo(() => writingMessage(live.writing), [live.writing]);
  return {
    rows: useMemo(() => transcriptRows(messages, writing), [messages, writing]),
    tools: live.tools,
    running: live.running,
    loading: transcript.isPending && live.messages.length === 0,
    error: transcript.error,
    reconnecting: follow && dropped && !connected,
  };
}

function Transcript({ thread }: { thread: CodingThreadView }) {
  const { t } = useI18n();
  const live = useLiveTranscript(thread.id, thread.state !== "archived");
  return (
    <div className="flex flex-col gap-3">
      {live.reconnecting && (
        <p
          role="status"
          className="flex items-center gap-2 text-[13px] text-muted-foreground"
        >
          <Loader2 className="size-3.5 motion-safe:animate-spin" />
          {t("codingReconnecting")}
        </p>
      )}
      {live.loading ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t("loading")}
        </p>
      ) : live.error && live.rows.length === 0 ? (
        <p role="alert" className="text-destructive text-sm">
          {problemText(live.error)}
        </p>
      ) : (
        <ol
          aria-label={t("codingConversation")}
          className={cn(
            "flex flex-col gap-3",
            // A command's answer, and the next command, sit close under it, as an agent log's do.
            "[&>li[data-kind=tool]+li]:-mt-1",
          )}
        >
          {live.rows.map((row) => (
            <li key={row.key} data-kind={row.kind}>
              <Row row={row} />
            </li>
          ))}
          {live.tools.map((tool) => (
            <li key={`running:${tool.callId}`} data-kind="tool">
              <div className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
                <p className="flex items-center gap-2">
                  <Loader2 className="size-3.5 motion-safe:animate-spin" />
                  {t(
                    tool.name === "test"
                      ? "codingRunningTests"
                      : "codingRunningTool",
                    { name: tool.name },
                  )}
                </p>
                {tool.output && (
                  <pre className="max-h-64 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all text-foreground">
                    {tool.output.split("\n").slice(-40).join("\n")}
                  </pre>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {!live.loading && live.rows.length === 0 && live.tools.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("codingNoMessages")}</p>
      )}
    </div>
  );
}

function Row({ row }: { row: TranscriptRow }) {
  switch (row.kind) {
    case "task":
    case "steer":
      return (
        <UserMessage
          item={{ type: "message", role: "user", content: row.text }}
        />
      );
    case "text":
      return (
        <AssistantMessage
          item={{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: row.text }],
          }}
          untrusted
          streaming={row.writing}
        />
      );
    case "notice":
      return (
        <p
          data-kind="notice"
          className="text-center text-[13px] text-muted-foreground"
        >
          {row.text}
        </p>
      );
    case "error":
      return (
        <p role="alert" className="text-destructive text-sm">
          {row.text}
        </p>
      );
    case "tool":
      return <ToolRow row={row} />;
  }
}

/** A tool call and its result as a step of the chat's step list, which opens to its input and output. Tests show how they went on the step. */
function ToolRow({ row }: { row: Extract<TranscriptRow, { kind: "tool" }> }) {
  const { t } = useI18n();
  const output = row.result ? resultText(row.result) : "";
  const test = row.name === "test";
  const outcome = test && row.result ? (output.split("\n")[0] ?? "") : "";
  const view = stepView({ tool: row.name, text: null }, new Map(), t);
  const icon = test ? (
    <ListChecks className="mt-[3px] size-3.5 shrink-0" />
  ) : (
    view.icon
  );
  return (
    <StepList live>
      <StepRow icon={icon}>
        <details
          data-kind={test ? "test" : "tool"}
          className="group min-w-0 flex-1"
        >
          <summary className="flex cursor-pointer list-none items-start gap-2 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {test ? t("codingRanTests") : view.text}
            </span>
            {row.result?.error && (
              <span className="ml-auto shrink-0 text-destructive">
                {t("codingToolFailed")}
              </span>
            )}
            {!row.result && (
              <span className="ml-auto shrink-0">
                {t("codingToolNoResult")}
              </span>
            )}
            <ChevronRight className="mt-[3px] size-3.5 shrink-0 transition-transform group-open:rotate-90" />
          </summary>
          {test && outcome && (
            <p className={cn(row.result?.error && "text-destructive")}>
              {outcome}
            </p>
          )}
          <div className="mt-1.5 flex flex-col gap-1.5">
            {row.args !== null && (
              <pre className="max-h-64 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
                {JSON.stringify(row.args, null, 2)}
              </pre>
            )}
            {output && (
              <pre className="max-h-96 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
                {output}
              </pre>
            )}
          </div>
        </details>
      </StepRow>
    </StepList>
  );
}

/** Tells the thread what to do next, in the chat's message box: into the turn under way; its Stop button ends the turn. */
function SteerForm({
  thread,
  abort,
}: {
  thread: CodingThreadView;
  abort: ThreadControlsState["abort"];
}) {
  const { t } = useI18n();
  const api = useCodingApi();
  const update = useThreadUpdate(thread.id);
  // What failed to send goes back in the box, to send again.
  const [fill, setFill] = useState<{ text: string; id: number }>();
  const steer = useMutation({
    mutationFn: (text: string) =>
      api.steer(thread.id, {
        text,
        operationId: crypto.randomUUID(),
      }),
    onSuccess: update,
    onError: (_error, text) => setFill({ text, id: Date.now() }),
  });
  if (thread.state === "archived" || thread.state === "failed") return null;
  const working =
    thread.state === "running" || thread.currentOperation !== null;
  return (
    <Composer
      draftKey={thread.id}
      fill={fill}
      busy={working && !abort.isPending}
      onStop={() => abort.mutate()}
      hideAttach
      onSend={(content) => {
        const text = textOf(content).trim();
        if (text && !steer.isPending) steer.mutate(text);
      }}
      placeholder={t(
        working ? "codingSteerPlaceholderWorking" : "codingSteerPlaceholder",
      )}
      disclaimer={
        steer.error ? (
          <span role="alert" className="text-destructive">
            {codingErrorCode(steer.error) === "budget_spent"
              ? t("codingBudgetSpent")
              : problemText(steer.error)}
          </span>
        ) : undefined
      }
      autoFocus
    />
  );
}

/* The diff and the tests. */

function DiffPanel({ id }: { id: string }) {
  const { t } = useI18n();
  const api = useCodingApi();
  const diff = useQuery(codingDiffQuery(api, id));
  const files = useMemo(
    () => (diff.data ? parseDiff(diff.data.diff) : []),
    [diff.data],
  );
  if (diff.isPending) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t("loading")}
      </p>
    );
  }
  if (diff.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {problemText(diff.error)}
      </p>
    );
  }
  if (files.length === 0) {
    return <EmptyState icon={<Code />} text={t("codingNoChanges")} />;
  }
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="flex flex-col gap-4">
      {diff.data.truncated && (
        <p role="status" className="rounded-xl bg-muted px-4 py-3 text-sm">
          {t("codingDiffTruncated")}
        </p>
      )}
      <p className="text-[13px] text-muted-foreground">
        {t(files.length === 1 ? "codingFilesOne" : "codingFiles", {
          count: files.length,
        })}{" "}
        <span className="text-success">+{added}</span>{" "}
        <span className="text-destructive">−{removed}</span>
      </p>
      <ul aria-label={t("codingChangedFiles")} className="flex flex-col">
        {files.map((file, index) => (
          <li key={file.path}>
            <a
              href={`#diff-${id}-${index}`}
              className={cn(
                "flex items-center gap-3 rounded-xl px-2 py-1.5 font-mono text-[13px] hover:bg-muted",
                LINK_RING,
              )}
            >
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              <span className="shrink-0 text-success">+{file.added}</span>
              <span className="shrink-0 text-destructive">−{file.removed}</span>
            </a>
          </li>
        ))}
      </ul>
      {files.map((file, index) => (
        <section
          key={file.path}
          id={`diff-${id}-${index}`}
          aria-label={file.path}
          className="overflow-hidden rounded-xl border"
        >
          <h3 className="truncate border-b bg-muted px-3 py-2 font-mono text-[13px]">
            {file.path}
          </h3>
          <pre className="overflow-x-auto py-2 font-mono text-[12px] leading-5">
            {file.lines.map((line, number) => (
              <span
                // Lines repeat; their place is what tells them apart.
                // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines are fixed
                key={number}
                className={cn(
                  "block px-3",
                  line.startsWith("+") &&
                    !line.startsWith("+++") &&
                    "bg-success/10 text-success",
                  line.startsWith("-") &&
                    !line.startsWith("---") &&
                    "bg-destructive/10 text-destructive",
                  line.startsWith("@@") && "text-muted-foreground",
                )}
              >
                {line || " "}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

function TestsPanel({ id }: { id: string }) {
  const { t } = useI18n();
  const api = useCodingApi();
  const tests = useQuery(codingTestsQuery(api, id));
  if (tests.isPending) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t("loading")}
      </p>
    );
  }
  if (tests.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {problemText(tests.error)}
      </p>
    );
  }
  if (tests.data.length === 0) {
    return <EmptyState icon={<ListChecks />} text={t("codingNoTests")} />;
  }
  return (
    <ul className="divide-y divide-border">
      {[...tests.data].reverse().map((run) => (
        <TestRunRow key={run.seq} run={run} />
      ))}
    </ul>
  );
}

function TestRunRow({ run }: { run: CodingTestRun }) {
  const { t, formatNumber } = useI18n();
  const date = useDate();
  const passed = run.exitCode === 0 && !run.timedOut;
  return (
    <li className="flex flex-col gap-1.5 py-4">
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-[13px]">
          {run.command}
        </code>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[13px]">
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              passed ? "bg-success" : "bg-destructive",
            )}
          />
          {run.timedOut
            ? t("codingTestTimedOut")
            : t(passed ? "codingTestPassed" : "codingTestFailed", {
                code: run.exitCode ?? "?",
              })}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {run.summary
          ? t("codingTestSummary", {
              passed: run.summary.passed,
              failed: run.summary.failed,
              skipped: run.summary.skipped,
              total: run.summary.total,
            })
          : t("codingTestNoSummary")}
        {" · "}
        {t("codingTestDuration", {
          seconds: formatNumber(run.durationMs / 1000, {
            maximumFractionDigits: 1,
          }),
        })}
        {" · "}
        {date(run.startedAt)}
      </p>
      {run.output && (
        <details className="group text-[13px]">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            {t("codingTestOutput")}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
            {run.output}
          </pre>
        </details>
      )}
    </li>
  );
}
