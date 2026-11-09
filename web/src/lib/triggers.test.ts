import { createHash } from "node:crypto";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18nFor } from "~/components/i18n";
import {
  ApiError,
  type Approval,
  pim,
  TRIGGER_HEALTHS,
  TRIGGER_LIFECYCLES,
  type Trigger,
  type TriggerExpression,
} from "~/lib/pim-api";
import { triggersQuery } from "~/lib/queries";
import {
  changeOf,
  conditionWords,
  cronWords,
  decideGrant,
  emptyForm,
  formOf,
  grantStanding,
  HEALTH_TEXT,
  healthChip,
  inputOf,
  nextLine,
  offeredKinds,
  PROBLEM_TEXT,
  sourceConfigHash,
  TRIGGER_ERROR_CODES,
  triggerProblem,
  triggersAvailable,
  withHealth,
} from "~/lib/triggers";
import {
  connectorFixture,
  grantApprovalFixture,
  pollFixture,
  triggerFixture,
} from "~/test/trigger-fixtures";
import type { Theme } from "../../../src/themes";

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
    // A draft poll says how often it will run, whether or not Pim can run it here yet.
    for (const capability of [
      { status: "available", delivers: true, reason: null },
      {
        status: "draft_only",
        delivers: false,
        reason: "computer_not_paired",
      },
    ] as const) {
      expect(
        nextLine(
          pollFixture({
            lifecycle: "draft",
            capability,
            source: {
              kind: "poll",
              command: "make check",
              cwd: null,
              intervalMs: 900_000,
              deadlineMs: 30_000,
            },
          }),
        ),
      ).toEqual({ key: "triggerNextOnceOn", everyMs: 900_000 });
    }
    expect(nextLine(connectorFixture()).key).toBe("triggerNextNotWired");
    // An enabled computer source whose computer was removed says to pair one, not that it waits.
    expect(
      nextLine(
        pollFixture({
          lifecycle: "enabled",
          health: "waiting_computer",
          capability: {
            status: "draft_only",
            delivers: false,
            reason: "computer_not_paired",
          },
        }),
      ).key,
    ).toBe("triggerPairComputerFirst");
  });
});

