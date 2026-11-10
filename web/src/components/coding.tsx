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
import { StateBadge } from "~/components/app-sidebar";
import { Markdown } from "~/components/chat/markdown";
import { EnvironmentSection } from "~/components/coding-environment";
import { HarnessIcon } from "~/components/harness-icon";
import { type TranslationKey, useI18n } from "~/components/i18n";
import {
  ArrowLeft,
  ChevronRight,
  Code,
  DollarSign,
  ExternalLink,
  GitFork,
  ListChecks,
  Loader2,
  TriangleAlert,
  Wrench,
} from "~/components/icons";
import { EmptyState, Page } from "~/components/page";
import { Confirm } from "~/components/triggers";
import { Button } from "~/components/ui/button";
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
  HARNESS_NAMES,
  type HarnessSignIn,
  isApiKeyHarness,
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
  toolSummary,
  transcriptRows,
  writingMessage,
} from "~/lib/coding";
import { ApiError, pim, SignInRequired } from "~/lib/pim-api";
import { approvalsQuery } from "~/lib/queries";
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
  thread: Pick<CodingThreadSummary, "harness" | "spentUsd" | "budgetUsd">,
  t: ReturnType<typeof useI18n>["t"],
  money: (usd: number) => string,
) {
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
      <StateBadge
        state={codingStateBadge(state, unread)}
        label={label}
        backed
      />
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
      <Field label={t("codingRepo")} problem={problems.repo}>
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
  const statusKey = ["coding", "vault", harness];
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => api.vault.status(harness),
  });
  const [apiKey, setApiKey] = useState("");
  const save = useMutation({
    mutationFn: () => api.vault.saveApiKey(harness, apiKey.trim()),
    onSuccess: (next) => {
      // The key leaves the page as soon as it is saved.
      setApiKey("");
      // The answer is the vault's own status: the panel says connected at once.
      queryClient.setQueryData(statusKey, next);
      // Threads that waited for the key go on.
      queryClient.invalidateQueries({ queryKey: ["coding", "thread"] });
      queryClient.invalidateQueries({ queryKey: ["coding", "threads"] });
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.vault.disconnect(harness),
    onSuccess: (next) => {
      save.reset();
      queryClient.setQueryData(statusKey, next);
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
  const statusKey = ["coding", "vault", harness];
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => api.vault.status(harness),
  });
  const [signIn, setSignIn] = useState<HarnessSignIn | null>(null);
  const [code, setCode] = useState("");
  const connected = (next: HarnessSignIn) => {
    setSignIn(next.state === "connected" ? null : next);
    setCode("");
    // Whatever ended the sign-in, the vault's own status is the truth: ask it again.
    queryClient.invalidateQueries({ queryKey: statusKey });
    if (next.state === "connected") {
      queryClient.invalidateQueries({ queryKey: statusKey });
      // Threads that waited for the login go on.
      queryClient.invalidateQueries({ queryKey: ["coding", "thread"] });
      queryClient.invalidateQueries({ queryKey: ["coding", "threads"] });
    }
  };
  const start = useMutation({
    mutationFn: () => api.vault.signIn(harness),
    onSuccess: setSignIn,
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
    // Each sign-in's own code in the key, so one never reads what an earlier one ended with.
    queryKey: [...statusKey, "sign-in", signIn?.userCode],
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
    onSuccess: (next) => queryClient.setQueryData(statusKey, next),
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
      <main className="mx-auto w-full max-w-[768px] px-4 py-8 sm:px-6">
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
      <main className="mx-auto w-full max-w-[768px] px-4 py-8 sm:px-6">
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
  return (
    <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[768px] px-4 py-6 sm:px-6 md:py-10">
        <BackLink />
        <ThreadHeader thread={thread} />
        <StateNotice thread={thread} />
        <EnvironmentSection thread={thread} />
        <ThreadActions thread={thread} />
        <Tabs.Root value={tab} onValueChange={setTab} className="mt-6">
          <Tabs.List
            aria-label={t("codingPanels")}
            className="flex gap-1 border-b"
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
                className="-mb-px rounded-t-xl border-transparent border-b-2 px-3 py-2 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:border-foreground data-[state=active]:text-foreground"
              >
                {t(label)}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Content value="conversation" className="pt-4 outline-none">
            <Conversation thread={thread} />
          </Tabs.Content>
          <Tabs.Content value="changes" className="pt-4 outline-none">
            <DiffPanel id={thread.id} />
          </Tabs.Content>
          <Tabs.Content value="tests" className="pt-4 outline-none">
            <TestsPanel id={thread.id} />
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </main>
  );
}

function ThreadHeader({ thread }: { thread: CodingThreadView }) {
  const { t } = useI18n();
  const money = useMoney();
  const date = useDate();
  return (
    <header className="mt-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 truncate font-semibold text-xl">
          <a
            href={thread.repo.url}
            target="_blank"
            rel="noreferrer"
            className={cn("hover:underline", LINK_RING)}
          >
            {repoName(thread.repo.url)}
          </a>
        </h1>
        <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <span className="sr-only">{t("codingHarness")}: </span>
          <CodingHarnessMark harness={thread.harness} state={thread.state} />
          {HARNESS_NAMES[thread.harness]}
        </span>
      </div>
      <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[15px]">
        {thread.task}
      </p>
      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        <div className="inline-flex min-w-0 items-center gap-1">
          <dt className="sr-only">{t("codingBranch")}</dt>
          <GitFork className="size-3.5 shrink-0" />
          <dd className="truncate font-mono">
            {thread.repo.branch}
            <span className="font-sans">
              {" "}
              {t("codingFromRef", { ref: thread.repo.ref })}
            </span>
          </dd>
        </div>
        <div className="inline-flex items-center gap-1">
          <dt className="sr-only">{t("codingSpend")}</dt>
          <DollarSign className="size-3.5 shrink-0" />
          <dd>{spendText(thread, t, money)}</dd>
        </div>
        <div>
          <dt className="sr-only">{t("codingCreated")}</dt>
          <dd>
            {thread.createdBy.type === "agent" ? (
              <Link
                to="/chat/$sessionId"
                params={{ sessionId: thread.createdBy.chat }}
                className={cn(
                  "hover:text-foreground hover:underline",
                  LINK_RING,
                )}
              >
                {t("codingStartedFromChat", { date: date(thread.createdAt) })}
              </Link>
            ) : (
              t("codingStartedAt", { date: date(thread.createdAt) })
            )}
          </dd>
        </div>
      </dl>
    </header>
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
  const box = "mt-5 flex flex-col gap-2 rounded-2xl bg-muted px-4 py-4";
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
      <p className="mt-5 text-muted-foreground text-sm">
        {t("codingArchivedNote")}
      </p>
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

/** Stop, Continue, Push and Archive, each where the thread's state allows it. */
function ThreadActions({ thread }: { thread: CodingThreadView }) {
  const { t } = useI18n();
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
  if (thread.state === "archived") return null;
  const working =
    thread.state === "running" || thread.currentOperation !== null;
  const waiting = thread.state === "queued" || thread.state === "provisioning";
  const stopped =
    thread.state === "failed" ||
    thread.state === "waiting_input" ||
    (thread.state === "idle" &&
      (thread.stateReason === "aborted" || thread.stateReason === "cancelled"));
  const error = abort.error ?? archive.error;
  return (
    <div className="mt-5 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {working && (
          <Button
            type="button"
            variant="secondary"
            disabled={abort.isPending}
            onClick={() => abort.mutate()}
          >
            {t("codingStop")}
          </Button>
        )}
        {stopped && !continuing && (
          <ContinueButton
            thread={thread}
            onExpand={() => setContinuing(true)}
          />
        )}
        {!waiting && <PushButton thread={thread} push={push} />}
        <Button
          type="button"
          variant="ghost"
          className="ml-auto"
          aria-expanded={confirming}
          onClick={() => setConfirming(true)}
        >
          {t("codingArchive")}
        </Button>
      </div>
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
          text={t("codingArchiveConfirm")}
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
        disabled={go.isPending}
        onClick={() =>
          thread.stateReason === "budget" ? onExpand() : go.mutate()
        }
      >
        {t("codingContinue")}
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
      variant="secondary"
      disabled={push.isPending || notConfigured || thread.checkpoint === null}
      title={thread.checkpoint === null ? t("codingNothingToPush") : undefined}
      onClick={() => push.mutate()}
    >
      {t("codingPush")}
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
    if (message.type === "snapshot") invalidate("thread");
    if (message.type !== "events") return;
    for (const event of message.events) {
      if (event.type === "run_start" || event.type === "message_end") {
        invalidate("thread");
      }
      if (event.type === "run_end") {
        invalidate("thread");
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

function Conversation({ thread }: { thread: CodingThreadView }) {
  const { t } = useI18n();
  const live = useLiveTranscript(thread.id, thread.state !== "archived");
  return (
    <div className="flex flex-col gap-4">
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
          className="flex flex-col gap-4"
        >
          {live.rows.map((row) => (
            <li key={row.key}>
              <Row row={row} />
            </li>
          ))}
          {live.tools.map((tool) => (
            <li key={`running:${tool.callId}`}>
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
      <SteerForm thread={thread} />
    </div>
  );
}

function Row({ row }: { row: TranscriptRow }) {
  const { t } = useI18n();
  switch (row.kind) {
    case "task":
    case "steer":
      return (
        <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
          <span className="text-[13px] text-muted-foreground">
            {t(row.kind === "task" ? "codingTaskLabel" : "codingSteerLabel")}
          </span>
          <div className="rounded-[18px] bg-bubble px-4 py-2.5 text-bubble-foreground">
            <Markdown text={row.text} bubble />
          </div>
        </div>
      );
    case "text":
      return <Markdown text={row.text} untrusted streaming={row.writing} />;
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

/** A tool call and its result, folded: one line until opened. Tests show how they went on that line. */
function ToolRow({ row }: { row: Extract<TranscriptRow, { kind: "tool" }> }) {
  const { t } = useI18n();
  const summary = toolSummary(row.args);
  const output = row.result ? resultText(row.result) : "";
  const test = row.name === "test";
  const outcome = test && row.result ? (output.split("\n")[0] ?? "") : "";
  return (
    <details
      data-kind={test ? "test" : "tool"}
      className={cn(
        "group text-[13px]",
        test && "rounded-[18px] bg-muted px-4 py-3",
      )}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden",
          test && "text-foreground",
        )}
      >
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {test ? (
          <ListChecks className="size-3.5 shrink-0" />
        ) : (
          <Wrench className="size-3.5 shrink-0" />
        )}
        <span className="shrink-0">
          {test ? t("codingRanTests") : row.name}
        </span>
        {summary && (
          <span className="min-w-0 truncate font-mono text-muted-foreground">
            {summary}
          </span>
        )}
        {row.result?.error && (
          <span className="ml-auto shrink-0 text-destructive">
            {t("codingToolFailed")}
          </span>
        )}
        {!row.result && (
          <span className="ml-auto shrink-0">{t("codingToolNoResult")}</span>
        )}
      </summary>
      {test && outcome && (
        <p
          className={cn(
            "mt-1 pl-11",
            row.result?.error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {outcome}
        </p>
      )}
      <div className="mt-2 flex flex-col gap-2 pl-5">
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
  );
}

/** Tells the thread what to do next: into the turn under way, or, with Interrupt, in place of it. */
function SteerForm({ thread }: { thread: CodingThreadView }) {
  const { t } = useI18n();
  const api = useCodingApi();
  const update = useThreadUpdate(thread.id);
  const [text, setText] = useState("");
  const [interrupt, setInterrupt] = useState(false);
  const id = useId();
  const steer = useMutation({
    mutationFn: () =>
      api.steer(thread.id, {
        text: text.trim(),
        ...(interrupt ? { interrupt: true } : {}),
        operationId: crypto.randomUUID(),
      }),
    onSuccess: (next) => {
      setText("");
      setInterrupt(false);
      update(next);
    },
  });
  if (thread.state === "archived" || thread.state === "failed") return null;
  const working =
    thread.state === "running" || thread.currentOperation !== null;
  const send = () => {
    if (text.trim() && !steer.isPending) steer.mutate();
  };
  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-[18px] border px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t("codingSteer")}
      </label>
      <textarea
        id={id}
        rows={2}
        value={text}
        placeholder={t(
          working ? "codingSteerPlaceholderWorking" : "codingSteerPlaceholder",
        )}
        className="max-h-60 min-h-12 w-full resize-y bg-transparent px-1 text-[15px] outline-none placeholder:text-muted-foreground"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
      />
      {steer.error && (
        <p role="alert" className="px-1 text-destructive text-sm">
          {codingErrorCode(steer.error) === "budget_spent"
            ? t("codingBudgetSpent")
            : problemText(steer.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {working ? (
          <label className="flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
            <input
              type="checkbox"
              checked={interrupt}
              onChange={(event) => setInterrupt(event.target.checked)}
              className="size-4 accent-primary"
            />
            {t("codingInterrupt")}
          </label>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={!text.trim() || steer.isPending}>
          {t("codingSend")}
        </Button>
      </div>
    </form>
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
