import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, pim } from "~/lib/pim-api";
import { triggersQuery } from "~/lib/queries";
import {
  changeOf,
  emptyForm,
  formOf,
  inputOf,
  nextLine,
  offeredKinds,
  PROBLEM_TEXT,
  TRIGGER_ERROR_CODES,
  triggerProblem,
  triggersAvailable,
} from "~/lib/triggers";
import {
  connectorFixture,
  pollFixture,
  triggerFixture,
} from "~/test/trigger-fixtures";

type Answer = { status: number; body: unknown };

/** Answers each request in turn, as Pim would, and keeps what was asked. */
function answer(...answers: Answer[]) {
  const asked: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      asked.push({ url, init });
      const next = answers.shift();
      if (!next) throw new Error(`Nothing scripted for ${url}`);
      return new Response(JSON.stringify(next.body), { status: next.status });
    }),
  );
  return asked;
}

const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

afterEach(() => vi.unstubAllGlobals());

describe("whether the space has triggers", () => {
  it("is no where the routes answer as an unknown path, or to a guest", async () => {
    answer({ status: 404, body: { error: "Not found" } });
    expect(await triggersAvailable()).toBe(false);
    answer({
      status: 403,
      body: {
        error: "A guest's account only chats with the bot it joined through.",
      },
    });
    expect(await triggersAvailable()).toBe(false);
  });

  it("is yes when the API answers, and unknown, not no, when Pim fails", async () => {
    const asked = answer({
      status: 200,
      body: { triggers: [], nextCursor: null },
    });
    expect(await triggersAvailable()).toBe(true);
    expect(asked[0]?.url).toBe("/api/triggers?limit=1");
    answer({ status: 500, body: { error: "Boom", code: "internal" } });
    await expect(triggersAvailable()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("refusals", () => {
  it("tells the gate being off from a trigger that doesn't exist", () => {
    expect(
      triggerProblem(new ApiError(404, "Not found", { error: "Not found" }))
        .code,
    ).toBe("unavailable");
    expect(
      triggerProblem(
        new ApiError(404, "No such trigger", {
          error: "No such trigger",
          code: "not_found",
        }),
      ).code,
    ).toBe("not_found");
  });

  it("keeps a conflict's current revision and the field Pim named", () => {
    expect(
      triggerProblem(
        new ApiError(409, "conflict", {
          error: "conflict",
          code: "revision_conflict",
          currentRevision: 5,
        }),
      ),
    ).toMatchObject({ code: "revision_conflict", currentRevision: 5 });
    expect(
      triggerProblem(
        new ApiError(428, "If-Match: required", {
          error: "If-Match: required",
          code: "revision_required",
        }),
      ).code,
    ).toBe("revision_required");
    expect(
      triggerProblem(
        new ApiError(400, "source.expression: is not valid", {
          error: "source.expression: is not valid",
          code: "invalid_request",
          field: "source.expression",
        }),
      ),
    ).toMatchObject({ code: "invalid_request", field: "source.expression" });
  });

  it("says something of its own for every code in the API's table", () => {
    const texts = TRIGGER_ERROR_CODES.map((code) => PROBLEM_TEXT[code]);
    expect(new Set(texts).size).toBe(TRIGGER_ERROR_CODES.length);
    expect(texts).not.toContain(PROBLEM_TEXT.unknown);
    expect(
      triggerProblem(new ApiError(409, "x", { error: "x", code: "made_up" }))
        .code,
    ).toBe("unknown");
  });
});

describe("requests", () => {
  it("makes a draft under an idempotency key, never enabled", async () => {
    const asked = answer({ status: 201, body: triggerFixture() });
    const read = inputOf({
      ...emptyForm("p_ada"),
      label: "Brief",
      instruction: "Do it",
      timeSchedule: "cron",
    });
    if (!("input" in read)) throw new Error("form refused");
    await pim.createTrigger(read.input, "web-key-1");
    const [request] = asked;
    expect(request?.init.method).toBe("POST");
    expect(headerOf(request?.init, "idempotency-key")).toBe("web-key-1");
    const body = JSON.parse(String(request?.init.body));
    expect(body).not.toHaveProperty("enabled");
    expect(body.source).toEqual({
      kind: "time",
      schedule: "cron",
      expression: "0 9 * * *",
      timeZone: expect.any(String),
    });
  });

  it("changes, pauses, turns on and deletes only at the revision reviewed", async () => {
    const asked = answer(
      { status: 200, body: triggerFixture() },
      { status: 200, body: triggerFixture() },
      { status: 200, body: triggerFixture() },
      { status: 200, body: { deleted: true, trigger: triggerFixture() } },
    );
    await pim.updateTrigger("trg_morning", 3, { label: "New" });
    await pim.pauseTrigger("trg_morning", 3);
    await pim.resumeTrigger("trg_morning", 3);
    await pim.deleteTrigger("trg_morning", 3);
    expect(
      asked.map(({ url, init }) => [
        init.method,
        url,
        headerOf(init, "if-match"),
      ]),
    ).toEqual([
      ["PATCH", "/api/triggers/trg_morning", '"3"'],
      ["POST", "/api/triggers/trg_morning/pause", '"3"'],
      ["POST", "/api/triggers/trg_morning/resume", '"3"'],
      ["DELETE", "/api/triggers/trg_morning", '"3"'],
    ]);
  });

  it("pages a listing by its cursor, with the filters kept, and stops at the last page", async () => {
    const asked = answer(
      { status: 200, body: { triggers: [triggerFixture()], nextCursor: "c2" } },
      { status: 200, body: { triggers: [pollFixture()], nextCursor: null } },
    );
    const client = new QueryClient();
    const filters = {
      lifecycle: "enabled" as const,
      sourceKind: "poll" as const,
    };
    await client.fetchInfiniteQuery({ ...triggersQuery(filters), pages: 3 });
    const data = client.getQueryData(triggersQuery(filters).queryKey);
    expect(
      data?.pages.flatMap((page) => page.triggers.map((t) => t.id)),
    ).toEqual(["trg_morning", "trg_build"]);
    expect(asked.map(({ url }) => url)).toEqual([
      "/api/triggers?limit=20&lifecycle=enabled&sourceKind=poll",
      "/api/triggers?limit=20&lifecycle=enabled&sourceKind=poll&cursor=c2",
    ]);
  });
});

describe("what a trigger does next", () => {
  it("gives a date only where Pim gave one", () => {
    const at = Date.UTC(2026, 10, 9, 9);
    expect(
      nextLine(
        triggerFixture({
          lifecycle: "enabled",
          schedule: { nextFiringAt: at, nextCheckAt: at },
        }),
      ),
    ).toEqual({ key: "triggerNextAt", at });
    expect(nextLine(triggerFixture())).toMatchObject({
      key: "triggerWouldFireAt",
    });
    expect(
      nextLine(
        triggerFixture({
          lifecycle: "paused",
          schedule: { nextFiringAt: at, nextCheckAt: at },
        }),
      ),
    ).toEqual({ key: "triggerNextPaused" });
    expect(
      nextLine(
        triggerFixture({ schedule: { nextFiringAt: null, nextCheckAt: null } }),
      ),
    ).toEqual({ key: "triggerNextNone" });
    for (const trigger of [
      pollFixture(),
      pollFixture({ health: "healthy" }),
      connectorFixture(),
    ]) {
      expect(nextLine(trigger).at).toBeUndefined();
    }
  });

  it("says a computer source waits for the computer, checks, or listens", () => {
    expect(nextLine(pollFixture()).key).toBe("triggerNextWaitingComputer");
    expect(nextLine(pollFixture({ health: "healthy" }))).toEqual({
      key: "triggerNextChecking",
      minutes: 5,
    });
    expect(
      nextLine(
        pollFixture({
          health: "healthy",
          source: { kind: "stream", command: "tail -f log", cwd: null },
        }),
      ).key,
    ).toBe("triggerNextListening");
    expect(nextLine(pollFixture({ lifecycle: "paused" })).key).toBe(
      "triggerNextOff",
    );
    expect(nextLine(connectorFixture()).key).toBe("triggerNextNotWired");
  });

  it("says a shadow runs through its schedule, whatever its next firing", () => {
    const shadow = triggerFixture({
      migration: {
        kind: "schedule",
        legacyId: "s1",
        owner: "legacy",
        phase: "shadow",
        enableable: false,
        ownerSince: null,
      },
    });
    expect(nextLine(shadow)).toEqual({ key: "triggerNextLegacySchedule" });
  });
});

describe("the editor's form", () => {
  it("offers a computer source only where Pim said that kind is available", () => {
    expect(offeredKinds([])).toEqual(["time", "connector_event"]);
    expect(
      offeredKinds([
        pollFixture({
          capability: {
            status: "unavailable",
            delivers: false,
            reason: "computer_triggers_off",
          },
        }),
      ]),
    ).toEqual(["time", "connector_event"]);
    expect(offeredKinds([pollFixture()])).toEqual([
      "time",
      "connector_event",
      "poll",
    ]);
  });

  it("needs a time for a one-time trigger, and a condition for a checked command", () => {
    const base = { ...emptyForm("p_ada"), label: "x", instruction: "y" };
    expect(inputOf(base)).toEqual({
      problem: { field: "at", key: "triggerNeedsTime" },
    });
    expect(inputOf({ ...base, kind: "poll", command: "make" })).toEqual({
      problem: { field: "conditionPath", key: "triggerNeedsCondition" },
    });
  });

  it("reads a condition's value as a number or true/false, and keeps other text as text", () => {
    const base = {
      ...emptyForm("p_ada"),
      label: "x",
      instruction: "y",
      kind: "poll" as const,
      command: "curl -s example.test",
      conditionPath: "price.amount",
      conditionOp: "lt" as const,
    };
    const value = (text: string) => {
      const read = inputOf({ ...base, conditionValue: text });
      if (!("input" in read)) throw new Error("form refused");
      return read.input.condition?.when;
    };
    expect(value("500")).toEqual({
      op: "compare",
      path: ["price", "amount"],
      cmp: "lt",
      value: 500,
    });
    expect(value("false")).toMatchObject({ value: false });
    expect(value("0x")).toMatchObject({ value: "0x" });
  });

  it("changes only what the person changed, so an untouched source keeps its grant", () => {
    const poll = pollFixture();
    const form = formOf(poll);
    const unchanged = inputOf(form);
    if (!("input" in unchanged)) throw new Error("form refused");
    expect(changeOf(poll, form, unchanged.input)).toEqual({});

    const renamed = { ...form, label: "Build guard" };
    const read = inputOf(renamed);
    if (!("input" in read)) throw new Error("form refused");
    expect(changeOf(poll, renamed, read.input)).toEqual({
      label: "Build guard",
    });

    const faster = { ...form, pollMinutes: "2" };
    const quicker = inputOf(faster);
    if (!("input" in quicker)) throw new Error("form refused");
    expect(changeOf(poll, faster, quicker.input).source).toMatchObject({
      kind: "poll",
      intervalMs: 120_000,
    });
  });

  it("keeps an interval's start and a connector's arguments when they weren't edited", () => {
    const interval = triggerFixture({
      source: {
        kind: "time",
        schedule: "interval",
        everyMs: 3_600_000,
        anchorAt: Date.UTC(2026, 0, 1),
        catchUpMs: 3_600_000,
      },
    });
    const form = formOf(interval);
    const read = inputOf(form);
    if (!("input" in read)) throw new Error("form refused");
    expect(changeOf(interval, form, read.input)).toEqual({});

    const mail = connectorFixture();
    const mailForm = formOf(mail);
    const mailRead = inputOf(mailForm);
    if (!("input" in mailRead)) throw new Error("form refused");
    expect(changeOf(mail, mailForm, mailRead.input)).toEqual({});
  });
});
