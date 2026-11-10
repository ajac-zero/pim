import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { queryOptions } from "@tanstack/react-query";
import type { TranslationKey } from "~/components/i18n";
import { ApiError, call, SignInRequired } from "~/lib/pim-api";
import { applyChanges } from "~/lib/pim-view";
import {
  type MessagePart,
  projectEntries,
  type TranscriptMessage,
} from "../../../src/transcript";

/*
 * Coding threads, as the API in docs/coding-api.md gives them: the types,
 * a client for its routes, and how the thread's page reads its live stream
 * and its diff. Pure apart from the client, so it is tested without Pim.
 */

export type CodingThreadState =
  | "provisioning"
  | "queued"
  | "idle"
  | "running"
  | "waiting_input"
  | "failed"
  | "archived";

export type CodingHarness =
  | "pi"
  | "claude-code"
  | "codex"
  | "mistral-vibe"
  | "amp";

export const HARNESS_NAMES: Record<CodingHarness, string> = {
  pi: "Pi",
  "claude-code": "Claude Code",
  codex: "Codex",
  "mistral-vibe": "Mistral Vibe",
  amp: "Amp",
};

export type CodingCreator =
  | { type: "person" }
  | { type: "agent"; agent: string; chat: string };

export type QueuePlace = { position: number; reason: string; detail?: string };

export type AgentProfile = {
  providerId: string;
  model: string;
  thinking?: "minimal" | "low" | "medium" | "high" | "xhigh";
};

export type CodingThreadSummary = {
  id: string;
  url: string;
  repo: string;
  ref: string;
  branch: string;
  task: string;
  state: CodingThreadState;
  stateReason: string | null;
  queue: QueuePlace | null;
  createdBy: CodingCreator;
  parent: string | null;
  /** The chat it was started from, which the chat list shows it under. */
  chat: string | null;
  harness: CodingHarness;
  spentUsd: number;
  budgetUsd: number;
  createdAt: number;
  updatedAt: number;
};

export type CodingCheckpoint = {
  seq: number;
  sha: string;
  message: string;
  operationId: string | null;
  createdAt: number;
};

/** The repository's prepared environment in a thread's workspace (docs/coding-api.md). Durations are milliseconds. */
export type CodingEnvironment = {
  state: "none" | "restoring" | "cached" | "building" | "failed";
  key: string | null;
  source: "settings" | "repository" | null;
  builtAt: number | null;
  restoredFromKey: string | null;
  provisionMs: number | null;
  restoreMs: number | null;
  setupMs: number | null;
  snapshotMs: number | null;
  snapshotBytes: number | null;
  preparedAt: number | null;
  rebuildRequested: boolean;
  error?: string;
};

/** The person's settings for one repository. */
export type CodingRepoSettings = {
  repo: string;
  setupScript: string | null;
  updatedAt: number | null;
};

/** The most a setup script may be, as the API enforces it. */
export const MAX_SETUP_SCRIPT_BYTES = 64 * 1024;

export const setupScriptBytes = (script: string) =>
  new TextEncoder().encode(script).byteLength;

/** `acme/widgets` from a repository's address, in the form the settings routes take. */
export const repoSettingsPath = (url: string) =>
  `/coding/repos/${repoName(url).split("/").map(encodeURIComponent).join("/")}/settings`;

/** How long ago `at` was, in the locale's words ("3 hours ago"). */
export function formatAgo(at: number, now: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000);
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as const;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size)
      return format.format(Math.round(seconds / size), unit);
  }
  return format.format(Math.min(seconds, 0), "second");
}

export type CodingThreadView = {
  id: string;
  threadId: string;
  url: string;
  task: string;
  status: CodingThreadState;
  position?: number;
  reason?: string;
  state: CodingThreadState;
  stateReason: string | null;
  stateDetail: string | null;
  repo: { url: string; ref: string; branch: string; baseSha: string | null };
  profile: AgentProfile;
  harness: CodingHarness;
  workspaceProvider: string;
  slot: "none" | "queued" | "held";
  queue: QueuePlace | null;
  budgetUsd: number;
  spentUsd: number;
  currentOperation: string | null;
  inbox: number;
  checkpoint: CodingCheckpoint | null;
  createdBy: CodingCreator;
  parentThread: string | null;
  environment: CodingEnvironment;
  createdAt: number;
  updatedAt: number;
};

