import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Pim } from "../src/pim";
import { type Condition, type ConditionState, evaluate, parseCondition } from "../src/triggers/condition";
import { parseTriggerSpec } from "../src/triggers/spec";
import { TriggerStore, type TriggerStoreOptions } from "../src/triggers/store";
import { type JsonValue, TriggerValidationError } from "../src/triggers/validate";

// Triggers are not wired into Pim yet (docs/triggers.md): these tests use their store on a Durable Object's database of its own.

const START = 1_800_000_000_000;
const MINUTE = 60_000;

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
		const make = (options: Partial<TriggerStoreOptions> = {}) => new TriggerStore(state.storage.sql, { transaction, now: () => clock.now, ...options });
		work({ store: make(), clock, sql: state.storage.sql, make, transaction });
	});
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
		expect(parseTriggerSpec({ ...base, source: { kind: "process", name: "make" }, condition: { when: { op: "compare", path: ["running"], cmp: "eq", value: false } } }).source).toEqual({ kind: "process", name: "make", intervalMs: 300_000 });
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
			[eventSpec({ delivery: { maxPendingEvents: 101 } }), "spec.delivery.maxPendingEvents"],
			[{ ...base, source: { kind: "time", schedule: "once", at: START }, condition: { when: { op: "exists", path: ["a"] } } }, "spec.condition"],
			[eventSpec({ condition: { when: { op: "changed", path: ["price"] } } }), "spec.condition.when.op"],
			[eventSpec({ condition: { when: { op: "exists", path: ["a"] }, staleAfterMs: 60_000 } }), "spec.condition.staleAfterMs"],
			[eventSpec({ source: { kind: "connector_event", connectorId: "flights", event: "x", arguments: { a: "x".repeat(5_000) } } }), "spec.source.arguments"],
			[{ ...base, source: { kind: "file", path: "/home/ada/../root", events: ["created"] } }, "spec.source.path"],
			[{ ...base, source: { kind: "file", path: "/home/ada", events: ["created", "created"] } }, "spec.source.events"],
			[{ ...base, source: { kind: "process", name: "/usr/bin/make" }, condition: { when: { op: "exists", path: ["running"] } } }, "spec.source.name"],
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

	/** Evaluates `condition` on observations a minute apart and returns what each fired, and the truth of each. */
	function series(condition: Condition, observations: (JsonValue | { gap: JsonValue })[]) {
		let state: ConditionState | null = null;
		return observations.map((observation, index) => {
			const gap = typeof observation === "object" && observation !== null && !Array.isArray(observation) && "gap" in observation;
			const value = gap ? (observation as { gap: JsonValue }).gap : (observation as JsonValue);
			const at = START + index * MINUTE;
			const result = evaluate(condition, "edge", state, { value, observedAt: at, gap }, at);
			state = result.state;
			return result.fire ? "fire" : result.truth;
		});
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

	it("fires on false to true only, stays quiet when already true, and never rearms on unknown", () => {
		const low = edge({ op: "compare", path: ["price"], cmp: "lt", value: 500 });
		expect(series(low, [{ price: 400 }, { price: 400 }, { price: 600 }, { price: 400 }, { price: 400 }])).toEqual(["true", "true", "false", "fire", "true"]);
		// Unknown neither arms nor disarms: true, unknown, true is one condition that held throughout.
		expect(series(low, [{ price: 600 }, { price: 400 }, {}, { price: 400 }])).toEqual(["false", "fire", "unknown", "true"]);
		// Armed by false, it stays armed through unknown and a gap.
		expect(series(low, [{ price: 600 }, {}, { gap: { price: 400 } }])).toEqual(["false", "unknown", "fire"]);
		// Before any known result there is no baseline: the first known one sets it.
		expect(series(low, [{}, {}, { price: 400 }, { price: 600 }, { price: 300 }])).toEqual(["unknown", "unknown", "true", "false", "fire"]);
	});

	it("fires on each change it sees, and starts comparing again after a gap", () => {
		const status = edge({ op: "changed", path: ["status"] });
		expect(series(status, [{ status: "a" }, { status: "b" }, { status: "c" }, { status: "c" }, {}, { status: "d" }])).toEqual(["false", "fire", "fire", "false", "unknown", "fire"]);
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
		expect(late).toMatchObject({ truth: "unknown", fire: false, stale: true });
		expect(late.state).toEqual(armed.state);
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
			const trigger = created(store, pollSpec(), "draft", "price");
			expect(trigger).toMatchObject({ id: "price", revision: 1, lifecycle: "draft", health: "unknown", generation: 1 });
			clock.now += 1_000;
			expect(store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ label: "Lower" }) })).toMatchObject({ ok: false, reason: "revision_mismatch" });
			expect(count(sql, "pim_trigger_revisions")).toBe(1);
			const second = store.update({ id: "price", expectedRevision: 1, spec: pollSpec({ label: "Lower" }) });
			expect(second).toMatchObject({ ok: true, trigger: { revision: 2, generation: 1, spec: { label: "Lower" } } });
			expect(store.revision("price", 1)?.label).toBe("Watch");
			// The same spec again is no new revision.
			expect(store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ label: "Lower" }) })).toMatchObject({ ok: true, trigger: { revision: 2 } });
			expect(store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ owningAgentId: "agent-2" }) })).toMatchObject({ ok: false, reason: "immutable_field" });
			expect(store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ originChatId: "chat-2" }) })).toMatchObject({ ok: false, reason: "immutable_field" });
			// Revisions can't be rewritten, even by hand.
			expect(() => sql.exec("UPDATE pim_trigger_revisions SET spec = '{}' WHERE trigger_id = 'price'")).toThrow(/immutable/);
			expect(store.revision("price", 1)?.label).toBe("Watch");
			expect(store.update({ id: "missing", expectedRevision: 1, spec: pollSpec() })).toMatchObject({ ok: false, reason: "not_found" });
			expect(store.create({ id: "price", spec: pollSpec() })).toMatchObject({ ok: false, reason: "exists" });
		});
	});

	it("enables a computer source only with an authorization, and asks for a new one when its source changes", async () => {
		await withStore(({ store }) => {
			expect(store.create({ spec: pollSpec({ authorizationRef: null }), lifecycle: "enabled" })).toMatchObject({ ok: false, reason: "authorization_required" });
			const draft = created(store, pollSpec({ authorizationRef: null }), "draft");
			expect(store.setLifecycle({ id: draft.id, to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: false, reason: "authorization_required" });
			const trigger = created(store, pollSpec(), "enabled");
			const otherCommand = pollSpec({ source: { kind: "poll", command: "./other.sh" } });
			expect(store.update({ id: trigger.id, expectedRevision: 1, spec: otherCommand })).toMatchObject({ ok: false, reason: "authorization_required" });
			expect(store.update({ id: trigger.id, expectedRevision: 1, spec: { ...otherCommand, authorizationRef: null } })).toMatchObject({ ok: false, reason: "authorization_required" });
			expect(store.update({ id: trigger.id, expectedRevision: 1, spec: { ...otherCommand, authorizationRef: "approval-2" } })).toMatchObject({ ok: true, trigger: { revision: 2, generation: 2 } });
			// A connector's events are not the computer's: they need no authorization here.
			expect(store.create({ spec: eventSpec(), lifecycle: "enabled" })).toMatchObject({ ok: true });
		});
	});

	it("takes each event once per source, and writes all of an admission or none of it", async () => {
		await withStore(({ store, clock, sql, make, transaction }) => {
			created(store, eventSpec(), "enabled", "flights");
			const first = store.admit({ id: "flights", generation: 1, eventId: "evt-1", observedAt: START, payload: { price: 450 } });
			expect(first).toMatchObject({ status: "accepted", truth: "true", occurrence: { key: "event:evt-1", revision: 1, status: "pending", evidence: { price: 450 } } });
			expect(store.admit({ id: "flights", generation: 1, eventId: "evt-1", observedAt: START, payload: { price: 450 } })).toEqual({ status: "duplicate" });
			expect([count(sql, "pim_trigger_inbox"), count(sql, "pim_trigger_occurrences"), count(sql, "pim_trigger_outbox")]).toEqual([1, 1, 1]);

			// The outbox item's id is the second id an admission makes: failing there must undo the inbox entry, checkpoint and occurrence.
			let ids = 0;
			const failing = make({
				newId: () => {
					ids += 1;
					if (ids === 2) throw new Error("disk full");
					return crypto.randomUUID();
				},
			});
			clock.now += 1_000;
			expect(() => failing.admit({ id: "flights", generation: 1, eventId: "evt-2", observedAt: clock.now, payload: {}, checkpoint: { position: 2, cursor: "c2" } })).toThrow("disk full");
			expect([count(sql, "pim_trigger_inbox"), count(sql, "pim_trigger_occurrences"), count(sql, "pim_trigger_outbox")]).toEqual([1, 1, 1]);
			expect(store.sourceState("flights")).toMatchObject({ position: null, cursor: null, lastObservedAt: START });
			// A crash after all of an admission's writes, before its transaction commits, keeps none of them.
			const crashing = make({
				transaction: (work) =>
					transaction(() => {
						work();
						throw new Error("crash before commit");
					}),
			});
			expect(() => crashing.admit({ id: "flights", generation: 1, eventId: "evt-2", observedAt: clock.now, payload: {}, checkpoint: { position: 2, cursor: "c2" } })).toThrow("crash before commit");
			expect(() => crashing.claim({ leaseMs: MINUTE })).toThrow("crash before commit");
			expect([count(sql, "pim_trigger_inbox"), count(sql, "pim_trigger_occurrences"), count(sql, "pim_trigger_outbox")]).toEqual([1, 1, 1]);
			expect(store.sourceState("flights")).toMatchObject({ position: null, cursor: null, lastObservedAt: START });
			expect(store.outbox("flights")).toMatchObject([{ status: "pending", attempts: 0 }]);
			// So the source's retry is taken in whole.
			expect(store.admit({ id: "flights", generation: 1, eventId: "evt-2", observedAt: clock.now, payload: {}, checkpoint: { position: 2, cursor: "c2" } })).toMatchObject({ status: "accepted" });
			expect(store.sourceState("flights")).toMatchObject({ position: 2, cursor: "c2", identity: "flights#1" });
			expect(() => store.admit({ id: "flights", generation: 1, eventId: "x".repeat(257), observedAt: START, payload: {} })).toThrow(TriggerValidationError);
			expect(() => store.admit({ id: "flights", generation: 1, eventId: "evt-3", observedAt: clock.now + 10 * MINUTE, payload: {} })).toThrow(TriggerValidationError);
			expect(() => store.admit({ id: "flights", generation: 1, eventId: "evt-3", observedAt: START, payload: { big: "x".repeat(17_000) } })).toThrow(TriggerValidationError);
		});
	});

	it("refuses observations from a stale generation, a paused trigger or a deleted one", async () => {
		await withStore(({ store, clock, sql }) => {
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
			const delivery = store.claim({ leaseMs: MINUTE })!;
			expect(store.remove({ id: "flights" })).toEqual({ ok: true });
			expect(admit(3, "c")).toEqual({ status: "deleted" });
			expect(admit(4, "c")).toEqual({ status: "deleted" });
			expect(store.complete({ outboxId: delivery.item.id, attempt: delivery.attempt })).toEqual({ ok: false });
			expect(store.create({ id: "flights", spec: eventSpec() })).toMatchObject({ ok: false, reason: "deleted" });
			expect(store.setLifecycle({ id: "flights", to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: false, reason: "deleted" });
			// Nothing of it is left but the tombstone.
			expect(["pim_triggers", "pim_trigger_revisions", "pim_trigger_sources", "pim_trigger_inbox", "pim_trigger_occurrences", "pim_trigger_outbox"].map((table) => count(sql, table))).toEqual([0, 0, 0, 0, 0, 0]);
			expect(count(sql, "pim_trigger_tombstones")).toBe(1);
			expect(store.setLifecycle({ id: "flights", to: "paused" })).toMatchObject({ ok: false, reason: "deleted" });
		});
	});

	it("moves the checkpoint only forward, refuses an older state, and takes events in any order", async () => {
		await withStore(({ store }) => {
			created(store, pollSpec(), "enabled", "price");
			const poll = (eventId: string, observedAt: number, price: number, position: number) =>
				store.admit({ id: "price", generation: 1, eventId, observedAt, payload: { price }, checkpoint: { position, cursor: `p${position}` } });
			expect(poll("p-2", START - 2_000, 600, 2)).toMatchObject({ status: "accepted", truth: "false" });
			// An older state arriving late must not decide anything.
			expect(poll("p-1", START - 3_000, 400, 1)).toEqual({ status: "out_of_order" });
			expect(poll("p-2b", START - 2_000, 400, 3)).toEqual({ status: "out_of_order" });
			expect(store.sourceState("price")).toMatchObject({ position: 2, cursor: "p2", lastObservedAt: START - 2_000 });
			expect(poll("p-3", START - 1_000, 400, 3)).toMatchObject({ status: "accepted", truth: "true", occurrence: { key: "event:p-3" } });

			created(store, eventSpec(), "enabled", "flights");
			const event = (eventId: string, observedAt: number, position: number) => store.admit({ id: "flights", generation: 1, eventId, observedAt, payload: {}, checkpoint: { position, cursor: `c${position}` } });
			expect(event("e5", START, 5)).toMatchObject({ status: "accepted" });
			expect(event("e3", START - 5_000, 3)).toMatchObject({ status: "accepted", occurrence: { key: "event:e3" } });
			expect(store.sourceState("flights")).toMatchObject({ position: 5, cursor: "c5", lastObservedAt: START });
			expect(event("e3", START - 5_000, 3)).toEqual({ status: "duplicate" });
		});
	});

	it("starts a changed source over: new identity, checkpoint, condition state and generation", async () => {
		await withStore(({ store }) => {
			created(store, pollSpec(), "enabled", "price");
			store.admit({ id: "price", generation: 1, eventId: "obs-1", observedAt: START, payload: { price: 600 }, checkpoint: { position: 1, cursor: null } });
			expect(store.sourceState("price")).toMatchObject({ identity: "price#1", position: 1, conditionState: { armed: true } });
			// A new condition alone keeps the source, and forgets what the old condition remembered.
			store.update({ id: "price", expectedRevision: 1, spec: pollSpec({ condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 450 } } }) });
			expect(store.sourceState("price")).toMatchObject({ identity: "price#1", position: 1, conditionState: null });
			expect(store.get("price")?.generation).toBe(1);
			store.update({ id: "price", expectedRevision: 2, spec: pollSpec({ source: { kind: "poll", command: "./other.sh" }, authorizationRef: "approval-2" }) });
			expect(store.sourceState("price")).toMatchObject({ identity: "price#3", position: null, lastObservedAt: null, conditionState: null });
			expect(store.admit({ id: "price", generation: 1, eventId: "obs-2", observedAt: START + 1, payload: { price: 400 } })).toEqual({ status: "stale_generation" });
			// The new source's observer may reuse an event id the old one used.
			expect(store.admit({ id: "price", generation: 2, eventId: "obs-1", observedAt: START + 1, payload: { price: 400 } })).toMatchObject({ status: "accepted" });
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
			expect(first).toMatchObject({ occurrence: { key: "event:a", revision: 1 }, spec: { instruction: "First instruction" } });
			expect(() => sql.exec("UPDATE pim_trigger_occurrences SET revision = 2 WHERE trigger_id = 'flights'")).toThrow(/keeps its revision/);
			store.complete({ outboxId: first.item.id, attempt: first.attempt });
			expect(store.claim({ leaseMs: MINUTE })).toMatchObject({ occurrence: { key: "event:b", revision: 2 }, spec: { instruction: "Second instruction" } });
		});
	});

	it("retries a delivery under the same operation id, and only the latest attempt settles it", async () => {
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
			// A lease that runs out is claimed again, as a new attempt with the same operation id.
			clock.now += MINUTE;
			const third = store.claim({ leaseMs: MINUTE })!;
			expect(third).toMatchObject({ attempt: 3, item: { operationId: first.item.operationId } });
			expect(store.complete({ outboxId: second.item.id, attempt: 2 })).toEqual({ ok: false });
			expect(store.complete({ outboxId: third.item.id, attempt: 3 })).toEqual({ ok: true });
			expect(store.occurrences("flights")[0]?.status).toBe("delivered");
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();

			// Attempts run out.
			store.admit({ id: "flights", generation: 1, eventId: "b", observedAt: START, payload: {} });
			for (let attempt = 1; attempt <= 5; attempt += 1) {
				const delivery = store.claim({ leaseMs: MINUTE })!;
				expect(delivery.attempt).toBe(attempt);
				expect(store.fail({ outboxId: delivery.item.id, attempt, retryAt: clock.now, error: "down" })).toEqual({ ok: true, retrying: attempt < 5 });
			}
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();
			expect(store.occurrences("flights")[1]?.status).toBe("failed");
		});
	});

	it("runs one delivery per trigger at a time, in order, and holds back events past its bound", async () => {
		await withStore(({ store }) => {
			created(store, eventSpec({ delivery: { maxPendingEvents: 2 } }), "enabled", "flights");
			created(store, eventSpec(), "enabled", "trains");
			const admit = (id: string, eventId: string) => store.admit({ id, generation: 1, eventId, observedAt: START, payload: { eventId } });
			expect(admit("flights", "a")).toMatchObject({ status: "accepted" });
			expect(admit("flights", "b")).toMatchObject({ status: "accepted" });
			expect(admit("flights", "c")).toEqual({ status: "backpressure" });
			expect(store.outbox("flights")).toHaveLength(2);
			const first = store.claim({ leaseMs: MINUTE })!;
			expect(first.occurrence.key).toBe("event:a");
			// With `a` under way, `b` waits; another trigger's delivery doesn't.
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();
			admit("trains", "t");
			expect(store.claim({ leaseMs: MINUTE })?.occurrence.key).toBe("event:t");
			// The delivery under way is not pending, so there is room for `c` now.
			expect(admit("flights", "c")).toMatchObject({ status: "accepted" });
			store.complete({ outboxId: first.item.id, attempt: first.attempt });
			const second = store.claim({ leaseMs: MINUTE })!;
			expect(second.occurrence.key).toBe("event:b");
			store.complete({ outboxId: second.item.id, attempt: second.attempt });
			// Paused, its deliveries wait; enabled again, they go on.
			store.setLifecycle({ id: "flights", to: "paused" });
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();
			store.setLifecycle({ id: "flights", to: "enabled", expectedRevision: 1 });
			expect(store.claim({ leaseMs: MINUTE })?.occurrence.key).toBe("event:c");
			expect(store.occurrences("flights").map((occurrence) => occurrence.status)).toEqual(["delivered", "delivered", "pending"]);
		});
	});

	it("keeps one pending snapshot of a state, superseding an older undelivered one", async () => {
		await withStore(({ store, clock }) => {
			created(store, pollSpec({ delivery: { rawSamples: false } }), "enabled", "price");
			let at = START;
			const poll = (price: number) => {
				at += MINUTE;
				clock.now = at;
				return store.admit({ id: "price", generation: 1, eventId: `obs-${at}`, observedAt: at, payload: { price, note: "not kept" } });
			};
			poll(600);
			const first = poll(400);
			expect(first).toMatchObject({ status: "accepted", occurrence: { evidence: { observedAt: at, fields: [{ path: ["price"], value: 400 }] } } });
			poll(600);
			const second = poll(300);
			expect(second).toMatchObject({ status: "accepted", superseded: [first.status === "accepted" ? first.occurrence?.id : ""] });
			expect(store.occurrences("price").map((occurrence) => occurrence.status)).toEqual(["superseded", "pending"]);
			// A delivery under way is left to finish.
			const delivery = store.claim({ leaseMs: MINUTE })!;
			poll(600);
			expect(poll(200)).toMatchObject({ status: "accepted", superseded: [] });
			expect(store.occurrences("price").map((occurrence) => occurrence.status)).toEqual(["superseded", "pending", "pending"]);
			expect(delivery.occurrence.status).toBe("pending");

			created(store, pollSpec({ delivery: { rawSamples: true } }), "enabled", "raw");
			store.admit({ id: "raw", generation: 1, eventId: "1", observedAt: at, payload: { price: 600 } });
			expect(store.admit({ id: "raw", generation: 1, eventId: "2", observedAt: at + 1, payload: { price: 400, note: "kept" } })).toMatchObject({ occurrence: { evidence: { price: 400, note: "kept" } } });
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
			// Two minutes after it first went down, but the gap means it was seen down only from now.
			expect(poll(3 * MINUTE, false)).toMatchObject({ truth: "false", occurrence: null });
			expect(store.sourceState("site")?.gapPending).toBe(false);
			expect(poll(5 * MINUTE, false)).toMatchObject({ truth: "true", occurrence: { key: `event:o${5 * MINUTE}` } });
			// An observation that arrives after twice the interval is stale: no evidence, and a gap.
			clock.now = START + 9 * MINUTE;
			expect(store.admit({ id: "site", generation: 1, eventId: "late", observedAt: START + 6 * MINUTE, payload: { up: true } })).toMatchObject({ truth: "unknown", stale: true, occurrence: null });
			expect(store.sourceState("site")?.gapPending).toBe(true);
			expect(store.recordGap({ id: "site", generation: 0 })).toEqual({ ok: false });
		});
	});

	it("runs a time firing once, misses one too late, and ends a one-time trigger with it", async () => {
		await withStore(({ store, clock }) => {
			created(store, { ...base, source: { kind: "time", schedule: "once", at: START + MINUTE } }, "enabled", "remind");
			expect(store.admitTimeFiring({ id: "remind", generation: 1, scheduledFor: START + MINUTE })).toEqual({ status: "not_due" });
			expect(store.admitTimeFiring({ id: "remind", generation: 1, scheduledFor: START })).toEqual({ status: "schedule_mismatch" });
			expect(store.admit({ id: "remind", generation: 1, eventId: "x", observedAt: START, payload: {} })).toEqual({ status: "wrong_source" });
			clock.now = START + 2 * MINUTE;
			expect(store.admitTimeFiring({ id: "remind", generation: 1, scheduledFor: START + MINUTE })).toMatchObject({ status: "accepted", occurrence: { key: `time:${START + MINUTE}`, status: "pending" } });
			expect(store.get("remind")).toMatchObject({ lifecycle: "ended", generation: 2 });
			expect(store.admitTimeFiring({ id: "remind", generation: 2, scheduledFor: START + MINUTE })).toEqual({ status: "not_enabled" });
			// Ended, it still delivers what it took in.
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

	it("keeps a bounded inbox and history per trigger", async () => {
		await withStore(({ sql, make }) => {
			const store = make({ retention: { inbox: 3, occurrences: 2 } });
			created(store, eventSpec(), "enabled", "flights");
			for (const eventId of ["a", "b", "c", "d", "e"]) {
				store.admit({ id: "flights", generation: 1, eventId, observedAt: START, payload: {} });
				const delivery = store.claim({ leaseMs: MINUTE })!;
				store.complete({ outboxId: delivery.item.id, attempt: delivery.attempt });
			}
			expect(sql.exec("SELECT event_id FROM pim_trigger_inbox ORDER BY rowid").toArray().map((row) => row.event_id)).toEqual(["c", "d", "e"]);
			expect(store.occurrences("flights").map((occurrence) => occurrence.key)).toEqual(["event:d", "event:e"]);
			expect(count(sql, "pim_trigger_outbox")).toBe(2);
		});
	});
});