describe("the editor's form", () => {
  it("offers a computer source only where Pim said that kind is available", () => {
    expect(offeredKinds([])).toEqual(["time", "connector_event"]);
    expect(
      offeredKinds([
        pollFixture({
          capability: {
            status: "draft_only",
            delivers: false,
            reason: "computer_not_paired",
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

describe("a grant request", () => {
  const now = Date.UTC(2026, 10, 8, 12, 0);
  const poll = pollFixture();
  const request = (overrides: Partial<Approval> = {}, args = {}) =>
    grantApprovalFixture({
      ...overrides,
      args: { ...(grantApprovalFixture().args as object), ...args },
    });
  const standing = (approvals: Approval[], trigger: Trigger = poll) =>
    grantStanding(trigger, approvals, "hash_now", now);

  it("digests a source exactly as Pim does, whatever the order of its fields", async () => {
    // Pim's digest (src/triggers/computer.ts): SHA-256 of the protocol's prefix and the source with its keys sorted.
    const expected = (canonical: string) =>
      createHash("sha256")
        .update(`triggers.v1/source\n${canonical}`)
        .digest("hex");
    expect(
      await sourceConfigHash({
        kind: "poll",
        intervalMs: 300_000,
        command: "make check",
        deadlineMs: 30_000,
        cwd: "/home/ada/project",
      }),
    ).toBe(
      expected(
        '{"command":"make check","cwd":"/home/ada/project","deadlineMs":30000,"intervalMs":300000,"kind":"poll"}',
      ),
    );
    expect(
      await sourceConfigHash({
        kind: "stream",
        command: 'tail -f "a b"',
        cwd: null,
      }),
    ).toBe(
      expected('{"command":"tail -f \\"a b\\"","cwd":null,"kind":"stream"}'),
    );
  });

  it("is the newest one waiting, approvable only for the source the trigger has now", () => {
    const older = request({ id: "apr_old", createdAt: now - 3_000 });
    const newer = request({ id: "apr_new", createdAt: now - 2_000 });
    const decidedLater = request({
      id: "apr_done",
      createdAt: now - 1_000,
      status: "denied",
      decidedBy: "user",
      decidedAt: now - 500,
    });
    const shown = standing([older, decidedLater, newer]);
    expect(shown.kind).toBe("pending");
    expect("approval" in shown && shown.approval.id).toBe("apr_new");

    const changed = grantStanding(poll, [newer], "hash_before_edit", now);
    expect(changed).toMatchObject({ kind: "outdated", reason: "changed" });
    expect(
      standing([newer], pollFixture({ lifecycle: "ended" })),
    ).toMatchObject({ kind: "outdated", reason: "ended" });
  });

  it("expires at its deadline, not a moment before", () => {
    expect(standing([request({ expiresAt: now + 1 })]).kind).toBe("pending");
    expect(standing([request({ expiresAt: now })])).toMatchObject({
      kind: "expired",
      reason: "timeout",
    });
    expect(
      standing([
        request({ status: "denied", decidedBy: "timeout", decidedAt: now - 1 }),
      ]),
    ).toMatchObject({ kind: "expired", reason: "timeout" });
    const watch = pollFixture({
      source: { kind: "process", handle: "pid:42", expiresAt: now },
    });
    expect(standing([request()], watch)).toMatchObject({
      kind: "expired",
      reason: "source",
    });
  });

  it("shows the newest decision once none is waiting", () => {
    const approved = request({
      status: "approved",
      decidedBy: "user",
      decidedAt: now - 10,
      createdAt: now - 20,
    });
    const declined = request({
      id: "apr_no",
      status: "denied",
      decidedBy: "user",
      decidedAt: now - 1,
      createdAt: now - 5,
    });
    expect(standing([approved]).kind).toBe("approved");
    expect(standing([approved, declined]).kind).toBe("declined");
  });

  it("finds nothing in another trigger's request, another action, or a malformed scope", () => {
    expect(
      standing([
        request({}, { triggerId: "trg_other" }),
        request({ action: "shell" }),
        request({}, { configHash: 7 }),
      ]).kind,
    ).toBe("none");
  });

  it("needs nothing for a trigger off the computer", () => {
    expect(standing([request()], triggerFixture()).kind).toBe("not_required");
  });

  it("is decided once: a request someone already decided answers as it stands", async () => {
    const approved = request({ status: "approved", decidedBy: "user" });
    let asked = answer({ status: 200, body: approved });
    expect(await decideGrant("apr_grant", "approve")).toEqual({
      approval: approved,
      already: false,
    });
    expect(asked[0]?.url).toBe("/api/approvals/apr_grant/approve");
    expect(asked[0]?.init.method).toBe("POST");

    const denied = request({ status: "denied", decidedBy: "user" });
    asked = answer(
      { status: 409, body: { error: "Approval apr_grant is already denied" } },
      { status: 200, body: denied },
    );
    expect(await decideGrant("apr_grant", "approve")).toEqual({
      approval: denied,
      already: true,
    });
    expect(asked.map(({ url }) => url)).toEqual([
      "/api/approvals/apr_grant/approve",
      "/api/approvals/apr_grant",
    ]);

    answer({ status: 403, body: { error: "This capability is turned off" } });
    await expect(decideGrant("apr_grant", "approve")).rejects.toThrow(
      "This capability is turned off",
    );
  });
});

describe("healthChip", () => {
  const cases = TRIGGER_LIFECYCLES.flatMap((lifecycle) =>
    TRIGGER_HEALTHS.map((health) => [lifecycle, health] as const),
  );

  it.each(cases)("%s × %s", (lifecycle, health) => {
    const chip = healthChip({
      lifecycle,
      health,
      source: pollFixture().source,
    });
    if (lifecycle !== "enabled") return expect(chip).toBeNull();
    expect(chip?.reason).toBeNull();
    expect(chip?.text).toBe(
      health === "unknown" ? "triggerHealthWaitingFirst" : HEALTH_TEXT[health],
    );
  });

  it("hides non-problem health of a time trigger, and filters the same way", () => {
    const time = triggerFixture({ lifecycle: "enabled", health: "healthy" });
    const gap = triggerFixture({ lifecycle: "enabled", health: "gap" });
    const poll = pollFixture({ health: "healthy" });
    expect(healthChip(time)).toBeNull();
    expect(healthChip(gap)).not.toBeNull();
    expect(healthChip(poll)).not.toBeNull();
    expect(withHealth([time, gap, poll], "healthy")).toEqual([poll]);
    expect(withHealth([time, gap, poll], "gap")).toEqual([gap]);
  });

  it.each(TRIGGER_LIFECYCLES)("%s with lost evidence", (lifecycle) => {
    const chip = healthChip({
      lifecycle,
      health: "unknown",
      source: pollFixture().source,
      healthDetail: "  the computer went quiet ",
    });
    expect(chip).toEqual(
      lifecycle === "enabled"
        ? { text: "triggerHealthCantCheck", reason: "the computer went quiet" }
        : null,
    );
  });

  it("never words unknown as healthy", () => {
    for (const healthDetail of [undefined, null, "", "lost"]) {
      expect(
        healthChip({
          lifecycle: "enabled",
          health: "unknown",
          source: pollFixture().source,
          healthDetail,
        })?.text,
      ).not.toBe("triggerHealthHealthy");
    }
  });
});

describe("chip colors", () => {
  const themes = Object.values(
    import.meta.glob<Record<string, Theme>>(
      [
        "../../../src/extensions/themes/*.ts",
        "!../../../src/extensions/themes/index.ts",
      ],
      { eager: true },
    ),
  ).flatMap((module) => Object.values(module));

  /** Relative luminance of a hex or neutral OKLCH color, as themes.test.ts reads them. */
  const luminance = (color: string) => {
    const neutral = /^oklch\(([\d.]+) 0 0\)$/.exec(color);
    if (neutral) return Number(neutral[1]) ** 3;
    return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
      const channel =
        Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) / 255;
      const linear =
        channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      return sum + linear * weight;
    }, 0);
  };

  // Chips are drawn as foreground text on the muted fill; the colored dot is decoration.
  it.each(themes)("$name's chip text reads at 4.5:1 in both modes", (theme) => {
    for (const mode of ["light", "dark"] as const) {
      const a = luminance(theme[mode].foreground);
      const b = luminance(theme[mode].muted);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      expect(ratio, `${theme.id} ${mode}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("sources and conditions in words", () => {
  const en = i18nFor("en");
  const es = i18nFor("es");
  // Some ICU versions put a narrow no-break space before AM and PM.
  const cron = (expression: string, zone: string, i18n = en) =>
    cronWords(expression, zone, i18n)?.replace(/\u202f/g, " ") ?? null;

  it("says a daily cron at its time and its zone's city", () => {
    expect(cron("0 8 * * *", "Europe/Lisbon")).toBe(
      "Every day at 8:00 AM, Lisbon time",
    );
    expect(cron("0 8 * * *", "Europe/Lisbon", es)).toBe(
      "Todos los días a las 8:00, hora de Lisbon",
    );
    expect(cron("30 13 * * *", "America/New_York")).toBe(
      "Every day at 1:30 PM, New York time",
    );
    expect(cron("0 1 * * *", "UTC", es)).toBe("Todos los días a la 1:00, UTC");
  });

  it("says every n minutes or hours only where n divides the cycle", () => {
    expect(cron("*/15 * * * *", "UTC")).toBe("Every 15 minutes");
    expect(cron("* * * * *", "UTC")).toBe("Every minute");
    expect(cron("0 */2 * * *", "Europe/Lisbon")).toBe("Every 2 hours");
    expect(cron("0 * * * *", "UTC", es)).toBe("Cada hora");
    expect(cron("30 */6 * * *", "UTC")).toBe("Every 6 hours, at minute 30");
    expect(cron("*/7 * * * *", "UTC")).toBeNull();
    expect(cron("0 */5 * * *", "UTC")).toBeNull();
  });

  it("names weekdays, the days of a week and a day of the month", () => {
    expect(cron("0 9 * * 1-5", "Europe/Lisbon")).toBe(
      "Every weekday at 9:00 AM, Lisbon time",
    );
    expect(cron("0 9 * * 1,2,3,4,5", "UTC", es)).toBe(
      "De lunes a viernes a las 9:00, UTC",
    );
    expect(cron("0 18 * * 7,1,4", "UTC")).toBe(
      "Every Monday, Thursday, and Sunday at 6:00 PM, UTC",
    );
    expect(cron("0 18 * * 1,4", "UTC", es)).toBe(
      "Cada lunes y jueves a las 18:00, UTC",
    );
    expect(cron("0 9 * * 0-6", "UTC")).toBe("Every day at 9:00 AM, UTC");
    expect(cron("0 9 1 * *", "UTC")).toBe(
      "Every month on the 1st at 9:00 AM, UTC",
    );
    expect(cron("15 7 22 * *", "UTC")).toBe(
      "Every month on the 22nd at 7:15 AM, UTC",
    );
    expect(cron("0 9 13 * *", "UTC")).toBe(
      "Every month on the 13th at 9:00 AM, UTC",
    );
    expect(cron("0 9 1 * *", "UTC", es)).toBe(
      "Cada mes, el día 1, a las 9:00, UTC",
    );
  });

  it("gives no words for any other shape, or a zone that isn't a city", () => {
    for (const expression of [
      "0 9 31 * *",
      "0 9 1 6 *",
      "0 9 13 * 5",
      "0 9-17 * * *",
      "*/15 9 * * *",
      "0 9 * * 1/2",
      "0 9 * *",
      "",
    ]) {
      expect(cron(expression, "UTC"), expression).toBeNull();
    }
    expect(cron("0 8 * * *", "Etc/GMT+5")).toBeNull();
    expect(cron("0 8 * * *", "Not/AZone")).toBeNull();
  });

  it("says a command or a process failing or succeeding in words", () => {
    const exit = (path: string, cmp: "eq" | "ne" | "gt" | "lt") =>
      conditionWords({ op: "compare", path: [path], cmp, value: 0 }, en);
    expect(exit("status", "ne")).toBe(
      "the command fails (exits with an error)",
    );
    expect(exit("status", "gt")).toBe(
      "the command fails (exits with an error)",
    );
    expect(exit("status", "eq")).toBe(
      "the command succeeds (exits without an error)",
    );
    expect(exit("exitCode", "ne")).toBe("the process exits with an error");
    expect(exit("status", "lt")).toBe("the field status is below 0");
    expect(
      conditionWords(
        { op: "compare", path: ["status"], cmp: "ne", value: 0 },
        es,
      ),
    ).toBe("el comando falla (termina con un error)");
  });

  it("says comparisons, presence, changes, bands and durations of a field", () => {
    expect(
      conditionWords(
        { op: "compare", path: ["price", "amount"], cmp: "lt", value: 500 },
        en,
      ),
    ).toBe("the field price.amount is below 500");
    expect(
      conditionWords(
        { op: "compare", path: ["state"], cmp: "eq", value: "done" },
        en,
      ),
    ).toBe('the field state is "done"');
    expect(
      conditionWords(
        { op: "compare", path: ["ok"], cmp: "ne", value: true },
        es,
      ),
    ).toBe("el campo ok no es verdadero");
    expect(
      conditionWords(
        { op: "compare", path: ["price"], cmp: "gte", value: 1.25 },
        es,
      ),
    ).toBe("el campo price es 1,25 o más");
    expect(
      conditionWords(
        {
          op: "all",
          of: [
            { op: "exists", path: ["price"] },
            { op: "changed", path: ["price"] },
          ],
        },
        en,
      ),
    ).toBe("the field price is there and the field price changes");
    expect(
      conditionWords(
        {
          op: "hysteresis",
          path: ["price"],
          direction: "falling",
          enter: 500,
          exit: 520,
        },
        en,
      ),
    ).toBe(
      "the field price drops to 500 or less (until it climbs back to 520)",
    );
    expect(
      conditionWords(
        {
          op: "stable_for",
          ms: 600_000,
          of: { op: "compare", path: ["status"], cmp: "ne", value: 0 },
        },
        en,
      ),
    ).toBe("the command fails (exits with an error), for at least 10 minutes");
  });

  it("gives no words for a negation, a list of lists, or anything inside them", () => {
    const leaf: TriggerExpression = { op: "exists", path: ["a"] };
    expect(conditionWords({ op: "not", of: leaf }, en)).toBeNull();
    expect(
      conditionWords(
        { op: "any", of: [leaf, { op: "all", of: [leaf, leaf] }] },
        en,
      ),
    ).toBeNull();
    expect(
      conditionWords({ op: "all", of: [leaf, { op: "not", of: leaf }] }, en),
    ).toBeNull();
  });
});
