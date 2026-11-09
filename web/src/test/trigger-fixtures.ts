import type { Approval, Trigger, TriggerRun } from "~/lib/pim-api";

/*
 * Answers of the triggers' API for tests only, shaped as docs/triggers.md
 * ("The API") gives them. Nothing in the app imports this file.
 */

const POLICIES: Trigger["policies"] = {
  lateness: null,
  maxPendingEvents: null,
  pendingSnapshots: 1,
  rawSamples: false,
  runsAtOnce: 1,
  deliveryTtlMs: 86_400_000,
  replayHorizonMs: null,
  staleAfterMs: null,
};

/** A draft time trigger, as Pim answers it; override any field. */
export function triggerFixture(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "trg_morning",
    revision: 3,
    lifecycle: "draft",
    health: "unknown",
    agentId: "p_ada",
    label: "Morning brief",
    instruction: "Summarize my calendar for today.",
    source: {
      kind: "time",
      schedule: "cron",
      expression: "0 9 * * 1-5",
      timeZone: "Europe/Lisbon",
      catchUpMs: 3_600_000,
    },
    condition: null,
    destination: { type: "new_chat" },
    origin: { type: "api" },
    policies: {
      ...POLICIES,
      lateness: { catchUpMs: 3_600_000, coalesce: "latest_due" },
    },
    schedule: { nextFiringAt: Date.UTC(2026, 10, 9, 9, 0), nextCheckAt: null },
    capability: { status: "available", delivers: true, reason: null },
    grant: { required: false, state: "not_required" },
    createdAt: Date.UTC(2026, 10, 1),
    updatedAt: Date.UTC(2026, 10, 2),
    ...overrides,
  };
}

/** A poll on the person's computer, enabled and waiting for the computer. */
export const pollFixture = (overrides: Partial<Trigger> = {}) =>
  triggerFixture({
    id: "trg_build",
    label: "Build watcher",
    instruction: "Tell me when the build breaks.",
    lifecycle: "enabled",
    health: "waiting_computer",
    source: {
      kind: "poll",
      command: "make check",
      cwd: "/home/ada/project",
      intervalMs: 300_000,
      deadlineMs: 30_000,
    },
    condition: {
      when: { op: "compare", path: ["status"], cmp: "ne", value: 0 },
    },
    policies: { ...POLICIES, staleAfterMs: 600_000 },
    schedule: null,
    grant: { required: true, state: "pending_approval" },
    ...overrides,
  });

/** A connector event kept as a draft: nothing takes connector events in yet. */
export const connectorFixture = (overrides: Partial<Trigger> = {}) =>
  triggerFixture({
    id: "trg_mail",
    label: "Invoice mail",
    instruction: "File invoices that arrive.",
    source: {
      kind: "connector_event",
      connectorId: "gmail",
      event: "message_received",
      arguments: { query: "label:invoices", token: "sk-live-SECRET-VALUE" },
    },
    policies: {
      ...POLICIES,
      maxPendingEvents: 20,
      pendingSnapshots: null,
      replayHorizonMs: 604_800_000,
    },
    schedule: null,
    capability: {
      status: "draft_only",
      delivers: false,
      reason: "not_wired",
    },
    ...overrides,
  });

/** A run of a trigger, as Pim answers it; override any field. */
export function runFixture(overrides: Partial<TriggerRun> = {}): TriggerRun {
  return {
    id: "occ_1",
    triggerId: "trg_morning",
    revision: 3,
    state: "completed",
    outcomeKnown: true,
    occurrenceStatus: "delivered",
    phase: "completed",
    dueAt: Date.UTC(2026, 10, 6, 9, 0),
    evidence: { reason: "time", scheduledFor: Date.UTC(2026, 10, 6, 9, 0) },
    chatId: "chat_brief",
    deliverBy: null,
    submittedAt: null,
    acceptedAt: null,
    endedAt: null,
    deferrals: 0,
    unknownAnswers: 0,
    createdAt: Date.UTC(2026, 10, 6, 9, 0),
    updatedAt: Date.UTC(2026, 10, 6, 9, 1),
    ...overrides,
  };
}

/** A grant request for the poll above, as `trigger_computer_source` files it; override any field. */
export function grantApprovalFixture(
  overrides: Partial<Approval> = {},
): Approval {
  return {
    id: "apr_grant",
    session: "chat_build",
    action: "trigger_computer_source",
    tool: null,
    args: {
      space: "ada",
      runtimeId: "rt_laptop",
      triggerId: "trg_build",
      sourceId: "src_1",
      configHash: "hash_now",
    },
    summary:
      'Let the trigger "Build watcher" run `make check` in /home/ada/project on your computer every 5 minutes. It runs as your own user on the computer, with everything that user can reach, until you revoke it or the trigger stops.',
    status: "pending",
    note: null,
    result: null,
    createdAt: Date.UTC(2026, 10, 7, 12, 0),
    decidedAt: null,
    callId: "call_1",
    expiresAt: null,
    decidedBy: null,
    ...overrides,
  };
}
