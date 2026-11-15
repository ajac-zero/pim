import { describe, expect, it } from "vitest";
import { type Condition, type ConditionState, evaluate, parseCondition } from "../src/condition";
import { TRIGGER_LIMITS, type TimeSource, parseTriggerSpec } from "../src/spec";
import { type JsonValue, TriggerValidationError } from "../src/validate";

// The spec's reading and the condition language, with no store: what a stored trigger is made of (docs/triggers.md).

const START = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const base = {
	version: 1,
	owningAgentId: "agent-1",
	originChatId: "chat-1",
	label: "Watch",
	instruction: "Tell me what changed.",
	destination: { type: "existing_chat", chatId: "chat-1" },
};

const pollSpec = (over: Record<string, unknown> = {}) => ({
	...base,
	source: { kind: "poll", command: "./price.sh" },
	condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 500 } },
	authorizationRef: "approval-1",
	...over,
});

const eventSpec = (over: Record<string, unknown> = {}) => ({
	...base,
	source: { kind: "connector_event", connectorId: "flights", event: "price.changed" },
	...over,
});

/** A spec of each kind of source, as a caller would write it, with no ids or authorization for the store to object to. */
function everySource(): Record<string, unknown>[] {
	const exists = { when: { op: "exists", path: ["a"] } };
	return [
		{ ...base, source: { kind: "time", schedule: "once", at: START + HOUR } },
		{ ...base, source: { kind: "time", schedule: "cron", expression: "0 9 * * 1-5", timeZone: "Europe/Lisbon" } },
		{ ...base, source: { kind: "time", schedule: "interval", everyMs: HOUR, anchorAt: START } },
		eventSpec({ condition: exists }),
		pollSpec({ condition: { when: { op: "stable_for", ms: MINUTE, of: { op: "compare", path: ["up"], cmp: "eq", value: false } } } }),
		{ ...base, source: { kind: "stream", command: "./tail.sh", cwd: "/var/log" }, authorizationRef: "approval-1" },
		{ ...base, source: { kind: "process", handle: "proc-1", expiresAt: START + HOUR }, condition: exists, authorizationRef: "approval-1" },
		{
			...base,
			source: { kind: "file", path: "/home/ada/inbox", events: ["created", "deleted"], recursive: true },
			destination: { type: "new_chat" },
			authorizationRef: "approval-1",
		},
	];
}