export type StartCodingThread = {
  repo: string;
  ref?: string;
  task: string;
  profile?: AgentProfile;
  harness?: CodingHarness;
  chat?: string;
  budgetUsd?: number;
  parent?: string;
  operationId?: string;
};

export type CodingDiff = {
  since: string | null;
  head: string | null;
  diff: string;
  truncated: boolean;
};

export type CodingTestRun = {
  seq: number;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: number;
  durationMs: number;
  summary: {
    format: string;
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  } | null;
  output: string;
};

export type CodingPushRequested = {
  approval: string;
  status: "pending" | "approved" | "denied";
  branch: string;
  head: string;
  bytes: number;
  summary: string;
};

export type CodingErrorCode =
  | "invalid"
  | "forbidden"
  | "not_found"
  | "archived"
  | "budget_spent"
  | "not_cancellable"
  | "workspace_not_running"
  | "nothing_to_push"
  | "github_app_not_configured"
  | "push_refused"
  | "conflict";

/** One line of `GET …/events`: pi's agent events, what `bash` and `test` print as they run, and a CLI harness's text as it writes it. */
export type CodingStreamMessage =
  | Extract<AgentEvent, { type: "snapshot" }>
  | { type: "events"; events: AgentEvent[] }
  | { type: "output"; tool: "bash" | "test"; callId: string; data: string }
  | { type: "partial"; kind: "text" | "thinking"; text: string };

/** Which harness logins the person has, as `GET /api/coding/vault/:harness` says it; never what one holds. */
export type HarnessLoginStatus = {
  harness: ConnectableHarness;
  connected: boolean;
  updatedAt: number | null;
  byteLength: number | null;
};

/** The harnesses a person connects with their own account: every one but Pi. */
export type ConnectableHarness = Exclude<CodingHarness, "pi">;

/** The harnesses a person connects with an API key they give Pim, rather than a subscription sign-in. */
export type ApiKeyHarness = "mistral-vibe" | "amp";

export function isApiKeyHarness(
  harness: CodingHarness,
): harness is ApiKeyHarness {
  return harness === "mistral-vibe" || harness === "amp";
}

/**
 * A sign-in to a harness with the person's subscription, through the CLI's
 * own sign-in. With `userCode`, the person enters that code on the page at
 * `url` and the CLI finishes by itself (Codex's device code); without it,
 * they paste the code the page shows (Claude Code).
 */
export type HarnessSignIn = {
  harness: ConnectableHarness;
  state:
    | "none"
    | "starting"
    | "waiting_code"
    | "completing"
    | "connected"
    | "failed";
  url: string | null;
  userCode: string | null;
  error: string | null;
};

/** The coding vault's routes the web app uses: a harness's login, connecting it and disconnecting it. */
export type CodingVaultApi = {
  status: (harness: ConnectableHarness) => Promise<HarnessLoginStatus>;
  disconnect: (harness: ConnectableHarness) => Promise<HarnessLoginStatus>;
  signIn: (harness: ConnectableHarness) => Promise<HarnessSignIn>;
  /** Where a sign-in is, for one that finishes by itself. */
  signInStatus: (harness: ConnectableHarness) => Promise<HarnessSignIn>;
  sendCode: (
    harness: ConnectableHarness,
    code: string,
  ) => Promise<HarnessSignIn>;
  cancelSignIn: (harness: ConnectableHarness) => Promise<HarnessSignIn>;
  /** Stores the harness's API key; the answer says only that it is connected. */
  saveApiKey: (
    harness: ApiKeyHarness,
    apiKey: string,
  ) => Promise<HarnessLoginStatus>;
};

export type { MessagePart, TranscriptMessage };

