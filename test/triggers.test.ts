import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Pim } from "../src/pim";
import { type Condition, type ConditionState, evaluate, parseCondition } from "../src/triggers/condition";
import { parseTriggerSpec } from "../src/triggers/spec";
import { type AuthorizationRequest, type AuthorizationVerdict, TRIGGER_TABLES, TriggerStore, type TriggerStoreOptions } from "../src/triggers/store";
import { type JsonValue, TriggerValidationError } from "../src/triggers/validate";

// Triggers are not wired into Pim yet (docs/triggers.md): these tests use their store on a Durable Object's database of its own.

const START = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Clock = { now: number };

type Context = {
	store: TriggerStore;
	clock: Clock;
	sql: SqlStorage;
	/** Another store on the same database, with some options of its own. */
	make: (options?: Partial<TriggerStoreOptions>) => TriggerStore;
	/** The database's own transactions, which the store is given. */
	transaction: <T>(work: () => T) => T;
};

/** Runs `work` with a trigger store on a fresh space's database, its clock set by the test. */
async function withStore(work: (context: Context) => void): Promise<void> {
	await runInDurableObject(env.Pim.getByName(`triggers-${crypto.randomUUID()}`), (_pim: Pim, state) => {
		const clock = { now: START };
		const transaction = <T>(run: () => T): T => state.storage.transactionSync(run);
		const make = (options: Partial<TriggerStoreOptions> = {}) => new TriggerStore(state.storage.sql, { transaction, now: () => clock.now, authorize: anyApproval, ...options });
		work({ store: make(), clock, sql: state.storage.sql, make, transaction });
	});
}

/** A host that takes any `approval-…` reference, for tests that aren't about checking grants. */
function anyApproval(request: AuthorizationRequest): AuthorizationVerdict {
	return request.authorizationRef.startsWith("approval-") ? { ok: true } : { ok: false, reason: "unknown grant" };
}

const base = { version: 1, owningAgentId: "agent-1", originChatId: "chat-1", label: "Watch", instruction: "Tell me what changed.", destination: { type: "existing_chat", chatId: "chat-1" } };

const pollSpec = (over: Record<string, unknown> = {}) => ({
	...base,
	source: { kind: "poll", command: "./price.sh" },
	condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 500 } },
	authorizationRef: "approval-1",
	...over,
});

const eventSpec = (over: Record<string, unknown> = {}) => ({ ...base, source: { kind: "connector_event", connectorId: "flights", event: "price.changed" }, ...over });

function count(sql: SqlStorage, table: string): number {
	return Number(sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n);
}

function created(store: TriggerStore, spec: unknown, lifecycle: "draft" | "enabled" = "enabled", id?: string) {
	const result = store.create({ spec, lifecycle, ...(id ? { id } : {}) });
	if (!result.ok) throw new Error(`not created: ${result.reason}`);
	return result.trigger;
}