describe("trigger specs", () => {
	it("reads each source with the documented defaults written in", () => {
		const once = parseTriggerSpec({ ...base, source: { kind: "time", schedule: "once", at: START } });
		expect(once.source).toEqual({ kind: "time", schedule: "once", at: START, maxLatenessMs: 3_600_000 });
		expect(once.delivery).toEqual({ rawSamples: false, maxPendingEvents: null });
		expect(once.authorizationRef).toBeNull();
		const cron = parseTriggerSpec({
			...base,
			source: { kind: "time", schedule: "cron", expression: " 0  9 * * 1-5 ", timeZone: "Europe/Lisbon" },
		});
		expect(cron.source).toEqual({
			kind: "time",
			schedule: "cron",
			expression: "0 9 * * 1-5",
			timeZone: "Europe/Lisbon",
			catchUpMs: 3_600_000,
		});
		expect(
			parseTriggerSpec({ ...base, source: { kind: "time", schedule: "cron", expression: "*/15 0-6,22 1 1,7 *", timeZone: "UTC" } }).source,
		).toMatchObject({ timeZone: "UTC" });
		expect(
			parseTriggerSpec({ ...base, source: { kind: "time", schedule: "interval", everyMs: MINUTE, anchorAt: START } }).source,
		).toMatchObject({ catchUpMs: 3_600_000 });
		const poll = parseTriggerSpec(pollSpec());
		expect(poll.source).toEqual({ kind: "poll", command: "./price.sh", cwd: null, intervalMs: 300_000, deadlineMs: 30_000 });
		// A state goes stale after two intervals unless the condition says otherwise.
		expect(poll.condition?.staleAfterMs).toBe(600_000);
		expect(poll.delivery).toEqual({ rawSamples: false, maxPendingEvents: null });
		const event = parseTriggerSpec(eventSpec());
		expect(event.source).toEqual({ kind: "connector_event", connectorId: "flights", event: "price.changed", arguments: {} });
		expect(event.delivery).toEqual({ rawSamples: false, maxPendingEvents: 20 });
		expect(
			parseTriggerSpec({ ...base, source: { kind: "stream", command: "tail -F log | jq -c .", cwd: "/var/log" } }).source,
		).toMatchObject({ cwd: "/var/log" });
		const process = parseTriggerSpec({
			...base,
			source: { kind: "process", handle: "proc-7", expiresAt: START + HOUR },
			condition: { when: { op: "compare", path: ["exitCode"], cmp: "ne", value: 0 } },
		});
		expect(process.source).toEqual({ kind: "process", handle: "proc-7", expiresAt: START + HOUR });
		expect(process.delivery).toEqual({ rawSamples: false, maxPendingEvents: 20 });
		expect(
			parseTriggerSpec({
				...base,
				source: { kind: "file", path: "/home/ada/inbox", events: ["created"] },
				destination: { type: "new_chat" },
			}),
		).toMatchObject({
			source: { recursive: false },
			destination: { type: "new_chat" },
		});
	});

	it("reads a spec it wrote back as the same spec, for every source", () => {
		for (const spec of everySource()) {
			const canonical = parseTriggerSpec(spec);
			// As read, and as stored: the JSON the store keeps for a revision.
			expect(parseTriggerSpec(canonical), JSON.stringify(spec.source)).toEqual(canonical);
			expect(parseTriggerSpec(JSON.parse(JSON.stringify(canonical))), JSON.stringify(spec.source)).toEqual(canonical);
		}
		// Null is the stored form for a source that holds one snapshot; a number is still refused.
		expect(() =>
			parseTriggerSpec({ ...base, source: { kind: "time", schedule: "once", at: START }, delivery: { maxPendingEvents: 1 } }),
		).toThrow(TriggerValidationError);
	});

	it("refuses unknown fields, unsupported forms and anything out of bounds, naming the field", () => {
		const deep = (levels: number): unknown => (levels === 0 ? { op: "exists", path: ["a"] } : { op: "not", of: deep(levels - 1) });
		const wide = {
			op: "all",
			of: Array.from({ length: 4 }, () => ({ op: "all", of: Array.from({ length: 16 }, () => ({ op: "exists", path: ["a"] })) })),
		};
		const cases: [unknown, string][] = [
			[{ ...pollSpec(), owner: "someone-else" }, "spec"],
			[{ ...pollSpec(), version: 2 }, "spec.version"],
			[{ ...base, source: { kind: "webhook" } }, "spec.source.kind"],
			[{ ...base, source: { kind: "time", schedule: "once", at: START, catchUpMs: 0 } }, "spec.source"],
			...["0 9 * * MON", "@daily", "0 0 L * *", "0 0 9 * * *", "60 * * * *", "0 0 31 2 *", "0 0 ? * *", "5-1 * * * *", "*/0 * * * *"].map(
				(expression) =>
					[{ ...base, source: { kind: "time", schedule: "cron", expression, timeZone: "UTC" } }, "spec.source.expression"] as [
						unknown,
						string,
					],
			),
			...["+01:00", "Mars/Olympus", "", "Europe/../Lisbon"].map(
				(timeZone) =>
					[{ ...base, source: { kind: "time", schedule: "cron", expression: "0 9 * * *", timeZone } }, "spec.source.timeZone"] as [
						unknown,
						string,
					],
			),
			[{ ...base, source: { kind: "time", schedule: "interval", everyMs: 59_999, anchorAt: START } }, "spec.source.everyMs"],
			[pollSpec({ source: { kind: "poll", command: "./price.sh", intervalMs: 59_999 } }), "spec.source.intervalMs"],
			[pollSpec({ source: { kind: "poll", command: "./price.sh", deadlineMs: 30_001 } }), "spec.source.deadlineMs"],
			[pollSpec({ source: { kind: "poll", command: "./price.sh", cwd: "relative/dir" } }), "spec.source.cwd"],
			[pollSpec({ source: { kind: "poll", command: "" } }), "spec.source.command"],
			[pollSpec({ condition: null }), "spec.condition"],
			[pollSpec({ delivery: { maxPendingEvents: 5 } }), "spec.delivery.maxPendingEvents"],
			[eventSpec({ delivery: { rawSamples: true } }), "spec.delivery.rawSamples"],
			[pollSpec({ delivery: { rawSamples: true } }), "spec.delivery.rawSamples"],
			[eventSpec({ delivery: { maxPendingEvents: 101 } }), "spec.delivery.maxPendingEvents"],
			[
				{ ...base, source: { kind: "time", schedule: "once", at: START }, condition: { when: { op: "exists", path: ["a"] } } },
				"spec.condition",
			],
			[eventSpec({ condition: { when: { op: "changed", path: ["price"] } } }), "spec.condition.when.op"],
			[eventSpec({ condition: { when: { op: "exists", path: ["a"] }, staleAfterMs: 60_000 } }), "spec.condition.staleAfterMs"],
			[
				eventSpec({ source: { kind: "connector_event", connectorId: "flights", event: "x", arguments: { a: "x".repeat(5_000) } } }),
				"spec.source.arguments",
			],
			[{ ...base, source: { kind: "file", path: "/home/ada/../root", events: ["created"] } }, "spec.source.path"],
			[{ ...base, source: { kind: "file", path: "/home/ada", events: ["created", "created"] } }, "spec.source.events"],
			// A process by name can't say which run of it finished: only a handle to one instance, watched for a bounded time.
			[{ ...base, source: { kind: "process", name: "make" } }, "spec.source"],
			[{ ...base, source: { kind: "process", handle: "proc-7" } }, "spec.source.expiresAt"],
			[{ ...base, source: { kind: "process", expiresAt: START } }, "spec.source.handle"],
			[{ ...base, source: { kind: "process", handle: "proc 7", expiresAt: START } }, "spec.source.handle"],
			[
				{ ...base, source: { kind: "poll", command: "./a.sh", expiresAt: START }, condition: { when: { op: "exists", path: ["a"] } } },
				"spec.source",
			],
			[{ ...eventSpec(), label: "x".repeat(121) }, "spec.label"],
			[{ ...eventSpec(), instruction: "ring\u0007" }, "spec.instruction"],
			[{ ...eventSpec(), destination: { type: "existing_chat" } }, "spec.destination.chatId"],
			[{ ...eventSpec(), destination: { type: "new_chat", chatId: "chat-1" } }, "spec.destination"],
			[pollSpec({ condition: { when: { op: "regex", path: ["a"], value: ".*" } } }), "spec.condition.when.op"],
			[pollSpec({ condition: { when: { op: "eval", value: "1" } } }), "spec.condition.when.op"],
			[pollSpec({ condition: { when: { op: "compare", path: ["a"], cmp: "lt", value: "b" } } }), "spec.condition.when.cmp"],
			[
				pollSpec({ condition: { when: { op: "compare", path: ["a"], cmp: "eq", value: Number.POSITIVE_INFINITY } } }),
				"spec.condition.when.value",
			],
			[pollSpec({ condition: { when: { op: "compare", path: ["a"], cmp: "eq", value: null } } }), "spec.condition.when.value"],
			[pollSpec({ condition: { when: { op: "exists", path: ["__proto__"] } } }), "spec.condition.when.path[0]"],
			[pollSpec({ condition: { when: { op: "all", of: [] } } }), "spec.condition.when.of"],
			[pollSpec({ condition: { when: deep(8) } }), "spec.condition.when.of.of.of.of.of.of.of.of"],
			[pollSpec({ condition: { when: wide } }), "spec.condition.when.of[3].of[11]"],
			[
				pollSpec({ condition: { when: { op: "stable_for", ms: MINUTE, of: { op: "changed", path: ["a"] } } } }),
				"spec.condition.when.of.op",
			],
			[
				pollSpec({ condition: { when: { op: "hysteresis", path: ["t"], direction: "rising", enter: 30, exit: 30 } } }),
				"spec.condition.when.exit",
			],
			[
				pollSpec({ condition: { when: { op: "hysteresis", path: ["t"], direction: "rising", enter: Number.NaN, exit: 20 } } }),
				"spec.condition.when.enter",
			],
		];
		for (const [spec, path] of cases) {
			let error: unknown;
			try {
				parseTriggerSpec(spec);
			} catch (thrown) {
				error = thrown;
			}
			expect(error, JSON.stringify(spec)).toBeInstanceOf(TriggerValidationError);
			expect((error as TriggerValidationError).path, JSON.stringify(spec)).toBe(path);
		}
		// The deepest and widest conditions within the bounds are taken.
		expect(() => parseTriggerSpec(pollSpec({ condition: { when: deep(7) } }))).not.toThrow();
		expect(() => parseTriggerSpec(pollSpec({ condition: { when: { op: "all", of: wide.of.slice(0, 3) } } }))).not.toThrow();
	});
});