/** Every route of the coding threads API the web app uses. Tests give the pages a fake. */
export type CodingApi = {
  list: () => Promise<{ threads: CodingThreadSummary[] }>;
  start: (input: StartCodingThread) => Promise<CodingThreadView>;
  thread: (id: string) => Promise<CodingThreadView>;
  transcript: (id: string) => Promise<{ messages: TranscriptMessage[] }>;
  diff: (id: string) => Promise<CodingDiff>;
  tests: (id: string) => Promise<{ runs: CodingTestRun[] }>;
  steer: (
    id: string,
    body: { text: string; interrupt?: boolean; operationId?: string },
  ) => Promise<CodingThreadView>;
  abort: (id: string) => Promise<CodingThreadView>;
  continue: (
    id: string,
    body: { budgetUsd?: number; operationId?: string },
  ) => Promise<CodingThreadView>;
  cancel: (id: string) => Promise<CodingThreadView>;
  archive: (id: string) => Promise<CodingThreadView>;
  push: (
    id: string,
    body?: { branch?: string },
  ) => Promise<CodingPushRequested>;
  rebuildEnvironment: (id: string) => Promise<CodingEnvironment>;
  repoSettings: (repoUrl: string) => Promise<CodingRepoSettings>;
  setRepoSettings: (
    repoUrl: string,
    setupScript: string | null,
  ) => Promise<CodingRepoSettings>;
  /** The live stream until `signal` aborts or Pim closes it. */
  events: (
    id: string,
    signal: AbortSignal,
  ) => AsyncIterable<CodingStreamMessage>;
  vault: CodingVaultApi;
};

const vaultPath = (harness: string, rest = "") =>
  `/coding/vault/${encodeURIComponent(harness)}${rest}`;

const path = (id: string, rest = "") =>
  `/coding/threads/${encodeURIComponent(id)}${rest}`;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body ?? {}),
});

export const codingApi: CodingApi = {
  list: () => call("/coding/threads"),
  start: (input) => call("/coding/threads", post(input)),
  thread: (id) => call(path(id)),
  transcript: (id) => call(path(id, "/transcript")),
  diff: (id) => call(path(id, "/diff")),
  tests: (id) => call(path(id, "/tests")),
  steer: (id, body) => call(path(id, "/steer"), post(body)),
  abort: (id) => call(path(id, "/abort"), post()),
  continue: (id, body) => call(path(id, "/continue"), post(body)),
  cancel: (id) => call(path(id, "/cancel"), post()),
  archive: (id) => call(path(id, "/archive"), post()),
  push: (id, body) => call(path(id, "/push"), post(body)),
  rebuildEnvironment: (id) => call(path(id, "/environment/rebuild"), post()),
  repoSettings: (repoUrl) => call(repoSettingsPath(repoUrl)),
  setRepoSettings: (repoUrl, setupScript) =>
    call(repoSettingsPath(repoUrl), {
      method: "PUT",
      body: JSON.stringify({ setupScript }),
    }),
  events: async function* (id, signal) {
    const response = await fetch(`/api${path(id, "/events")}`, {
      signal,
      redirect: "manual",
      headers: { accept: "application/x-ndjson" },
    });
    if (response.type === "opaqueredirect" || response.status === 401) {
      throw new SignInRequired();
    }
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      throw new ApiError(
        response.status,
        typeof body?.error === "string"
          ? body.error
          : `Pim answered ${response.status}`,
        body,
      );
    }
    yield* ndjson<CodingStreamMessage>(response.body);
  },
  vault: {
    status: (harness) => call(vaultPath(harness)),
    disconnect: (harness) => call(vaultPath(harness), { method: "DELETE" }),
    signIn: (harness) => call(vaultPath(harness, "/login"), post()),
    signInStatus: (harness) => call(vaultPath(harness, "/login")),
    sendCode: (harness, code) =>
      call(vaultPath(harness, "/login/code"), post({ code })),
    cancelSignIn: (harness) =>
      call(vaultPath(harness, "/login"), { method: "DELETE" }),
    saveApiKey: (harness, apiKey) =>
      call(vaultPath(harness, "/api-key"), {
        method: "PUT",
        body: JSON.stringify({ apiKey }),
      }),
  },
};

