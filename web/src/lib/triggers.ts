import type { TranslationKey } from "~/components/i18n";
import {
  ApiError,
  type Approval,
  pim,
  type Trigger,
  type TriggerCondition,
  type TriggerDestination,
  type TriggerExpression,
  type TriggerHealth,
  type TriggerInput,
  type TriggerLifecycle,
  type TriggerRunState,
  type TriggerSource,
  type TriggerSourceKind,
} from "~/lib/pim-api";

/*
 * How the triggers' screens read what the API says (docs/triggers.md, "The
 * API"): whether the space has triggers at all, what a refusal means, and
 * what to say of a trigger's next firing and its runs without claiming more
 * than Pim knows.
 */

/** The codes the API refuses with, from its table of errors. */
export const TRIGGER_ERROR_CODES = [
  "invalid_request",
  "invalid_cursor",
  "forbidden",
  "not_found",
  "revision_conflict",
  "invalid_transition",
  "trigger_deleted",
  "owned_elsewhere",
  "grant_required",
  "grant_not_current",
  "schedule_exhausted",
  "source_not_wired",
  "idempotency_conflict",
  "unknown_agent",
  "chat_unavailable",
  "source_unavailable",
  "revision_required",
  "internal",
] as const;
export type TriggerErrorCode = (typeof TRIGGER_ERROR_CODES)[number];

/**
 * A refusal, as the screens act on it. `unavailable` is the space without
 * triggers: the routes answer as any unknown path (404 without a code), or a
 * guest's 403. `unknown` is anything that isn't one of the API's codes.
 */
export type TriggerProblem = {
  code: TriggerErrorCode | "unavailable" | "unknown";
  status: number | null;
  /** Pim's message, which names fields, never values. */
  message: string;
  field?: string;
  currentRevision?: number;
};