describe("trigger conditions", () => {
	const edge = (when: unknown, staleAfterMs?: number): Condition =>
		parseCondition({ when, ...(staleAfterMs ? { staleAfterMs } : {}) }, "edge");

	/** Evaluates `condition` on observations a minute apart and returns, for each, `fire` or its truth, and the edge state after it. */
	function evaluated(condition: Condition, observations: (JsonValue | { gap: JsonValue })[]) {
		let state: ConditionState | null = null;
		return observations.map((observation, index) => {
			const gap = typeof observation === "object" && observation !== null && !Array.isArray(observation) && "gap" in observation;
			const value = gap ? (observation as { gap: JsonValue }).gap : (observation as JsonValue);
			const at = START + index * MINUTE;
			const result = evaluate(condition, "edge", state, { value, observedAt: at, gap }, at);
			state = result.state;
			return { outcome: result.fire ? "fire" : result.truth, edge: result.state.edge };
		});
	}

	function series(condition: Condition, observations: (JsonValue | { gap: JsonValue })[]) {
		return evaluated(condition, observations).map((step) => step.outcome);
	}

	function truth(when: unknown, value: JsonValue) {
		return evaluate(parseCondition({ when }, "filter"), "filter", null, { value, observedAt: START, gap: false }, START).truth;
	}

	it("tells a missing field from a false one: missing is unknown, and only exists asks", () => {
		const below = { op: "compare", path: ["price"], cmp: "lt", value: 500 };
		const unequal = { op: "compare", path: ["status"], cmp: "ne", value: "ok" };
		expect(truth(below, { price: 400 })).toBe("true");
		expect(truth(below, { price: 600 })).toBe("false");
		expect(truth(below, {})).toBe("unknown");
		expect(truth(below, { price: null })).toBe("unknown");
		// No coercion: text that looks like a number is not one.
		expect(truth(below, { price: "400" })).toBe("unknown");
		expect(truth(unequal, {})).toBe("unknown");
		expect(truth(unequal, { status: "down" })).toBe("true");
		expect(truth({ op: "not", of: below }, {})).toBe("unknown");
		expect(truth({ op: "exists", path: ["price"] }, {})).toBe("false");
		expect(truth({ op: "exists", path: ["price"] }, { price: null })).toBe("false");
		expect(truth({ op: "exists", path: ["price"] }, { price: 0 })).toBe("true");
		// Lookups stay in the data: an object's inherited fields are not there.
		expect(truth({ op: "exists", path: ["constructor"] }, {})).toBe("false");
		expect(truth({ op: "exists", path: ["a", "b"] }, { a: [{ b: 1 }] })).toBe("false");
		expect(truth({ op: "compare", path: ["a", "b"], cmp: "gte", value: 2 }, { a: { b: 2 } })).toBe("true");
		const missing = { op: "exists", path: ["nothing"] };
		const unknown = below;
		const yes = { op: "exists", path: ["here"] };
		const value = { here: 1 };
		expect(truth({ op: "all", of: [missing, unknown] }, value)).toBe("false");
		expect(truth({ op: "all", of: [yes, unknown] }, value)).toBe("unknown");
		expect(truth({ op: "any", of: [yes, unknown] }, value)).toBe("true");
		expect(truth({ op: "any", of: [missing, unknown] }, value)).toBe("unknown");
	});

	it("fires on a true only after a known false with nothing unknown between", () => {
		const low = edge({ op: "compare", path: ["price"], cmp: "lt", value: 500 });
		const T = { price: 400 };
		const F = { price: 600 };
		const U = {};
		// Each row: observations, then what each did and the edge state after it.
		const table: [JsonValue[], string[], string[]][] = [
			[
				[T, T],
				["true", "true"],
				["waiting_for_false", "waiting_for_false"],
			],
			[
				[F, T],
				["false", "fire"],
				["armed", "waiting_for_false"],
			],
			[
				[T, U, T],
				["true", "unknown", "true"],
				["waiting_for_false", "unknown", "waiting_for_false"],
			],
			[
				[F, U, T],
				["false", "unknown", "true"],
				["armed", "unknown", "waiting_for_false"],
			],
			[
				[U, F, T],
				["unknown", "false", "fire"],
				["unknown", "armed", "waiting_for_false"],
			],
			[
				[F, T, T, F, T],
				["false", "fire", "true", "false", "fire"],
				["armed", "waiting_for_false", "waiting_for_false", "armed", "waiting_for_false"],
			],
		];
		for (const [observations, outcomes, edges] of table) {
			const steps = evaluated(low, observations);
			expect(
				steps.map((step) => step.outcome),
				JSON.stringify(observations),
			).toEqual(outcomes);
			expect(
				steps.map((step) => step.edge),
				JSON.stringify(observations),
			).toEqual(edges);
		}
		// A gap breaks continuity as unknown does: a false after it is needed before a true fires.
		expect(series(low, [F, { gap: T }, T])).toEqual(["false", "true", "true"]);
		expect(series(low, [F, { gap: F }, T])).toEqual(["false", "false", "fire"]);
	});

	it("fires on each change it sees, and starts comparing again after a gap", () => {
		const status = edge({ op: "changed", path: ["status"] });
		// A missing value breaks continuity: the next one is a new baseline, not a change.
		expect(
			series(status, [{ status: "a" }, { status: "b" }, { status: "c" }, { status: "c" }, {}, { status: "d" }, { status: "e" }]),
		).toEqual(["false", "fire", "fire", "false", "unknown", "false", "fire"]);
		expect(series(status, [{ status: "a" }, { gap: { status: "b" } }, { status: "b" }, { status: "c" }])).toEqual([
			"false",
			"false",
			"false",
			"fire",
		]);
		// A change under `not` is not news of a change.
		const unchanged = edge({
			op: "any",
			of: [
				{ op: "not", of: { op: "changed", path: ["status"] } },
				{ op: "exists", path: ["alarm"] },
			],
		});
		expect(
			series(unchanged, [
				{ status: "a", alarm: 1 },
				{ status: "b", alarm: 1 },
				{ status: "c", alarm: 1 },
			]),
		).toEqual(["true", "true", "true"]);
	});

	it("holds stable_for only through continuous truth, which unknown and a gap break", () => {
		const down = edge({ op: "stable_for", ms: 2 * MINUTE, of: { op: "compare", path: ["up"], cmp: "eq", value: false } });
		expect(series(down, [{ up: true }, { up: false }, { up: false }, { up: false }, { up: false }])).toEqual([
			"false",
			"false",
			"false",
			"fire",
			"true",
		]);
		expect(series(down, [{ up: true }, { up: false }, {}, { up: false }, { up: false }, { up: false }])).toEqual([
			"false",
			"false",
			"unknown",
			"false",
			"false",
			"fire",
		]);
		expect(series(down, [{ up: true }, { up: false }, { up: false }, { gap: { up: false } }, { up: false }, { up: false }])).toEqual([
			"false",
			"false",
			"false",
			"false",
			"false",
			"fire",
		]);
		// An unknown result of the whole condition breaks it too, even where `stable_for` itself saw only truth.
		const quietlyDown = edge({ op: "all", of: [down.when, { op: "compare", path: ["load"], cmp: "lt", value: 5 }] });
		const down1 = { up: false, load: 1 };
		expect(series(quietlyDown, [{ up: true, load: 1 }, down1, down1, { up: false }, down1, down1, down1])).toEqual([
			"false",
			"false",
			"false",
			"unknown",
			"false",
			"false",
			"fire",
		]);
	});

	it("keeps a hysteresis band from flapping", () => {
		const cheap = edge({ op: "hysteresis", path: ["price"], direction: "falling", enter: 500, exit: 520 });
		expect(
			series(cheap, [
				{ price: 510 },
				{ price: 530 },
				{ price: 499 },
				{ price: 510 },
				{ price: 499 },
				{ price: 525 },
				{ price: 510 },
				{ price: 500 },
			]),
		).toEqual(["unknown", "false", "fire", "true", "true", "false", "false", "fire"]);
	});

	it("treats an observation older than staleAfterMs as no evidence", () => {
		const low = edge({ op: "compare", path: ["price"], cmp: "lt", value: 500 }, 5 * MINUTE);
		const armed = evaluate(low, "edge", null, { value: { price: 600 }, observedAt: START, gap: false }, START);
		const late = evaluate(low, "edge", armed.state, { value: { price: 400 }, observedAt: START + MINUTE, gap: false }, START + 7 * MINUTE);
		expect(late).toMatchObject({ truth: "unknown", fire: false, stale: true, state: { edge: "unknown" } });
		// It broke continuity, so a fresh true after it waits for a false.
		const fresh = evaluate(
			low,
			"edge",
			late.state,
			{ value: { price: 400 }, observedAt: START + 7 * MINUTE, gap: false },
			START + 7 * MINUTE,
		);
		expect(fresh).toMatchObject({ fire: false, state: { edge: "waiting_for_false" } });
	});

	it("evaluates every operand, so state is kept even where the result was already decided", () => {
		const either = edge({
			op: "any",
			of: [
				{ op: "exists", path: ["alarm"] },
				{ op: "changed", path: ["n"] },
			],
		});
		// Both results are decided by `alarm`, yet `changed` sees both values, so the second is a change.
		expect(
			series(either, [
				{ alarm: 1, n: 1 },
				{ alarm: 1, n: 2 },
			]),
		).toEqual(["true", "fire"]);
	});
});