/** The objects of a newline-delimited JSON body, one a line; a line that isn't JSON is skipped. */
export async function* ndjson<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line: string): T[] => {
    const text = line.trim();
    if (!text) return [];
    try {
      return [JSON.parse(text) as T];
    } catch {
      return [];
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) yield* parse(line);
    }
    yield* parse(buffer + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

/** The code a refusal came with, from the API's table of errors; null for anything else. */
export function codingErrorCode(error: unknown): CodingErrorCode | null {
  if (!(error instanceof ApiError)) return null;
  const code = error.body?.code;
  return typeof code === "string" ? (code as CodingErrorCode) : null;
}

/** States where the thread's work hasn't started or is under way, so its page and the list check back often. */
export const ACTIVE_STATES: readonly CodingThreadState[] = [
  "provisioning",
  "queued",
  "running",
];

export const STATE_TEXT: Record<CodingThreadState, TranslationKey> = {
  provisioning: "codingStateProvisioning",
  queued: "codingStateQueued",
  idle: "codingStateIdle",
  running: "codingStateRunning",
  waiting_input: "codingStateWaitingInput",
  failed: "codingStateFailed",
  archived: "codingStateArchived",
};

export type SubthreadStatus =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "failed";

/**
 * A thread's state as the badge on its row in the chat list says it: starting
 * and queued threads are queued; between turns and archived ones are done.
 */
export function subthreadStatus(state: CodingThreadState): SubthreadStatus {
  switch (state) {
    case "provisioning":
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "waiting_input":
      return "waiting";
    case "failed":
      return "failed";
    case "idle":
    case "archived":
      return "done";
  }
}

/** The threads started from each chat, oldest first, for the chat list to nest under it. */
export function codingByChat(
  threads: readonly CodingThreadSummary[],
): Map<string, CodingThreadSummary[]> {
  const byChat = new Map<string, CodingThreadSummary[]>();
  for (const thread of [...threads].sort((a, b) => a.createdAt - b.createdAt)) {
    if (thread.chat) {
      byChat.set(thread.chat, [...(byChat.get(thread.chat) ?? []), thread]);
    }
  }
  return byChat;
}

/** What a queued thread waits for, in words. */
export function queueReasonKey(reason: string): TranslationKey {
  switch (reason) {
    case "slots_full":
      return "codingQueueSlotsFull";
    case "low_disk":
      return "codingQueueLowDisk";
    case "budget_cap":
      return "codingQueueBudgetCap";
    default:
      return "codingQueueOther";
  }
}

/** Why a thread stopped or failed, in words: a key and what fills it. Null where the state says enough. */
export function stateReasonKey(
  reason: string | null,
): { key: TranslationKey; reason?: string } | null {
  if (reason === null) return null;
  if (reason.startsWith("queue_expired")) {
    const waited = reason.split(":")[1] ?? "";
    return { key: "codingReasonQueueExpired", reason: waited };
  }
  switch (reason) {
    case "budget":
      return { key: "codingReasonBudget" };
    case "no_backend":
      return { key: "codingReasonNoBackend" };
    case "aborted":
      return { key: "codingReasonAborted" };
    case "cancelled":
      return { key: "codingReasonCancelled" };
    case "low_disk":
    case "workspace_capacity":
      return { key: "codingReasonCapacity" };
    case "workspace":
      return { key: "codingReasonWorkspace" };
    case "login_required":
      return { key: "codingReasonLoginRequired" };
    case "harness_busy":
      return { key: "codingReasonHarnessBusy" };
    case "interrupted":
      return { key: "codingReasonInterrupted" };
    case "timeout":
      return { key: "codingReasonTimeout" };
    default:
      return { key: "codingReasonOther", reason };
  }
}

/** `https://github.com/acme/widgets` as `acme/widgets`. */
export function repoName(url: string): string {
  return url.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
}

export type StartForm = {
  repo: string;
  ref: string;
  task: string;
  budget: string;
  /** The coding agent that runs it; Pi when absent. */
  harness?: CodingHarness;
};

/** The harnesses a thread can be started on. */
export const START_HARNESSES: readonly CodingHarness[] = [
  "pi",
  "claude-code",
  "codex",
  "mistral-vibe",
  "amp",
];

export type StartProblems = Partial<Record<keyof StartForm, TranslationKey>>;

const GITHUB_REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;
export const MAX_TASK = 2000;

/** What's wrong with the start form, by field; empty when it can be sent. */
export function startProblems(form: StartForm): StartProblems {
  const problems: StartProblems = {};
  const repo = form.repo.trim();
  if (!repo) problems.repo = "codingRepoMissing";
  else if (!GITHUB_REPO.test(repo)) problems.repo = "codingRepoInvalid";
  const task = form.task.trim();
  if (!task) problems.task = "codingTaskMissing";
  else if (task.length > MAX_TASK) problems.task = "codingTaskTooLong";
  const budget = form.budget.trim();
  if (budget && !(Number(budget) > 0)) problems.budget = "codingBudgetInvalid";
  return problems;
}

/** The start form as the API takes it. */
export function startInput(
  form: StartForm,
  operationId: string,
): StartCodingThread {
  const ref = form.ref.trim();
  const budget = form.budget.trim();
  return {
    repo: form.repo.trim().replace(/\/$/, ""),
    task: form.task.trim(),
    ...(ref ? { ref } : {}),
    ...(budget ? { budgetUsd: Number(budget) } : {}),
    ...(form.harness && form.harness !== "pi" ? { harness: form.harness } : {}),
    operationId,
  };
}

/* The live transcript. */

export type RunningTool = { callId: string; name: string; output: string };

/**
 * The thread's conversation as its page shows it: the messages, each once by
 * its pi entry id however often it arrives (the transcript route, the
 * stream's snapshot after every reconnect, and its events), the message
 * being written, and the tools at work with what they printed.
 */
export type LiveTranscript = {
  messages: TranscriptMessage[];
  writing: AssistantMessage | null;
  tools: RunningTool[];
  running: boolean;
};

export const EMPTY_LIVE: LiveTranscript = {
  messages: [],
  writing: null,
  tools: [],
  running: false,
};

/** How much of a running command's output the page keeps. */
const OUTPUT_TAIL = 8000;

/** Messages added in order, each replacing the one with its id in place. */
export function mergeMessages(
  messages: readonly TranscriptMessage[],
  incoming: readonly TranscriptMessage[],
): TranscriptMessage[] {
  if (incoming.length === 0) return messages as TranscriptMessage[];
  const next = [...messages];
  const at = new Map(next.map((message, index) => [message.id, index]));
  for (const message of incoming) {
    const index = at.get(message.id);
    if (index === undefined) {
      at.set(message.id, next.length);
      next.push(message);
    } else next[index] = message;
  }
  return next;
}

/** pi entries as the transcript route projects them, with the thread's own notices. */
export function projectCodingEntries(
  entries: readonly EntryRecord[],
): TranscriptMessage[] {
  return entries.flatMap((entry): TranscriptMessage[] => {
    if (entry.kind === "app.budget_stop") {
      // Tokens only for a CLI harness that estimates no cost, whose budget is a ceiling on its tokens.
      const data = (entry.data ?? {}) as {
        budgetUsd?: number;
        spentUsd?: number;
        tokens?: number;
        tokenCeiling?: number;
      };
      return [
        {
          id: String(entry.id),
          role: "notice",
          parts: [
            {
              type: "text",
              text:
                data.tokenCeiling !== undefined
                  ? `Stopped: the thread used ${(data.tokens ?? 0).toLocaleString("en-US")} of the ${data.tokenCeiling.toLocaleString("en-US")} tokens its $${data.budgetUsd ?? 0} budget allows.`
                  : `Stopped: the thread spent $${(data.spentUsd ?? 0).toFixed(2)} of its $${data.budgetUsd ?? 0} budget.`,
            },
          ],
          timestamp: 0,
        },
      ];
    }
    return projectEntries([entry]);
  });
}

function reduceEvent(state: LiveTranscript, event: AgentEvent): LiveTranscript {
  switch (event.type) {
    case "snapshot":
      return {
        messages: mergeMessages(
          state.messages,
          projectCodingEntries(event.entries),
        ),
        writing: event.generation?.message ?? null,
        tools: event.tools
          .filter((slot) => slot.status === "running")
          .map((slot) => ({
            callId: slot.callId,
            name: slot.name,
            output: (slot.output ?? "").slice(-OUTPUT_TAIL),
          })),
        running: event.run !== undefined,
      };
    case "run_start":
      return { ...state, running: true };
    case "run_end":
      return { ...state, running: false, writing: null, tools: [] };
    case "message_start":
      return event.message.role === "assistant"
        ? { ...state, writing: event.message }
        : state;
    case "message_update":
      return { ...state, writing: applyChanges(state.writing, event.changes) };
    case "message_end":
      return {
        ...state,
        messages: mergeMessages(
          state.messages,
          projectCodingEntries([event.entry]),
        ),
        writing:
          event.entry.model?.[0]?.role === "assistant" ? null : state.writing,
      };
    case "entry_appended":
      // A CLI harness's message, once complete, replaces the text it was writing.
      return {
        ...state,
        messages: mergeMessages(
          state.messages,
          projectCodingEntries([event.entry]),
        ),
        writing:
          event.entry.model?.[0]?.role === "assistant" ? null : state.writing,
      };
    case "tool_execution_start":
      return {
        ...state,
        tools: [
          ...state.tools.filter((tool) => tool.callId !== event.toolCallId),
          { callId: event.toolCallId, name: event.toolName, output: "" },
        ],
      };
    case "tool_execution_end":
      return {
        ...state,
        tools: state.tools.filter((tool) => tool.callId !== event.toolCallId),
        messages: event.entry
          ? mergeMessages(state.messages, projectCodingEntries([event.entry]))
          : state.messages,
      };
    default:
      return state;
  }
}

/** One line of the live stream folded into the transcript. */
export function reduceLive(
  state: LiveTranscript,
  message: CodingStreamMessage,
): LiveTranscript {
  switch (message.type) {
    case "snapshot":
      return reduceEvent(state, message);
    case "events":
      return message.events.reduce(reduceEvent, state);
    case "partial":
      return { ...state, writing: appendPartial(state.writing, message) };
    case "output": {
      const known = state.tools.some((tool) => tool.callId === message.callId);
      const tools = known
        ? state.tools
        : [
            ...state.tools,
            { callId: message.callId, name: message.tool, output: "" },
          ];
      return {
        ...state,
        tools: tools.map((tool) =>
          tool.callId === message.callId
            ? {
                ...tool,
                output: (tool.output + message.data).slice(-OUTPUT_TAIL),
              }
            : tool,
        ),
      };
    }
    default:
      return state;
  }
}

/** A CLI harness's piece of text or thinking added to the message it is writing, which starts with it. */
function appendPartial(
  writing: AssistantMessage | null,
  piece: { kind: "text" | "thinking"; text: string },
): AssistantMessage {
  const message =
    writing ??
    ({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "claude-code",
      model: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    } as AssistantMessage);
  const content = [...message.content];
  const last = content.at(-1);
  if (piece.kind === "text") {
    if (last?.type === "text") {
      content[content.length - 1] = { ...last, text: last.text + piece.text };
    } else content.push({ type: "text", text: piece.text });
  } else if (last?.type === "thinking") {
    content[content.length - 1] = {
      ...last,
      thinking: last.thinking + piece.text,
    };
  } else content.push({ type: "thinking", thinking: piece.text });
  return { ...message, content };
}

/** The message being written, as the transcript route would give it once written. */
export function writingMessage(
  message: AssistantMessage | null,
): TranscriptMessage | null {
  if (!message) return null;
  return (
    projectEntries([
      {
        id: "writing",
        conversationId: "writing",
        kind: "message",
        model: [message],
      } as unknown as EntryRecord,
    ])[0] ?? null
  );
}

type ToolResult = Extract<MessagePart, { type: "tool-result" }>;

/** A row of the transcript on the thread's page. */
export type TranscriptRow =
  | { key: string; kind: "task" | "steer"; text: string }
  | { key: string; kind: "text"; text: string; writing: boolean }
  | {
      key: string;
      kind: "tool";
      name: string;
      args: unknown;
      result: ToolResult | null;
    }
  | { key: string; kind: "notice"; text: string }
  | { key: string; kind: "error"; text: string };

const textOf = (parts: readonly MessagePart[]) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/**
 * The rows to show: the person's first message is the task and later ones
 * are steers; each tool call carries its result, so results aren't rows of
 * their own; thinking isn't shown.
 */
export function transcriptRows(
  messages: readonly TranscriptMessage[],
  writing: TranscriptMessage | null = null,
): TranscriptRow[] {
  const all = writing ? [...messages, writing] : messages;
  const results = new Map<string, ToolResult>();
  const called = new Set<string>();
  for (const message of all) {
    for (const part of message.parts) {
      if (part.type === "tool-result") results.set(part.id, part);
      if (part.type === "tool-call") called.add(part.id);
    }
  }
  let seenTask = false;
  const rows: TranscriptRow[] = [];
  for (const message of all) {
    const live = message === writing;
    if (message.role === "user") {
      const text = textOf(message.parts);
      if (!text) continue;
      rows.push({
        key: message.id,
        kind: seenTask ? "steer" : "task",
        text,
      });
      seenTask = true;
      continue;
    }
    if (message.role === "notice") {
      rows.push({
        key: message.id,
        kind: "notice",
        text: textOf(message.parts),
      });
      continue;
    }
    message.parts.forEach((part, index) => {
      const key = `${message.id}:${index}`;
      if (part.type === "text" && part.text.trim()) {
        rows.push({ key, kind: "text", text: part.text, writing: live });
      } else if (part.type === "tool-call") {
        rows.push({
          key,
          kind: "tool",
          name: part.name,
          args: part.arguments,
          result: results.get(part.id) ?? null,
        });
      } else if (part.type === "tool-result" && !called.has(part.id)) {
        rows.push({
          key,
          kind: "tool",
          name: part.name,
          args: null,
          result: part,
        });
      }
    });
    if (message.role === "assistant" && message.error) {
      rows.push({
        key: `${message.id}:error`,
        kind: "error",
        text: message.error,
      });
    }
  }
  return rows;
}

/** A tool call in one line: its command, or the path or pattern it works on. */
export function toolSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const field of ["command", "path", "file", "pattern", "query", "url"]) {
    const value = record[field];
    if (typeof value === "string" && value) return value.split("\n")[0] ?? "";
  }
  const first = Object.values(record).find(
    (value) => typeof value === "string",
  );
  return typeof first === "string" ? (first.split("\n")[0] ?? "") : "";
}