describe("trigger specs", () => {
	it("reads each source with the documented defaults written in", () => {
		const once = parseTriggerSpec({ ...base, source: { kind: "time", schedule: "once", at: START } });
		expect(once.source).toEqual({ kind: "time", schedule: "once", at: START, maxLatenessMs: 3_600_000 });
		expect(once.delivery).toEqual({ rawSamples: false, maxPendingEvents: null });
		expect(once.authorizationRef).toBeNull();
		const cron = parseTriggerSpec({ ...base, source: { kind: "time", schedule: "cron", expression: " 0  9 * * 1-5 ", timeZone: "Europe/Lisbon" } });
		expect(cron.source).toEqual({ kind: "time", schedule: "cron", expression: "0 9 * * 1-5", timeZone: "Europe/Lisbon", catchUpMs: 3_600_000 });
		expect(parseTriggerSpec({ ...base, source: { kind: "time", schedule: "cron", expression: "*/15 0-6,22 1 1,7 *", timeZone: "UTC" } }).source).toMatchObject({ timeZone: "UTC" });
		expect(parseTriggerSpec({ ...base, source: { kind: "time", schedule: "interval", everyMs: MINUTE, anchorAt: START } }).source).toMatchObject({ catchUpMs: 3_600_000 });
		const poll = parseTriggerSpec(pollSpec());
		expect(poll.source).toEqual({ kind: "poll", command: "./price.sh", cwd: null, intervalMs: 300_000, deadlineMs: 30_000 });
		// A state goes stale after two intervals unless the condition says otherwise.
		expect(poll.condition?.staleAfterMs).toBe(600_000);
		expect(poll.delivery).toEqual({ rawSamples: false, maxPendingEvents: null });
		const event = parseTriggerSpec(eventSpec());
		expect(event.source).toEqual({ kind: "connector_event", connectorId: "flights", event: "price.changed", arguments: {} });
		expect(event.delivery).toEqual({ rawSamples: false, maxPendingEvents: 20 });
		expect(parseTriggerSpec({ ...base, source: { kind: "stream", command: "tail -F log | jq -c .", cwd: "/var/log" } }).source).toMatchObject({ cwd: "/var/log" });
		const process = parseTriggerSpec({ ...base, source: { kind: "process", handle: "proc-7", expiresAt: START + HOUR }, condition: { when: { op: "compare", path: ["exitCode"], cmp: "ne", value: 0 } } });
		expect(process.source).toEqual({ kind: "process", handle: "proc-7", expiresAt: START + HOUR });
		expect(process.delivery).toEqual({ rawSamples: false, maxPendingEvents: 20 });
		expect(parseTriggerSpec({ ...base, source: { kind: "file", path: "/home/ada/inbox", events: ["created"] }, destination: { type: "new_chat" } })).toMatchObject({
			source: { recursive: false },
			destination: { type: "new_chat" },
		});
	});

	it("refuses unknown fields, unsupported forms and anything out of bounds, naming the field", () => {
		const deep = (levels: number): unknown => (levels === 0 ? { op: "exists", path: ["a"] } : { op: "not", of: deep(levels - 1) });
		const wide = { op: "all", of: Array.from({ length: 4 }, () => ({ op: "all", of: Array.from({ length: 16 }, () => ({ op: "exists", path: ["a"] })) })) };
		const cases: [unknown, string][] = [
			[{ ...pollSpec(), owner: "someone-else" }, "spec"],
			[{ ...pollSpec(), version: 2 }, "spec.version"],
			[{ ...base, source: { kind: "webhook" } }, "spec.source.kind"],
			[{ ...base, source: { kind: "time", schedule: "once", at: START, catchUpMs: 0 } }, "spec.source"],
			...["0 9 * * MON", "@daily", "0 0 L * *", "0 0 9 * * *", "60 * * * *", "0 0 31 2 *", "0 0 ? * *", "5-1 * * * *", "*/0 * * * *"].map(
				(expression) => [{ ...base, source: { kind: "time", schedule: "cron", expression, timeZone: "UTC" } }, "spec.source.expression"] as [unknown, string],
			),
			...["+01:00", "Mars/Olympus", "", "Europe/../Lisbon"].map((timeZone) => [{ ...base, source: { kind: "time", schedule: "cron", expression: "0 9 * * *", timeZone } }, "spec.source.timeZone"] as [unknown, string]),
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
			[{ ...base, source: { kind: "time", schedule: "once", at: START }, condition: { when: { op: "exists", path: ["a"] } } }, "spec.condition"],
			[eventSpec({ condition: { when: { op: "changed", path: ["price"] } } }), "spec.condition.when.op"],
			[eventSpec({ condition: { when: { op: "exists", path: ["a"] }, staleAfterMs: 60_000 } }), "spec.condition.staleAfterMs"],
			[eventSpec({ source: { kind: "connector_event", connectorId: "flights", event: "x", arguments: { a: "x".repeat(5_000) } } }), "spec.source.arguments"],
			[{ ...base, source: { kind: "file", path: "/home/ada/../root", events: ["created"] } }, "spec.source.path"],
			[{ ...base, source: { kind: "file", path: "/home/ada", events: ["created", "created"] } }, "spec.source.events"],
			// A process by name can't say which run of it finished: only a handle to one instance, watched for a bounded time.
			[{ ...base, source: { kind: "process", name: "make" } }, "spec.source"],
			[{ ...base, source: { kind: "process", handle: "proc-7" } }, "spec.source.expiresAt"],
			[{ ...base, source: { kind: "process", expiresAt: START } }, "spec.source.handle"],
			[{ ...base, source: { kind: "process", handle: "proc 7", expiresAt: START } }, "spec.source.handle"],
			[{ ...base, source: { kind: "poll", command: "./a.sh", expiresAt: START }, condition: { when: { op: "exists", path: ["a"] } } }, "spec.source"],
			[{ ...eventSpec(), label: "x".repeat(121) }, "spec.label"],
			[{ ...eventSpec(), instruction: "ring\u0007" }, "spec.instruction"],
			[{ ...eventSpec(), destination: { type: "existing_chat" } }, "spec.destination.chatId"],
			[{ ...eventSpec(), destination: { type: "new_chat", chatId: "chat-1" } }, "spec.destination"],
			[pollSpec({ condition: { when: { op: "regex", path: ["a"], value: ".*" } } }), "spec.condition.when.op"],
			[pollSpec({ condition: { when: { op: "eval", value: "1" } } }), "spec.condition.when.op"],
			[pollSpec({ condition: { when: { op: "compare", path: ["a"], cmp: "lt", value: "b" } } }), "spec.condition.when.cmp"],
			[pollSpec({ condition: { when: { op: "compare", path: ["a"], cmp: "eq", value: Number.POSITIVE_INFINITY } } }), "spec.condition.when.value"],
			[pollSpec({ condition: { when: { op: "compare", path: ["a"], cmp: "eq", value: null } } }), "spec.condition.when.value"],
			[pollSpec({ condition: { when: { op: "exists", path: ["__proto__"] } } }), "spec.condition.when.path[0]"],
			[pollSpec({ condition: { when: { op: "all", of: [] } } }), "spec.condition.when.of"],
			[pollSpec({ condition: { when: deep(8) } }), "spec.condition.when.of.of.of.of.of.of.of.of"],
			[pollSpec({ condition: { when: wide } }), "spec.condition.when.of[3].of[11]"],
			[pollSpec({ condition: { when: { op: "stable_for", ms: MINUTE, of: { op: "changed", path: ["a"] } } } }), "spec.condition.when.of.op"],
			[pollSpec({ condition: { when: { op: "hysteresis", path: ["t"], direction: "rising", enter: 30, exit: 30 } } }), "spec.condition.when.exit"],
			[pollSpec({ condition: { when: { op: "hysteresis", path: ["t"], direction: "rising", enter: Number.NaN, exit: 20 } } }), "spec.condition.when.enter"],
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
	const edge = (when: unknown, staleAfterMs?: number): Condition => parseCondition({ when, ...(staleAfterMs ? { staleAfterMs } : {}) }, "edge");

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
			[[T, T], ["true", "true"], ["waiting_for_false", "waiting_for_false"]],
			[[F, T], ["false", "fire"], ["armed", "waiting_for_false"]],
			[[T, U, T], ["true", "unknown", "true"], ["waiting_for_false", "unknown", "waiting_for_false"]],
			[[F, U, T], ["false", "unknown", "true"], ["armed", "unknown", "waiting_for_false"]],
			[[U, F, T], ["unknown", "false", "fire"], ["unknown", "armed", "waiting_for_false"]],
			[[F, T, T, F, T], ["false", "fire", "true", "false", "fire"], ["armed", "waiting_for_false", "waiting_for_false", "armed", "waiting_for_false"]],
		];
		for (const [observations, outcomes, edges] of table) {
			const steps = evaluated(low, observations);
			expect(steps.map((step) => step.outcome), JSON.stringify(observations)).toEqual(outcomes);
			expect(steps.map((step) => step.edge), JSON.stringify(observations)).toEqual(edges);
		}
		// A gap breaks continuity as unknown does: a false after it is needed before a true fires.
		expect(series(low, [F, { gap: T }, T])).toEqual(["false", "true", "true"]);
		expect(series(low, [F, { gap: F }, T])).toEqual(["false", "false", "fire"]);
	});

	it("fires on each change it sees, and starts comparing again after a gap", () => {
		const status = edge({ op: "changed", path: ["status"] });
		// A missing value breaks continuity: the next one is a new baseline, not a change.
		expect(series(status, [{ status: "a" }, { status: "b" }, { status: "c" }, { status: "c" }, {}, { status: "d" }, { status: "e" }])).toEqual([
			"false",
			"fire",
			"fire",
			"false",
			"unknown",
			"false",
			"fire",
		]);
		expect(series(status, [{ status: "a" }, { gap: { status: "b" } }, { status: "b" }, { status: "c" }])).toEqual(["false", "false", "false", "fire"]);
		// A change under `not` is not news of a change.
		const unchanged = edge({ op: "any", of: [{ op: "not", of: { op: "changed", path: ["status"] } }, { op: "exists", path: ["alarm"] }] });
		expect(series(unchanged, [{ status: "a", alarm: 1 }, { status: "b", alarm: 1 }, { status: "c", alarm: 1 }])).toEqual(["true", "true", "true"]);
	});

	it("holds stable_for only through continuous truth, which unknown and a gap break", () => {
		const down = edge({ op: "stable_for", ms: 2 * MINUTE, of: { op: "compare", path: ["up"], cmp: "eq", value: false } });
		expect(series(down, [{ up: true }, { up: false }, { up: false }, { up: false }, { up: false }])).toEqual(["false", "false", "false", "fire", "true"]);
		expect(series(down, [{ up: true }, { up: false }, {}, { up: false }, { up: false }, { up: false }])).toEqual(["false", "false", "unknown", "false", "false", "fire"]);
		expect(series(down, [{ up: true }, { up: false }, { up: false }, { gap: { up: false } }, { up: false }, { up: false }])).toEqual(["false", "false", "false", "false", "false", "fire"]);
		// An unknown result of the whole condition breaks it too, even where `stable_for` itself saw only truth.
		const quietlyDown = edge({ op: "all", of: [down.when, { op: "compare", path: ["load"], cmp: "lt", value: 5 }] });
		const down1 = { up: false, load: 1 };
		expect(series(quietlyDown, [{ up: true, load: 1 }, down1, down1, { up: false }, down1, down1, down1])).toEqual(["false", "false", "false", "unknown", "false", "false", "fire"]);
	});

	it("keeps a hysteresis band from flapping", () => {
		const cheap = edge({ op: "hysteresis", path: ["price"], direction: "falling", enter: 500, exit: 520 });
		expect(series(cheap, [{ price: 510 }, { price: 530 }, { price: 499 }, { price: 510 }, { price: 499 }, { price: 525 }, { price: 510 }, { price: 500 }])).toEqual([
			"unknown",
			"false",
			"fire",
			"true",
			"true",
			"false",
			"false",
			"fire",
		]);
	});

	it("treats an observation older than staleAfterMs as no evidence", () => {
		const low = edge({ op: "compare", path: ["price"], cmp: "lt", value: 500 }, 5 * MINUTE);
		const armed = evaluate(low, "edge", null, { value: { price: 600 }, observedAt: START, gap: false }, START);
		const late = evaluate(low, "edge", armed.state, { value: { price: 400 }, observedAt: START + MINUTE, gap: false }, START + 7 * MINUTE);
		expect(late).toMatchObject({ truth: "unknown", fire: false, stale: true, state: { edge: "unknown" } });
		// It broke continuity, so a fresh true after it waits for a false.
		const fresh = evaluate(low, "edge", late.state, { value: { price: 400 }, observedAt: START + 7 * MINUTE, gap: false }, START + 7 * MINUTE);
		expect(fresh).toMatchObject({ fire: false, state: { edge: "waiting_for_false" } });
	});

	it("evaluates every operand, so state is kept even where the result was already decided", () => {
		const either = edge({ op: "any", of: [{ op: "exists", path: ["alarm"] }, { op: "changed", path: ["n"] }] });
		// Both results are decided by `alarm`, yet `changed` sees both values, so the second is a change.
		expect(series(either, [{ alarm: 1, n: 1 }, { alarm: 1, n: 2 }])).toEqual(["true", "fire"]);
	});
});