export function triggerProblem(error: unknown): TriggerProblem {
  if (!(error instanceof ApiError)) {
    return {
      code: "unknown",
      status: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const body = error.body ?? {};
  const code = typeof body.code === "string" ? body.code : null;
  const known = TRIGGER_ERROR_CODES.find((each) => each === code);
  if (!known && (error.status === 404 || error.status === 403)) {
    return {
      code: "unavailable",
      status: error.status,
      message: error.message,
    };
  }
  return {
    code: known ?? "unknown",
    status: error.status,
    message: error.message,
    ...(typeof body.field === "string" ? { field: body.field } : {}),
    ...(typeof body.currentRevision === "number"
      ? { currentRevision: body.currentRevision }
      : {}),
  };
}

/** A refusal the person settles by loading the trigger again and reviewing it. */
export function needsReload(problem: TriggerProblem): boolean {
  return (
    problem.code === "revision_conflict" || problem.code === "revision_required"
  );
}

/**
 * Whether this space has triggers: the API answers, or it answers as an
 * unknown path. Anything else, such as Pim being unreachable, is an error,
 * so nothing new shows until the API is known to be there.
 */
export async function triggersAvailable(): Promise<boolean> {
  try {
    await pim.triggers({}, undefined, 1);
    return true;
  } catch (error) {
    if (triggerProblem(error).code === "unavailable") return false;
    throw error;
  }
}

/** How many pages of a listing the screens load at most, so a long one stays bounded. */
export const MAX_PAGES = 10;

export const PROBLEM_TEXT: Record<TriggerProblem["code"], TranslationKey> = {
  invalid_request: "triggerErrorInvalid",
  invalid_cursor: "triggerErrorCursor",
  forbidden: "triggerErrorForbidden",
  not_found: "triggerErrorNotFound",
  revision_conflict: "triggerErrorConflict",
  invalid_transition: "triggerErrorTransition",
  trigger_deleted: "triggerErrorDeleted",
  owned_elsewhere: "triggerErrorOwnedElsewhere",
  grant_required: "triggerErrorGrantRequired",
  grant_not_current: "triggerErrorGrantNotCurrent",
  schedule_exhausted: "triggerErrorExhausted",
  source_not_wired: "triggerErrorNotWired",
  idempotency_conflict: "triggerErrorIdempotency",
  unknown_agent: "triggerErrorUnknownAgent",
  chat_unavailable: "triggerErrorChat",
  source_unavailable: "triggerErrorSourceUnavailable",
  revision_required: "triggerErrorRevisionRequired",
  internal: "triggerErrorInternal",
  unavailable: "triggersUnavailable",
  unknown: "triggerErrorUnknown",
};

export const LIFECYCLE_TEXT: Record<TriggerLifecycle, TranslationKey> = {
  draft: "triggerDraft",
  enabled: "triggerEnabled",
  paused: "triggerPaused",
  ended: "triggerEnded",
  deleted: "triggerDeleted",
};

export const HEALTH_TEXT: Record<TriggerHealth, TranslationKey> = {
  unknown: "triggerHealthUnknown",
  healthy: "triggerHealthHealthy",
  waiting_computer: "triggerHealthWaitingComputer",
  reconnecting: "triggerHealthReconnecting",
  gap: "triggerHealthGap",
  auth_required: "triggerHealthAuth",
  budget_blocked: "triggerHealthBudget",
  configuration_error: "triggerHealthConfiguration",
};

/** Health that needs the person's attention, which the screens mark in the error color. */
export const HEALTH_PROBLEMS: readonly TriggerHealth[] = [
  "gap",
  "auth_required",
  "budget_blocked",
  "configuration_error",
];

export const SOURCE_TEXT: Record<TriggerSourceKind, TranslationKey> = {
  time: "triggerSourceTime",
  connector_event: "triggerSourceConnector",
  poll: "triggerSourcePoll",
  stream: "triggerSourceStream",
  process: "triggerSourceProcess",
  file: "triggerSourceFile",
};

/**
 * What a run's state says, and how it reads. `completed` is only that the
 * agent finished its turn, never that the work in the world succeeded; an
 * accepted run isn't called done, and an unknown outcome is neither a
 * success nor a failure.
 */
export const RUN_TEXT: Record<
  TriggerRunState,
  { key: TranslationKey; tone: "muted" | "active" | "done" | "problem" }
> = {
  pending: { key: "triggerRunPending", tone: "muted" },
  preparing: { key: "triggerRunPreparing", tone: "active" },
  submitting: { key: "triggerRunSubmitting", tone: "active" },
  accepted: { key: "triggerRunAccepted", tone: "active" },
  queued: { key: "triggerRunQueued", tone: "active" },
  running: { key: "triggerRunRunning", tone: "active" },
  waiting_approval: { key: "triggerRunWaitingApproval", tone: "active" },
  completed: { key: "triggerRunCompleted", tone: "done" },
  failed: { key: "triggerRunFailed", tone: "problem" },
  cancelled: { key: "triggerRunCancelled", tone: "muted" },
  not_submitted: { key: "triggerRunNotSubmitted", tone: "muted" },
  missed: { key: "triggerRunMissed", tone: "muted" },
  superseded: { key: "triggerRunSuperseded", tone: "muted" },
  outcome_unknown: { key: "triggerRunUnknown", tone: "problem" },
};

const COMPUTER_KINDS: readonly TriggerSourceKind[] = [
  "poll",
  "stream",
  "process",
  "file",
];

export const runsOnComputer = (kind: TriggerSourceKind) =>
  COMPUTER_KINDS.includes(kind);

/** Sources that run commands as the person's own user: polls, streams and processes. */
export const runsCommands = (kind: TriggerSourceKind) =>
  kind === "poll" || kind === "stream" || kind === "process";

/**
 * What to say of when a trigger acts next. A date only where Pim gave one;
 * otherwise what it is honestly doing (listening, checking, waiting for the
 * computer) or why it won't act.
 */
export type NextLine = { key: TranslationKey; at?: number; minutes?: number };

export function nextLine(trigger: Trigger): NextLine {
  if (trigger.lifecycle === "deleted") return { key: "triggerNextDeleted" };
  if (trigger.lifecycle === "ended") return { key: "triggerNextEnded" };
  if (trigger.migration && !trigger.migration.enableable) {
    return {
      key:
        trigger.migration.kind === "schedule"
          ? "triggerNextLegacySchedule"
          : "triggerNextLegacyWatch",
    };
  }
  const source = trigger.source;
  if (source.kind === "time") {
    const at = trigger.schedule?.nextFiringAt ?? null;
    // A paused trigger shows no time: it resumes at the next scheduled one.
    if (trigger.lifecycle === "paused") return { key: "triggerNextPaused" };
    if (at === null) return { key: "triggerNextNone" };
    return {
      key:
        trigger.lifecycle === "enabled"
          ? "triggerNextAt"
          : "triggerWouldFireAt",
      at,
    };
  }
  if (!trigger.capability.delivers) {
    return {
      key:
        trigger.capability.status === "draft_only"
          ? "triggerNextNotWired"
          : "triggerNextUnavailable",
    };
  }
  if (trigger.lifecycle !== "enabled") return { key: "triggerNextOff" };
  if (
    runsOnComputer(source.kind) &&
    (trigger.health === "waiting_computer" || trigger.health === "reconnecting")
  ) {
    return { key: "triggerNextWaitingComputer" };
  }
  if (source.kind === "poll") {
    return {
      key: "triggerNextChecking",
      minutes: Math.round(source.intervalMs / 60_000),
    };
  }
  return { key: "triggerNextListening" };
}

/** Health isn't one of the API's filters: it narrows the triggers already loaded. */
export function withHealth(
  triggers: readonly Trigger[],
  health: TriggerHealth | undefined,
) {
  return health
    ? triggers.filter((trigger) => trigger.health === health)
    : [...triggers];
}

/**
 * The source kinds a new trigger may take. Time always; a connector's event
 * as a draft only, since nothing takes events in yet; a kind that runs on
 * the computer only where Pim has said it is available, through a trigger of
 * that kind (there is no route for the sources yet).
 */
export function offeredKinds(
  known: readonly Pick<Trigger, "source" | "capability">[],
): TriggerSourceKind[] {
  const available = new Set(
    known
      .filter((trigger) => trigger.capability.status === "available")
      .map((trigger) => trigger.source.kind),
  );
  return [
    "time",
    "connector_event",
    ...COMPUTER_KINDS.filter((kind) => available.has(kind)),
  ];
}

/** The editor's fields, as text, so the person can type freely before it is read. */
export type TriggerForm = {
  label: string;
  instruction: string;
  agentId: string;
  destination: "new_chat" | "existing_chat";
  chatId: string;
  kind: TriggerSourceKind;
  timeSchedule: "once" | "cron" | "interval";
  /** A local date and time, as a datetime-local field gives it. */
  at: string;
  expression: string;
  timeZone: string;
  everyMinutes: string;
  connectorId: string;
  event: string;
  command: string;
  cwd: string;
  pollMinutes: string;
  handle: string;
  expiresAt: string;
  path: string;
  fileEvents: ("created" | "modified" | "deleted")[];
  recursive: boolean;
  /** A simple condition: one field compared, present, or changed. Empty `conditionPath` is none. */
  conditionPath: string;
  conditionOp: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "exists" | "changed";
  conditionValue: string;
};

/** A datetime-local field's text for an instant, in the browser's zone. */
export function localInput(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** A blank form for a new trigger with an agent. */
export function emptyForm(agentId: string): TriggerForm {
  return {
    label: "",
    instruction: "",
    agentId,
    destination: "new_chat",
    chatId: "",
    kind: "time",
    timeSchedule: "once",
    at: "",
    expression: "0 9 * * *",
    timeZone: browserTimeZone(),
    everyMinutes: "60",
    connectorId: "",
    event: "",
    command: "",
    cwd: "",
    pollMinutes: "5",
    handle: "",
    expiresAt: "",
    path: "",
    fileEvents: ["created", "modified", "deleted"],
    recursive: false,
    conditionPath: "",
    conditionOp: "eq",
    conditionValue: "",
  };
}

/** A condition the simple form can show and edit; null for none, undefined for one it can't. */
function simpleCondition(
  condition: TriggerCondition | null,
):
  | Pick<TriggerForm, "conditionPath" | "conditionOp" | "conditionValue">
  | null
  | undefined {
  if (!condition) return null;
  const when = condition.when;
  if (condition.staleAfterMs != null) return undefined;
  if (when.op === "compare") {
    return {
      conditionPath: when.path.join("."),
      conditionOp: when.cmp,
      conditionValue: String(when.value),
    };
  }
  if (when.op === "exists" || when.op === "changed") {
    return {
      conditionPath: when.path.join("."),
      conditionOp: when.op,
      conditionValue: "",
    };
  }
  return undefined;
}

/** Whether the form can edit a trigger's condition, rather than keep it as it is. */
export const conditionEditable = (trigger: Trigger) =>
  simpleCondition(trigger.condition) !== undefined;

/** The form for editing a trigger, filled in from it. */
export function formOf(trigger: Trigger): TriggerForm {
  const form = emptyForm(trigger.agentId);
  form.label = trigger.label;
  form.instruction = trigger.instruction;
  if (trigger.destination.type === "existing_chat") {
    form.destination = "existing_chat";
    form.chatId = trigger.destination.chatId;
  }
  const source = trigger.source;
  form.kind = source.kind;
  switch (source.kind) {
    case "time":
      form.timeSchedule = source.schedule;
      if (source.schedule === "once") form.at = localInput(source.at);
      if (source.schedule === "cron") {
        form.expression = source.expression;
        form.timeZone = source.timeZone;
      }
      if (source.schedule === "interval") {
        form.everyMinutes = String(source.everyMs / 60_000);
      }
      break;
    case "connector_event":
      form.connectorId = source.connectorId;
      form.event = source.event;
      break;
    case "poll":
      form.command = source.command;
      form.cwd = source.cwd ?? "";
      form.pollMinutes = String(source.intervalMs / 60_000);
      break;
    case "stream":
      form.command = source.command;
      form.cwd = source.cwd ?? "";
      break;
    case "process":
      form.handle = source.handle;
      form.expiresAt = localInput(source.expiresAt);
      break;
    case "file":
      form.path = source.path;
      form.fileEvents = [...source.events];
      form.recursive = source.recursive;
      break;
  }
  const condition = simpleCondition(trigger.condition);
  if (condition) Object.assign(form, condition);
  return form;
}

export type FormProblem = { field: keyof TriggerForm; key: TranslationKey };

const minutes = (text: string) => {
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const instant = (text: string) => {
  const value = text ? new Date(text).getTime() : Number.NaN;
  return Number.isFinite(value) ? value : null;
};

/** What a typed condition value is: a number, true or false, or text. Nothing else is converted. */
function conditionValue(text: string): string | number | boolean {
  const trimmed = text.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed !== "" && Number.isFinite(Number(trimmed)))
    return Number(trimmed);
  return text;
}

function conditionOf(form: TriggerForm): TriggerCondition | null {
  const path = form.conditionPath
    .split(".")
    .map((key) => key.trim())
    .filter(Boolean);
  if (path.length === 0) return null;
  const when: TriggerExpression =
    form.conditionOp === "exists" || form.conditionOp === "changed"
      ? { op: form.conditionOp, path }
      : {
          op: "compare",
          path,
          cmp: form.conditionOp,
          value: conditionValue(form.conditionValue),
        };
  return { when };
}

/**
 * The trigger the form describes, or what to fix first. Only what the form
 * can check itself: Pim checks the rest, such as a cron expression or a time
 * in the past, and names the field.
 */
export function inputOf(
  form: TriggerForm,
): { input: TriggerInput } | { problem: FormProblem } {
  const problem = (field: keyof TriggerForm, key: TranslationKey) => ({
    problem: { field, key },
  });
  if (!form.label.trim()) return problem("label", "triggerNeedsLabel");
  if (!form.instruction.trim()) {
    return problem("instruction", "triggerNeedsInstruction");
  }
  let source: TriggerSource;
  switch (form.kind) {
    case "time": {
      if (form.timeSchedule === "once") {
        const at = instant(form.at);
        if (at === null) return problem("at", "triggerNeedsTime");
        source = { kind: "time", schedule: "once", at } as TriggerSource;
      } else if (form.timeSchedule === "cron") {
        if (!form.expression.trim()) {
          return problem("expression", "triggerNeedsCron");
        }
        source = {
          kind: "time",
          schedule: "cron",
          expression: form.expression.trim(),
          timeZone: form.timeZone.trim() || "UTC",
        } as TriggerSource;
      } else {
        const every = minutes(form.everyMinutes);
        if (every === null) return problem("everyMinutes", "triggerNeedsEvery");
        source = {
          kind: "time",
          schedule: "interval",
          everyMs: Math.round(every * 60_000),
          anchorAt: Date.now(),
        } as TriggerSource;
      }
      break;
    }
    case "connector_event":
      if (!form.connectorId.trim()) {
        return problem("connectorId", "triggerNeedsConnector");
      }
      if (!form.event.trim()) return problem("event", "triggerNeedsEvent");
      source = {
        kind: "connector_event",
        connectorId: form.connectorId.trim(),
        event: form.event.trim(),
        arguments: {},
      };
      break;
    case "poll": {
      if (!form.command.trim())
        return problem("command", "triggerNeedsCommand");
      const every = minutes(form.pollMinutes);
      if (every === null) return problem("pollMinutes", "triggerNeedsEvery");
      source = {
        kind: "poll",
        command: form.command,
        cwd: form.cwd.trim() || null,
        intervalMs: Math.round(every * 60_000),
      } as TriggerSource;
      break;
    }
    case "stream":
      if (!form.command.trim())
        return problem("command", "triggerNeedsCommand");
      source = {
        kind: "stream",
        command: form.command,
        cwd: form.cwd.trim() || null,
      };
      break;
    case "process": {
      if (!form.handle.trim()) return problem("handle", "triggerNeedsHandle");
      const expiresAt = instant(form.expiresAt);
      if (expiresAt === null) return problem("expiresAt", "triggerNeedsTime");
      source = { kind: "process", handle: form.handle.trim(), expiresAt };
      break;
    }
    case "file":
      if (!form.path.trim()) return problem("path", "triggerNeedsPath");
      if (form.fileEvents.length === 0) {
        return problem("fileEvents", "triggerNeedsFileEvents");
      }
      source = {
        kind: "file",
        path: form.path.trim(),
        events: form.fileEvents,
        recursive: form.recursive,
      };
      break;
  }
  const condition = form.kind === "time" ? null : conditionOf(form);
  if (form.kind === "poll" && condition === null) {
    return problem("conditionPath", "triggerNeedsCondition");
  }
  const destination: TriggerDestination =
    form.destination === "existing_chat"
      ? { type: "existing_chat", chatId: form.chatId }
      : { type: "new_chat" };
  if (destination.type === "existing_chat" && !destination.chatId) {
    return problem("chatId", "triggerNeedsChat");
  }
  return {
    input: {
      label: form.label.trim(),
      instruction: form.instruction,
      source,
      ...(condition ? { condition } : {}),
      destination,
      agentId: form.agentId,
    },
  };
}

/** Whether a source the form made is the one a trigger has: its defaults aside, the same fields. */
function sameSource(made: TriggerSource, saved: TriggerSource): boolean {
  if (made.kind !== saved.kind) return false;
  const given = made as Record<string, unknown>;
  const kept = saved as Record<string, unknown>;
  return Object.keys(given).every((name) => {
    // An interval's start is "now" in the form; an unchanged interval keeps its own.
    if (name === "anchorAt") return true;
    if (name === "arguments") return true;
    // A typed time is to the minute: an unchanged one keeps its own.
    if (name === "at" || name === "expiresAt") {
      return (
        localInput(given[name] as number) === localInput(kept[name] as number)
      );
    }
    return JSON.stringify(given[name]) === JSON.stringify(kept[name]);
  });
}

/**
 * What an edit changes: only the fields that differ from the trigger as it
 * was loaded, so an unchanged source keeps its grant and its arguments.
 */
export function changeOf(
  trigger: Trigger,
  form: TriggerForm,
  input: TriggerInput,
): Partial<Omit<TriggerInput, "agentId">> {
  const change: Partial<Omit<TriggerInput, "agentId">> = {};
  if (input.label !== trigger.label) change.label = input.label;
  if (input.instruction !== trigger.instruction) {
    change.instruction = input.instruction;
  }
  if (!sameSource(input.source, trigger.source)) change.source = input.source;
  if (conditionEditable(trigger) || form.kind !== trigger.source.kind) {
    const condition = input.condition ?? null;
    if (JSON.stringify(condition) !== JSON.stringify(trigger.condition)) {
      change.condition = condition;
    }
  }
  if (
    JSON.stringify(input.destination) !== JSON.stringify(trigger.destination)
  ) {
    change.destination = input.destination;
  }
  return change;
}

/** A condition in a line, such as `price < 500`. Values are the person's own, never an observation. */
export function conditionText(expression: TriggerExpression): string {
  const symbols = { eq: "=", ne: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥" };
  switch (expression.op) {
    case "compare":
      return `${expression.path.join(".")} ${symbols[expression.cmp]} ${JSON.stringify(expression.value)}`;
    case "exists":
      return `${expression.path.join(".")} exists`;
    case "changed":
      return `${expression.path.join(".")} changed`;
    case "all":
      return expression.of.map(conditionText).join(" and ");
    case "any":
      return expression.of.map(conditionText).join(" or ");
    case "not":
      return `not (${conditionText(expression.of)})`;
    case "stable_for":
      return `${conditionText(expression.of)} for ${Math.round(expression.ms / 1000)} s`;
    case "hysteresis":
      return `${expression.path.join(".")} ${expression.direction} past ${expression.enter} (until ${expression.exit})`;
  }
}

/** A fresh key for one creation, so sending it again gives the same trigger. */
export function creationKey(): string {
  return `web-${crypto.randomUUID()}`;
}

/*
 * A computer source's grant. An agent asks for it with
 * `trigger_computer_grant`, which files an approval of
 * `trigger_computer_source` whose arguments are exactly the grant's scope
 * (src/triggers/grant-action.ts); the person decides it like any approval.
 */

/** The approval's action a grant comes from (`COMPUTER_GRANT_ACTION` in src/triggers/computer.ts). */
export const GRANT_ACTION = "trigger_computer_source";

/** What a grant consents to: one source's exact configuration, of one trigger, on one computer. */
export type GrantScope = {
  space: string;
  runtimeId: string;
  triggerId: string;
  sourceId: string;
  configHash: string;
};

/** The scope an approval asks for, or null when it isn't a grant request. */
export function grantScopeOf(approval: Approval): GrantScope | null {
  if (approval.action !== GRANT_ACTION) return null;
  const args = (approval.args ?? {}) as Record<string, unknown>;
  const fields = [
    "space",
    "runtimeId",
    "triggerId",
    "sourceId",
    "configHash",
  ] as const;
  if (!fields.every((field) => typeof args[field] === "string")) return null;
  return args as GrantScope;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The digest of a computer source's configuration, as Pim and pim-computer
 * compute it (`sourceConfigHash` in src/triggers/computer.ts), so the screen
 * can tell whether a request is for the source the trigger has now.
 */
export async function sourceConfigHash(source: TriggerSource): Promise<string> {
  const bytes = new TextEncoder().encode(
    `triggers.v1/source\n${canonical(source)}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Where a trigger's grant request stands, for the screen that decides it.
 * `pending` is the only one the person may approve; `outdated` and an
 * `expired` one still pending may only be declined, since approving them
 * would grant nothing the trigger runs now.
 */
export type GrantStanding =
  | { kind: "not_required" | "off" | "none" }
  | {
      kind: "pending" | "approved" | "declined";
      approval: Approval;
      scope: GrantScope;
    }
  | {
      kind: "outdated";
      reason: "changed" | "ended";
      approval: Approval;
      scope: GrantScope;
    }
  | {
      kind: "expired";
      reason: "timeout" | "source";
      approval: Approval;
      scope: GrantScope;
    };

/**
 * The request the screen shows for a trigger, and where it stands: the
 * newest still waiting, or else the newest decided. `currentHash` is
 * `sourceConfigHash` of the trigger's source as loaded.
 */
export function grantStanding(
  trigger: Trigger,
  approvals: readonly Approval[],
  currentHash: string,
  now: number,
): GrantStanding {
  if (!trigger.grant.required) return { kind: "not_required" };
  if (trigger.grant.state === "unavailable") return { kind: "off" };
  const requests = approvals
    .map((approval) => ({ approval, scope: grantScopeOf(approval) }))
    .filter(
      (request): request is { approval: Approval; scope: GrantScope } =>
        request.scope?.triggerId === trigger.id,
    )
    .sort((a, b) => b.approval.createdAt - a.approval.createdAt);
  const request =
    requests.find(({ approval }) => approval.status === "pending") ??
    requests[0];
  if (!request) return { kind: "none" };
  const { approval } = request;
  if (approval.status === "pending") {
    if (approval.expiresAt !== null && approval.expiresAt <= now) {
      return { kind: "expired", reason: "timeout", ...request };
    }
    if (trigger.source.kind === "process" && trigger.source.expiresAt <= now) {
      return { kind: "expired", reason: "source", ...request };
    }
    if (trigger.lifecycle === "ended" || trigger.lifecycle === "deleted") {
      return { kind: "outdated", reason: "ended", ...request };
    }
    if (request.scope.configHash !== currentHash) {
      return { kind: "outdated", reason: "changed", ...request };
    }
    return { kind: "pending", ...request };
  }
  if (approval.status === "approved") return { kind: "approved", ...request };
  if (approval.decidedBy === "timeout") {
    return { kind: "expired", reason: "timeout", ...request };
  }
  return { kind: "declined", ...request };
}

/**
 * Decides a grant request. When someone already decided it, from another
 * tab or the chat, it answers with the request as it stands instead, so the
 * screen shows that decision rather than an error.
 */
export async function decideGrant(
  id: string,
  decision: "approve" | "deny",
): Promise<{ approval: Approval; already: boolean }> {
  try {
    return { approval: await pim.decide(id, decision), already: false };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    return { approval: await pim.approval(id), already: true };
  }
}