/** A tool result's text. */
export function resultText(result: ToolResult): string {
  return result.content
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

/* The diff. */

export type DiffFile = {
  path: string;
  added: number;
  removed: number;
  /** Its lines from the `diff --git` header on. */
  lines: string[];
};

/** A unified diff by file, with how many lines each adds and removes. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = {
        path: header?.[2] ?? line.slice("diff --git ".length),
        added: 0,
        removed: 0,
        lines: [line],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const named = line.slice(4);
      if (line.startsWith("+++ ") && named.startsWith("b/")) {
        current.path = named.slice(2);
      }
      continue;
    }
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
  }
  // A diff cut short ends in a partial line; the trailing empty one is the final newline.
  for (const file of files) {
    if (file.lines.at(-1) === "") file.lines.pop();
  }
  return files;
}

/* Queries. Each takes the client, so tests can give the pages a fake. */

export const codingThreadsQuery = (api: CodingApi) =>
  queryOptions({
    queryKey: ["coding", "threads"],
    queryFn: () => api.list().then((body) => body.threads),
  });

export const codingThreadQuery = (api: CodingApi, id: string) =>
  queryOptions({
    queryKey: ["coding", "thread", id],
    queryFn: () => api.thread(id),
    retry: false,
  });

export const codingTranscriptQuery = (api: CodingApi, id: string) =>
  queryOptions({
    queryKey: ["coding", "transcript", id],
    queryFn: () => api.transcript(id).then((body) => body.messages),
  });

export const codingDiffQuery = (api: CodingApi, id: string) =>
  queryOptions({
    queryKey: ["coding", "diff", id],
    queryFn: () => api.diff(id),
  });

export const codingTestsQuery = (api: CodingApi, id: string) =>
  queryOptions({
    queryKey: ["coding", "tests", id],
    queryFn: () => api.tests(id).then((body) => body.runs),
  });