describe("trigger store", () => {
	it("keeps each revision as it was, and changes a trigger only at the revision it expects", async () => {
		await withStore(({ store, clock, sql }) => {
			expect(created(store, pollSpec(), "draft", "price")).toMatchObject({ id: "price", revision: 1, lifecycle: "draft", health: "unknown", generation: 1 });
			clock.now += 1_000;
			expect(store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ label: "Lower" }) })).toMatchObject({ ok: false, reason: "revision_mismatch" });
			expect(count(sql, "pim_trigger_revisions")).toBe(1);
			// A new label alone is a new revision, not a new generation.
			expect(store.update({ id: "price", expectedRevision: 1, spec: pollSpec({ label: "Lower" }) })).toMatchObject({ ok: true, trigger: { revision: 2, generation: 1, spec: { label: "Lower" } } });
			expect(store.revision("price", 1)?.label).toBe("Watch");
			expect(store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ label: "Lower" }) })).toMatchObject({ ok: true, trigger: { revision: 2 } });
			expect(store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ owningAgentId: "agent-2" }) })).toMatchObject({ ok: false, reason: "immutable_field" });
			expect(store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ originChatId: "chat-2" }) })).toMatchObject({ ok: false, reason: "immutable_field" });
			expect(() => sql.exec("UPDATE pim_trigger_revisions SET spec = '{}' WHERE trigger_id = 'price'")).toThrow(/immutable/);
			expect(store.revision("price", 1)?.label).toBe("Watch");
			expect(store.update({ id: "missing", expectedRevision: 1, spec: pollSpec() })).toMatchObject({ ok: false, reason: "not_found" });
			expect(store.create({ id: "price", spec: pollSpec() })).toMatchObject({ ok: false, reason: "exists" });
		});
	});

	it("enables a computer source only when the host accepts its grant for exactly that source", async () => {
		await withStore(({ make, clock }) => {
			// The host's grants: each for one source, until it expires.
			const priceSource = parseTriggerSpec(pollSpec()).source;
			const grants: Record<string, { source: unknown; expiresAt: number }> = {
				"grant-price": { source: priceSource, expiresAt: START + DAY },
				"grant-expired": { source: priceSource, expiresAt: START - 1 },
				"grant-other": { source: parseTriggerSpec(pollSpec({ source: { kind: "poll", command: "./other.sh" } })).source, expiresAt: START + DAY },
				"grant-hourly": { source: parseTriggerSpec(pollSpec({ source: { kind: "poll", command: "./price.sh", intervalMs: HOUR } })).source, expiresAt: START + DAY },
			};
			const checked: string[] = [];
			const store = make({
				authorize: ({ spec, authorizationRef, now }) => {
					checked.push(authorizationRef);
					const grant = grants[authorizationRef];
					if (!grant) return { ok: false, reason: "no such grant" };
					if (now >= grant.expiresAt) return { ok: false, reason: "expired" };
					if (JSON.stringify(grant.source) !== JSON.stringify(spec.source)) return { ok: false, reason: "granted for another source" };
					return { ok: true };
				},
			});
			expect(store.create({ spec: pollSpec({ authorizationRef: null }), lifecycle: "enabled" })).toMatchObject({ ok: false, reason: "authorization_required" });
			expect(store.create({ spec: pollSpec({ authorizationRef: "grant-made-up" }), lifecycle: "enabled" })).toMatchObject({ ok: false, reason: "authorization_denied", detail: "no such grant" });
			expect(store.create({ spec: pollSpec({ authorizationRef: "grant-expired" }), lifecycle: "enabled" })).toMatchObject({ ok: false, reason: "authorization_denied", detail: "expired" });
			expect(store.create({ spec: pollSpec({ authorizationRef: "grant-other" }), lifecycle: "enabled" })).toMatchObject({ ok: false, reason: "authorization_denied", detail: "granted for another source" });
			const trigger = created(store, pollSpec({ authorizationRef: "grant-price" }), "enabled");
			// A new interval is a new source: the old grant no longer counts, and a new one must be accepted.
			const hourly = pollSpec({ source: { kind: "poll", command: "./price.sh", intervalMs: HOUR } });
			expect(store.update({ id: trigger.id, expectedRevision: 1, spec: { ...hourly, authorizationRef: "grant-price" } })).toMatchObject({ ok: false, reason: "authorization_required" });
			expect(store.update({ id: trigger.id, expectedRevision: 1, spec: { ...hourly, authorizationRef: null } })).toMatchObject({ ok: false, reason: "authorization_required" });
			expect(store.update({ id: trigger.id, expectedRevision: 1, spec: { ...hourly, authorizationRef: "grant-other" } })).toMatchObject({ ok: false, reason: "authorization_denied" });
			expect(store.update({ id: trigger.id, expectedRevision: 1, spec: { ...hourly, authorizationRef: "grant-hourly" } })).toMatchObject({ ok: true, trigger: { revision: 2 } });
			// Enabling again checks the grant again: one that expired meanwhile is refused.
			store.setLifecycle({ id: trigger.id, to: "paused" });
			clock.now = START + DAY;
			expect(store.setLifecycle({ id: trigger.id, to: "enabled", expectedRevision: 2 })).toMatchObject({ ok: false, reason: "authorization_denied", detail: "expired" });
			// A connector's events don't run on the computer: the host isn't asked.
			const asked = checked.length;
			expect(store.create({ spec: eventSpec(), lifecycle: "enabled" })).toMatchObject({ ok: true });
			expect(checked.length).toBe(asked);
			// With no check configured, no reference is taken on trust.
			const unchecked = make({ authorize: undefined });
			expect(unchecked.create({ spec: pollSpec({ authorizationRef: "approval-1" }), lifecycle: "enabled" })).toMatchObject({ ok: false, reason: "authorization_denied" });
		});
	});

	it("takes each event once per source, and writes all of an admission or none of it", async () => {
		await withStore(({ store, clock, sql, make, transaction }) => {
			created(store, eventSpec(), "enabled", "flights");
			const first = store.admit({ id: "flights", generation: 1, eventId: "evt-1", observedAt: START, payload: { price: 450 } });
			expect(first).toMatchObject({ status: "accepted", truth: "true", occurrence: { key: "event:flights#1:evt-1", revision: 1, status: "pending", evidence: { reason: "event", truth: "true", observedAt: START, fields: [] } } });
			expect(store.admit({ id: "flights", generation: 1, eventId: "evt-1", observedAt: START, payload: { price: 450 } })).toEqual({ status: "duplicate" });
			expect([count(sql, "pim_trigger_inbox"), count(sql, "pim_trigger_occurrences"), count(sql, "pim_trigger_outbox")]).toEqual([1, 1, 1]);

			// The outbox item's id is the second id an admission makes: failing there must undo the occurrence before it.
			let ids = 0;
			const failing = make({
				newId: () => {
					ids += 1;
					if (ids === 2) throw new Error("disk full");
					return crypto.randomUUID();
				},
			});
			clock.now += 1_000;
			const second = { id: "flights", generation: 1, eventId: "evt-2", observedAt: clock.now, payload: {}, checkpoint: { position: 2, cursor: "c2" } };
			expect(() => failing.admit(second)).toThrow("disk full");
			// A crash after all of an admission's writes, before its transaction commits, keeps none of them.
			const crashing = make({
				transaction: (work) =>
					transaction(() => {
						work();
						throw new Error("crash before commit");
					}),
			});
			expect(() => crashing.admit(second)).toThrow("crash before commit");
			expect(() => crashing.claim({ leaseMs: MINUTE })).toThrow("crash before commit");
			expect([count(sql, "pim_trigger_inbox"), count(sql, "pim_trigger_occurrences"), count(sql, "pim_trigger_outbox")]).toEqual([1, 1, 1]);
			expect(store.sourceState("flights")).toMatchObject({ position: null, cursor: null, lastObservedAt: START });
			expect(store.outbox("flights")).toMatchObject([{ status: "pending", attempts: 0 }]);
			// So the source's retry is taken in whole.
			expect(store.admit(second)).toMatchObject({ status: "accepted" });
			expect(store.sourceState("flights")).toMatchObject({ position: 2, cursor: "c2", identity: "flights#1" });
			expect(() => store.admit({ id: "flights", generation: 1, eventId: "x".repeat(257), observedAt: START, payload: {} })).toThrow(TriggerValidationError);
			expect(() => store.admit({ id: "flights", generation: 1, eventId: "evt-3", observedAt: clock.now + 10 * MINUTE, payload: {} })).toThrow(TriggerValidationError);
			expect(() => store.admit({ id: "flights", generation: 1, eventId: "evt-3", observedAt: START, payload: { big: "x".repeat(17_000) } })).toThrow(TriggerValidationError);
		});
	});

	it("keeps no observed value or event body, only why an occurrence fired and which fields it found", async () => {
		await withStore(({ store, clock, sql }) => {
			const secret = "RAW_SECRET";
			created(store, eventSpec({ condition: { when: { op: "compare", path: ["kind"], cmp: "eq", value: "invoice" } } }), "enabled", "mail");
			expect(store.admit({ id: "mail", generation: 1, eventId: "m1", observedAt: START, payload: { kind: "invoice", body: `${secret} body`, from: `${secret}@example.test` } })).toMatchObject({
				occurrence: { evidence: { reason: "condition", truth: "true", observedAt: START, fields: [{ path: ["kind"], present: true }] } },
			});
			// Filtered out, and a duplicate: neither leaves the body anywhere.
			store.admit({ id: "mail", generation: 1, eventId: "m2", observedAt: START, payload: { kind: "note", body: secret } });
			store.admit({ id: "mail", generation: 1, eventId: "m1", observedAt: START, payload: { kind: "invoice", body: secret } });
			const state = pollSpec({ condition: { when: { op: "any", of: [{ op: "changed", path: ["token"] }, { op: "compare", path: ["price"], cmp: "lt", value: 500 }] } } });
			created(store, state, "enabled", "price");
			for (const [index, payload] of [{ token: `${secret}-1`, price: 600 }, { token: `${secret}-2`, price: 600 }, { token: `${secret}-2`, price: 400, note: secret }].entries()) {
				clock.now = START + (index + 1) * MINUTE;
				store.admit({ id: "price", generation: 1, eventId: `p${index}`, observedAt: clock.now, payload });
			}
			expect(store.occurrences("price")).toHaveLength(1);
			const delivery = store.claim({ leaseMs: MINUTE })!;
			store.fail({ outboxId: delivery.item.id, attempt: delivery.attempt, retryAt: clock.now, error: "busy" });
			// What `changed` remembers is a digest of the last value, not the value.
			expect(store.sourceState("price")?.conditionState?.nodes).toEqual([{ op: "changed", digest: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
			const everything = TRIGGER_TABLES.map((table) => JSON.stringify(sql.exec(`SELECT * FROM ${table}`).toArray())).join("\n");
			expect(everything).toContain("invoice");
			expect(everything).not.toContain(secret);
		});
	});

	it("refuses observations from a stale generation, a paused trigger or a deleted one", async () => {
		await withStore(({ store, clock }) => {
			created(store, eventSpec(), "enabled", "flights");
			const admit = (generation: number, eventId: string) => store.admit({ id: "flights", generation, eventId, observedAt: clock.now, payload: {} });
			expect(admit(1, "a")).toMatchObject({ status: "accepted" });
			expect(store.setLifecycle({ id: "flights", to: "paused" })).toMatchObject({ ok: true, trigger: { lifecycle: "paused", generation: 2 } });
			expect(admit(1, "b")).toEqual({ status: "stale_generation" });
			expect(admit(2, "b")).toEqual({ status: "not_enabled" });
			expect(store.setHealth({ id: "flights", generation: 1, health: "healthy" })).toEqual({ ok: false });
			expect(store.setLifecycle({ id: "flights", to: "enabled", expectedRevision: 7 })).toMatchObject({ ok: false, reason: "revision_mismatch" });
			expect(store.setLifecycle({ id: "flights", to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: true, trigger: { generation: 3 } });
			expect(admit(2, "b")).toEqual({ status: "stale_generation" });
			expect(admit(3, "b")).toMatchObject({ status: "accepted" });
			expect(store.setHealth({ id: "flights", generation: 3, health: "healthy" })).toEqual({ ok: true });
			expect(store.remove({ id: "flights" })).toEqual({ ok: true });
			expect(admit(3, "c")).toEqual({ status: "deleted" });
			expect(admit(4, "c")).toEqual({ status: "deleted" });
			expect(store.setHealth({ id: "flights", generation: 4, health: "healthy" })).toEqual({ ok: false });
			expect(store.recordGap({ id: "flights", generation: 4 })).toEqual({ ok: false });
			expect(store.create({ id: "flights", spec: eventSpec() })).toMatchObject({ ok: false, reason: "deleted" });
			expect(store.setLifecycle({ id: "flights", to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: false, reason: "deleted" });
			expect(store.update({ id: "flights", expectedRevision: 1, spec: eventSpec({ label: "Again" }) })).toMatchObject({ ok: false, reason: "deleted" });
		});
	});

	it("deletes a trigger by stopping it and cancelling what it hadn't handed on, keeping its record until the space is erased", async () => {
		await withStore(({ store, clock, sql }) => {
			created(store, eventSpec({ instruction: "First" }), "enabled", "flights");
			for (const eventId of ["a", "b", "c"]) store.admit({ id: "flights", generation: 1, eventId, observedAt: START, payload: {} });
			const done = store.claim({ leaseMs: MINUTE })!;
			store.complete({ outboxId: done.item.id, attempt: done.attempt });
			const underWay = store.claim({ leaseMs: MINUTE })!;
			store.update({ id: "flights", expectedRevision: 1, spec: eventSpec({ instruction: "Second" }) });
			clock.now += 1_000;
			expect(store.remove({ id: "flights", expectedRevision: 1 })).toMatchObject({ ok: false, reason: "revision_mismatch" });
			expect(store.remove({ id: "flights", expectedRevision: 2 })).toEqual({ ok: true });
			// The attempt under way can't settle it, and nothing more is claimed.
			expect(store.complete({ outboxId: underWay.item.id, attempt: underWay.attempt })).toEqual({ ok: false });
			expect(store.fail({ outboxId: underWay.item.id, attempt: underWay.attempt, retryAt: clock.now, error: "x" })).toMatchObject({ ok: false });
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();
			// What it did stays: its revisions, its occurrences and how each ended.
			expect(store.get("flights")).toMatchObject({ lifecycle: "deleted", revision: 2, spec: { instruction: "Second" } });
			expect(store.list()).toEqual([]);
			expect(store.revision("flights", 1)?.instruction).toBe("First");
			expect(store.occurrences("flights").map((occurrence) => occurrence.status)).toEqual(["delivered", "cancelled", "cancelled"]);
			expect(store.outbox("flights").map((item) => item.status)).toEqual(["done", "cancelled", "cancelled"]);
			expect([count(sql, "pim_trigger_sources"), count(sql, "pim_trigger_inbox"), count(sql, "pim_trigger_tombstones")]).toEqual([0, 0, 1]);
			// Erasing the space is what removes it all.
			created(store, eventSpec(), "enabled", "trains");
			store.eraseAll();
			expect(TRIGGER_TABLES.map((table) => count(sql, table))).toEqual([0, 0, 0, 0, 0, 0, 0]);
		});
	});

	it("moves the checkpoint only forward, refuses an older state, and takes events in any order", async () => {
		await withStore(({ store }) => {
			created(store, pollSpec(), "enabled", "price");
			const poll = (eventId: string, observedAt: number, price: number, position: number) =>
				store.admit({ id: "price", generation: 1, eventId, observedAt, payload: { price }, checkpoint: { position, cursor: `p${position}` } });
			expect(poll("p-2", START - 2_000, 600, 2)).toMatchObject({ status: "accepted", truth: "false" });
			expect(poll("p-1", START - 3_000, 400, 1)).toEqual({ status: "out_of_order" });
			expect(poll("p-2b", START - 2_000, 400, 3)).toEqual({ status: "out_of_order" });
			expect(store.sourceState("price")).toMatchObject({ position: 2, cursor: "p2", lastObservedAt: START - 2_000 });
			expect(poll("p-3", START - 1_000, 400, 3)).toMatchObject({ status: "accepted", truth: "true", occurrence: { key: "event:price#1:p-3" } });

			created(store, eventSpec(), "enabled", "flights");
			const event = (eventId: string, observedAt: number, position: number) => store.admit({ id: "flights", generation: 1, eventId, observedAt, payload: {}, checkpoint: { position, cursor: `c${position}` } });
			expect(event("e5", START, 5)).toMatchObject({ status: "accepted" });
			expect(event("e3", START - 5_000, 3)).toMatchObject({ status: "accepted", occurrence: { key: "event:flights#1:e3" } });
			expect(store.sourceState("flights")).toMatchObject({ position: 5, cursor: "c5", lastObservedAt: START });
			expect(event("e3", START - 5_000, 3)).toEqual({ status: "duplicate" });
		});
	});

	it("takes an event id again from a changed source, which starts with a new identity and checkpoint", async () => {
		await withStore(({ store, sql, make, transaction }) => {
			created(store, eventSpec(), "enabled", "flights");
			const fired = store.admit({ id: "flights", generation: 1, eventId: "1", observedAt: START, payload: {}, checkpoint: { position: 7, cursor: "c7" } });
			expect(fired).toMatchObject({ status: "accepted", occurrence: { key: "event:flights#1:1" } });
			expect(store.update({ id: "flights", expectedRevision: 1, spec: eventSpec({ source: { kind: "connector_event", connectorId: "flights", event: "price.dropped" } }) })).toMatchObject({
				ok: true,
				trigger: { revision: 2, generation: 2 },
			});
			expect(store.sourceState("flights")).toMatchObject({ identity: "flights#2", position: null, cursor: null });
			expect(store.admit({ id: "flights", generation: 1, eventId: "1", observedAt: START, payload: {} })).toEqual({ status: "stale_generation" });
			const again = { id: "flights", generation: 2, eventId: "1", observedAt: START, payload: {}, checkpoint: { position: 1, cursor: "n1" } };
			const crashing = make({
				transaction: (work) =>
					transaction(() => {
						work();
						throw new Error("crash before commit");
					}),
			});
			expect(() => crashing.admit(again)).toThrow("crash before commit");
			expect([count(sql, "pim_trigger_inbox"), count(sql, "pim_trigger_occurrences")]).toEqual([1, 1]);
			expect(store.admit(again)).toMatchObject({ status: "accepted", occurrence: { key: "event:flights#2:1", revision: 2 } });
			expect(store.sourceState("flights")).toMatchObject({ position: 1, cursor: "n1" });
			expect(store.admit(again)).toEqual({ status: "duplicate" });
			expect(store.occurrences("flights").map((occurrence) => occurrence.key)).toEqual(["event:flights#1:1", "event:flights#2:1"]);
		});
	});

	it("fences out observations made under an older condition or source, and starts the condition over", async () => {
		await withStore(({ store, clock }) => {
			created(store, pollSpec(), "enabled", "price");
			const poll = (generation: number, price: number) => {
				clock.now += MINUTE;
				return store.admit({ id: "price", generation, eventId: `o${clock.now}`, observedAt: clock.now, payload: { price } });
			};
			expect(poll(1, 600)).toMatchObject({ status: "accepted", truth: "false" });
			expect(store.sourceState("price")).toMatchObject({ conditionState: { edge: "armed" } });
			// An observer made its observation under `lt 500`; the condition becomes `lt 450` before it arrives.
			store.update({ id: "price", expectedRevision: 1, spec: pollSpec({ condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 450 } } }) });
			expect(store.get("price")).toMatchObject({ revision: 2, generation: 2 });
			expect(store.sourceState("price")).toMatchObject({ identity: "price#1", conditionState: null });
			expect(poll(1, 470)).toEqual({ status: "stale_generation" });
			// Under the new condition, a true is a baseline: it fires only after a known false.
			expect(poll(2, 400)).toMatchObject({ status: "accepted", truth: "true", occurrence: null });
			expect(poll(2, 460)).toMatchObject({ truth: "false" });
			// The source changes as a condition edit is being admitted: the edit's generation is fenced out too.
			store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ source: { kind: "poll", command: "./other.sh" }, authorizationRef: "approval-2", condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 450 } } }) });
			expect(store.get("price")).toMatchObject({ revision: 3, generation: 3 });
			expect(poll(2, 400)).toEqual({ status: "stale_generation" });
			expect(poll(3, 400)).toMatchObject({ truth: "true", occurrence: null });
			// A change of label or instruction leaves observers and the condition as they were.
			store.update({ id: "price", expectedRevision: 3, spec: pollSpec({ label: "Renamed", source: { kind: "poll", command: "./other.sh" }, authorizationRef: "approval-2", condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 450 } } }) });
			expect(store.get("price")).toMatchObject({ revision: 4, generation: 3 });
			expect(poll(3, 460)).toMatchObject({ truth: "false" });
			expect(poll(3, 400)).toMatchObject({ occurrence: { revision: 4 } });
		});
	});

	it("treats a pause as a break: enabled again, a trigger needs a known false before a true fires", async () => {
		await withStore(({ store, clock }) => {
			created(store, pollSpec(), "enabled", "price");
			const stable = { when: { op: "stable_for", ms: 2 * MINUTE, of: { op: "compare", path: ["up"], cmp: "eq", value: false } } };
			created(store, pollSpec({ source: { kind: "poll", command: "./up.sh", intervalMs: MINUTE }, condition: stable }), "enabled", "site");
			const observe = (id: string, payload: JsonValue) => {
				const trigger = store.get(id)!;
				return store.admit({ id, generation: trigger.generation, eventId: `${id}-${clock.now}`, observedAt: clock.now, payload });
			};
			const outcome = (id: string, payload: JsonValue) => {
				const result = observe(id, payload);
				return result.status !== "accepted" ? result.status : result.occurrence ? "fire" : result.truth;
			};
			const pauseAndResume = (id: string) => {
				store.setLifecycle({ id, to: "paused" });
				store.setLifecycle({ id, to: "enabled", expectedRevision: 1 });
			};
			const steps: string[] = [];
			const tick = (id: string, payload: JsonValue) => {
				clock.now += MINUTE;
				steps.push(outcome(id, payload));
			};
			// false, pause, true: silent. Then false, true: fires.
			tick("price", { price: 600 });
			pauseAndResume("price");
			expect(store.sourceState("price")).toMatchObject({ conditionState: null, gapPending: false });
			tick("price", { price: 400 });
			tick("price", { price: 600 });
			tick("price", { price: 400 });
			expect(steps).toEqual(["false", "true", "false", "fire"]);
			// A recorded gap pending at the pause is taken up by the fresh start, not carried over.
			store.recordGap({ id: "price", generation: store.get("price")!.generation });
			pauseAndResume("price");
			expect(store.sourceState("price")?.gapPending).toBe(false);
			// stable_for counts again after a resume: down at 1 and 2 minutes, paused, then it needs 2 more minutes seen down.
			steps.length = 0;
			tick("site", { up: true });
			tick("site", { up: false });
			tick("site", { up: false });
			pauseAndResume("site");
			tick("site", { up: false });
			tick("site", { up: false });
			tick("site", { up: false });
			expect(steps).toEqual(["false", "false", "false", "false", "false", "fire"]);
		});
	});

	it("delivers each occurrence with the revision it happened under, which never changes", async () => {
		await withStore(({ store, sql }) => {
			created(store, eventSpec({ instruction: "First instruction" }), "enabled", "flights");
			store.admit({ id: "flights", generation: 1, eventId: "a", observedAt: START, payload: {} });
			store.update({ id: "flights", expectedRevision: 1, spec: eventSpec({ instruction: "Second instruction" }) });
			store.admit({ id: "flights", generation: 1, eventId: "b", observedAt: START, payload: {} });
			expect(store.occurrences("flights").map((occurrence) => occurrence.revision)).toEqual([1, 2]);
			const first = store.claim({ leaseMs: MINUTE })!;
			expect(first).toMatchObject({ occurrence: { key: "event:flights#1:a", revision: 1 }, spec: { instruction: "First instruction" } });
			expect(() => sql.exec("UPDATE pim_trigger_occurrences SET revision = 2 WHERE trigger_id = 'flights'")).toThrow(/keeps its revision/);
			store.complete({ outboxId: first.item.id, attempt: first.attempt });
			expect(store.claim({ leaseMs: MINUTE })).toMatchObject({ occurrence: { key: "event:flights#1:b", revision: 2 }, spec: { instruction: "Second instruction" } });
		});
	});

	it("retries under the same operation id, lets only the latest attempt settle, and stops at an unknown outcome", async () => {
		await withStore(({ store, clock }) => {
			created(store, eventSpec(), "enabled", "flights");
			store.admit({ id: "flights", generation: 1, eventId: "a", observedAt: START, payload: {} });
			const first = store.claim({ leaseMs: MINUTE })!;
			expect(first).toMatchObject({ attempt: 1, item: { status: "leased", operationId: `trigger:flights:${first.occurrence.id}` } });
			expect(store.fail({ outboxId: first.item.id, attempt: 1, retryAt: clock.now + 10_000, error: "busy" })).toEqual({ ok: true, retrying: true });
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();
			clock.now += 10_000;
			const second = store.claim({ leaseMs: MINUTE })!;
			expect(second).toMatchObject({ attempt: 2, item: { operationId: first.item.operationId, lastError: "busy" } });
			clock.now += MINUTE;
			const third = store.claim({ leaseMs: MINUTE })!;
			expect(third).toMatchObject({ attempt: 3, item: { operationId: first.item.operationId } });
			expect(store.complete({ outboxId: second.item.id, attempt: 2 })).toEqual({ ok: false });
			expect(store.complete({ outboxId: third.item.id, attempt: 3 })).toEqual({ ok: true });
			expect(store.occurrences("flights")[0]?.status).toBe("delivered");
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();

			// Failures known not to have handed it on use up the attempts, and it fails.
			store.admit({ id: "flights", generation: 1, eventId: "b", observedAt: START, payload: {} });
			for (let attempt = 1; attempt <= 5; attempt += 1) {
				const delivery = store.claim({ leaseMs: MINUTE })!;
				expect(delivery.attempt).toBe(attempt);
				expect(store.fail({ outboxId: delivery.item.id, attempt, retryAt: clock.now, error: "down" })).toEqual({ ok: true, retrying: attempt < 5 });
			}
			expect(store.occurrences("flights")[1]?.status).toBe("failed");

			// Leases that run out say nothing of whether it was handed on: after five, its outcome is unknown, and it isn't tried again.
			store.admit({ id: "flights", generation: 1, eventId: "c", observedAt: START, payload: {} });
			store.admit({ id: "flights", generation: 1, eventId: "d", observedAt: START, payload: {} });
			const attempts: number[] = [];
			for (let claims = 0; claims < 5; claims += 1) {
				attempts.push(store.claim({ leaseMs: MINUTE })!.attempt);
				clock.now += MINUTE;
			}
			expect(attempts).toEqual([1, 2, 3, 4, 5]);
			// The next claim settles `c` as unknown and moves on to `d`.
			expect(store.claim({ leaseMs: MINUTE })?.occurrence.key).toBe("event:flights#1:d");
			const unknown = store.outbox("flights")[2]!;
			expect(unknown).toMatchObject({ status: "outcome_unknown", attempts: 5 });
			expect(store.occurrences("flights")[2]?.status).toBe("outcome_unknown");
			expect(store.reconcile({ outboxId: store.outbox("flights")[3]!.id, outcome: "delivered" })).toEqual({ ok: false });
			expect(store.reconcile({ outboxId: unknown.id, outcome: "delivered" })).toEqual({ ok: true });
			expect(store.occurrences("flights")[2]?.status).toBe("delivered");
			expect(store.reconcile({ outboxId: unknown.id, outcome: "failed" })).toEqual({ ok: false });
		});
	});

	it("hands on one occurrence per trigger at a time, in order, and holds back events past its bound", async () => {
		await withStore(({ store }) => {
			created(store, eventSpec({ delivery: { maxPendingEvents: 2 } }), "enabled", "flights");
			created(store, eventSpec(), "enabled", "trains");
			const admit = (id: string, eventId: string) => store.admit({ id, generation: store.get(id)!.generation, eventId, observedAt: START, payload: { eventId } });
			expect(admit("flights", "a")).toMatchObject({ status: "accepted" });
			expect(admit("flights", "b")).toMatchObject({ status: "accepted" });
			expect(admit("flights", "c")).toEqual({ status: "backpressure" });
			expect(store.outbox("flights")).toHaveLength(2);
			const first = store.claim({ leaseMs: MINUTE })!;
			expect(first.occurrence.key).toBe("event:flights#1:a");
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();
			admit("trains", "t");
			expect(store.claim({ leaseMs: MINUTE })?.occurrence.key).toBe("event:trains#1:t");
			expect(admit("flights", "c")).toMatchObject({ status: "accepted" });
			store.complete({ outboxId: first.item.id, attempt: first.attempt });
			const second = store.claim({ leaseMs: MINUTE })!;
			expect(second.occurrence.key).toBe("event:flights#1:b");
			store.complete({ outboxId: second.item.id, attempt: second.attempt });
			// Paused, its occurrences wait; enabled again, they go on.
			store.setLifecycle({ id: "flights", to: "paused" });
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();
			store.setLifecycle({ id: "flights", to: "enabled", expectedRevision: 1 });
			expect(store.claim({ leaseMs: MINUTE })?.occurrence.key).toBe("event:flights#1:c");
			expect(store.occurrences("flights").map((occurrence) => occurrence.status)).toEqual(["delivered", "delivered", "pending"]);
		});
	});

	it("keeps one pending snapshot of a state, superseding an older undelivered one", async () => {
		await withStore(({ store, clock }) => {
			created(store, pollSpec(), "enabled", "price");
			const poll = (price: number) => {
				clock.now += MINUTE;
				return store.admit({ id: "price", generation: 1, eventId: `obs-${clock.now}`, observedAt: clock.now, payload: { price } });
			};
			poll(600);
			const first = poll(400);
			expect(first).toMatchObject({ status: "accepted", occurrence: { evidence: { reason: "condition", truth: "true", observedAt: clock.now, fields: [{ path: ["price"], present: true }] } } });
			poll(600);
			const second = poll(300);
			expect(second).toMatchObject({ status: "accepted", superseded: [first.status === "accepted" ? first.occurrence?.id : ""] });
			expect(store.occurrences("price").map((occurrence) => occurrence.status)).toEqual(["superseded", "pending"]);
			const delivery = store.claim({ leaseMs: MINUTE })!;
			poll(600);
			expect(poll(200)).toMatchObject({ status: "accepted", superseded: [] });
			expect(store.occurrences("price").map((occurrence) => occurrence.status)).toEqual(["superseded", "pending", "pending"]);
			expect(delivery.occurrence.status).toBe("pending");
		});
	});

	it("resets a condition's continuity after a recorded gap, and counts a stale observation as one", async () => {
		await withStore(({ store, clock }) => {
			const stable = { when: { op: "stable_for", ms: 2 * MINUTE, of: { op: "compare", path: ["up"], cmp: "eq", value: false } } };
			created(store, pollSpec({ source: { kind: "poll", command: "./up.sh", intervalMs: MINUTE }, condition: stable }), "enabled", "site");
			const poll = (offset: number, up: boolean) => {
				clock.now = START + offset;
				return store.admit({ id: "site", generation: 1, eventId: `o${offset}`, observedAt: START + offset, payload: { up } });
			};
			expect(poll(0, true)).toMatchObject({ truth: "false" });
			poll(MINUTE, false);
			store.recordGap({ id: "site", generation: 1 });
			expect(store.sourceState("site")?.gapPending).toBe(true);
			expect(poll(3 * MINUTE, false)).toMatchObject({ truth: "false", occurrence: null });
			expect(store.sourceState("site")?.gapPending).toBe(false);
			expect(poll(5 * MINUTE, false)).toMatchObject({ truth: "true", occurrence: { key: `event:site#1:o${5 * MINUTE}` } });
			clock.now = START + 9 * MINUTE;
			expect(store.admit({ id: "site", generation: 1, eventId: "late", observedAt: START + 6 * MINUTE, payload: { up: true } })).toMatchObject({ truth: "unknown", stale: true, occurrence: null });
			expect(store.sourceState("site")?.gapPending).toBe(true);
			expect(store.recordGap({ id: "site", generation: 0 })).toEqual({ ok: false });
		});
	});

	it("remembers event ids for the whole replay horizon, refusing older events and more ids than it can hold", async () => {
		await withStore(({ make, clock, sql }) => {
			expect(() => make({ retention: { dedupHorizonMs: DAY } })).toThrow(TriggerValidationError);
			const store = make({ retention: { inboxCap: 3, occurrences: 1 } });
			const filtered = eventSpec({ condition: { when: { op: "compare", path: ["kind"], cmp: "eq", value: "invoice" } } });
			created(store, filtered, "enabled", "mail");
			const admit = (eventId: string, observedAt: number, kind = "invoice") => store.admit({ id: "mail", generation: 1, eventId, observedAt, payload: { kind } });
			for (const eventId of ["a", "b"]) {
				expect(admit(eventId, START)).toMatchObject({ status: "accepted" });
				const delivery = store.claim({ leaseMs: MINUTE })!;
				store.complete({ outboxId: delivery.item.id, attempt: delivery.attempt });
			}
			// A filtered event's id is remembered too.
			expect(admit("note", START, "note")).toMatchObject({ status: "accepted", occurrence: null });
			// Full: a new id is refused, without forgetting an old one, and writes nothing.
			expect(admit("c", START)).toEqual({ status: "inbox_full" });
			expect(count(sql, "pim_trigger_inbox")).toBe(3);
			// Six days on, every id is still a duplicate, filtered or not; settled occurrences within the horizon are all kept.
			clock.now = START + 6 * DAY;
			expect(admit("a", START)).toEqual({ status: "duplicate" });
			expect(admit("note", START, "invoice")).toEqual({ status: "duplicate" });
			expect(admit("c", START)).toEqual({ status: "inbox_full" });
			expect(store.occurrences("mail")).toHaveLength(2);
			// Past the horizon, the ids are forgotten, and an event that old is refused rather than taken again.
			clock.now = START + 7 * DAY + 6 * MINUTE;
			expect(admit("a", START)).toEqual({ status: "too_old" });
			expect(admit("c", clock.now)).toMatchObject({ status: "accepted" });
			expect(sql.exec("SELECT event_id FROM pim_trigger_inbox ORDER BY rowid").toArray().map((row) => row.event_id)).toEqual(["c"]);
			// Old settled occurrences beyond the history kept go; the pending one stays.
			expect(store.occurrences("mail").map((occurrence) => [occurrence.key, occurrence.status])).toEqual([
				["event:mail#1:b", "delivered"],
				["event:mail#1:c", "pending"],
			]);
		});
	});

	it("watches one process instance until it exits or the watch expires", async () => {
		await withStore(({ store, clock }) => {
			expect(() => store.create({ spec: { ...base, source: { kind: "process", handle: "proc-1", expiresAt: START - 1 } } })).toThrow(TriggerValidationError);
			expect(() => store.create({ spec: { ...base, source: { kind: "process", handle: "proc-1", expiresAt: START + 8 * DAY } } })).toThrow(TriggerValidationError);
			const failed = { ...base, source: { kind: "process", handle: "proc-1", expiresAt: START + HOUR }, condition: { when: { op: "compare", path: ["exitCode"], cmp: "ne", value: 0 } }, authorizationRef: "approval-1" };
			expect(store.create({ spec: { ...failed, authorizationRef: null }, lifecycle: "enabled" })).toMatchObject({ ok: false, reason: "authorization_required" });
			created(store, failed, "enabled", "build");
			expect(store.admit({ id: "build", generation: 1, eventId: "exit", observedAt: START, payload: { exitCode: 2, signal: null } })).toMatchObject({ status: "accepted", occurrence: { key: "event:build#1:exit" } });
			// It exits once: the trigger ends, and still hands on its occurrence.
			expect(store.get("build")).toMatchObject({ lifecycle: "ended", generation: 2 });
			expect(store.claim({ leaseMs: MINUTE })?.occurrence.key).toBe("event:build#1:exit");

			created(store, { ...failed, source: { kind: "process", handle: "proc-2", expiresAt: START + HOUR } }, "enabled", "clean");
			expect(store.admit({ id: "clean", generation: 1, eventId: "exit", observedAt: START, payload: { exitCode: 0, signal: null } })).toMatchObject({ status: "accepted", occurrence: null });
			expect(store.get("clean")?.lifecycle).toBe("ended");

			created(store, { ...failed, source: { kind: "process", handle: "proc-3", expiresAt: START + HOUR } }, "enabled", "late");
			clock.now = START + HOUR + 1;
			expect(store.admit({ id: "late", generation: 1, eventId: "exit", observedAt: clock.now, payload: { exitCode: 1, signal: null } })).toEqual({ status: "expired" });
		});
	});

	it("runs a time firing once, misses one too late, and ends a one-time trigger with it", async () => {
		await withStore(({ store, clock }) => {
			created(store, { ...base, source: { kind: "time", schedule: "once", at: START + MINUTE } }, "enabled", "remind");
			expect(store.admitTimeFiring({ id: "remind", generation: 1, scheduledFor: START + MINUTE })).toEqual({ status: "not_due" });
			expect(store.admitTimeFiring({ id: "remind", generation: 1, scheduledFor: START })).toEqual({ status: "schedule_mismatch" });
			expect(store.admit({ id: "remind", generation: 1, eventId: "x", observedAt: START, payload: {} })).toEqual({ status: "wrong_source" });
			clock.now = START + 2 * MINUTE;
			expect(store.admitTimeFiring({ id: "remind", generation: 1, scheduledFor: START + MINUTE })).toMatchObject({
				status: "accepted",
				occurrence: { key: `time:${START + MINUTE}`, status: "pending", evidence: { reason: "time", scheduledFor: START + MINUTE } },
			});
			expect(store.get("remind")).toMatchObject({ lifecycle: "ended", generation: 2 });
			expect(store.admitTimeFiring({ id: "remind", generation: 2, scheduledFor: START + MINUTE })).toEqual({ status: "not_enabled" });
			expect(store.claim({ leaseMs: MINUTE })?.occurrence.key).toBe(`time:${START + MINUTE}`);

			created(store, { ...base, source: { kind: "time", schedule: "once", at: START } }, "enabled", "late");
			clock.now = START + 61 * MINUTE;
			expect(store.admitTimeFiring({ id: "late", generation: 1, scheduledFor: START })).toMatchObject({ status: "accepted", occurrence: { status: "missed" } });
			expect(store.outbox("late")).toEqual([]);

			created(store, { ...base, source: { kind: "time", schedule: "interval", everyMs: 10 * MINUTE, anchorAt: START } }, "enabled", "every");
			expect(store.admitTimeFiring({ id: "every", generation: 1, scheduledFor: START + 5 * MINUTE })).toEqual({ status: "schedule_mismatch" });
			expect(store.admitTimeFiring({ id: "every", generation: 1, scheduledFor: START + 60 * MINUTE })).toMatchObject({ status: "accepted", occurrence: { status: "pending" } });
			expect(store.admitTimeFiring({ id: "every", generation: 1, scheduledFor: START + 60 * MINUTE })).toEqual({ status: "duplicate" });
			expect(store.admitTimeFiring({ id: "every", generation: 1, scheduledFor: START + 50 * MINUTE })).toEqual({ status: "out_of_order" });
		});
	});
});
