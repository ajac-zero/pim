import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Pim } from "../src/pim";
import { type Condition, type ConditionState, evaluate, parseCondition } from "@pim/triggers/condition";
import { TRIGGER_LIMITS, type TimeSource, parseTriggerSpec } from "@pim/triggers/spec";
import { type AuthorizationRequest, type AuthorizationVerdict, TRIGGER_TABLES, TriggerStore, type TriggerStoreOptions } from "@pim/triggers/store";
import { selectDueFiring } from "@pim/triggers/time";
import { type JsonValue, TriggerValidationError } from "@pim/triggers/validate";

// These tests use the store on a Durable Object's database of its own; Pim's own engine, behind its gate, is tested in test/triggers-host.test.ts.

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
		{ ...base, source: { kind: "file", path: "/home/ada/inbox", events: ["created", "deleted"], recursive: true }, destination: { type: "new_chat" }, authorizationRef: "approval-1" },
	];
}

function count(sql: SqlStorage, table: string): number {
	return Number(sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n);
}

function created(store: TriggerStore, spec: unknown, lifecycle: "draft" | "enabled" = "enabled", id?: string) {
	const result = store.create({ spec, lifecycle, ...(id ? { id } : {}) });
	if (!result.ok) throw new Error(`not created: ${result.reason}`);
	return result.trigger;
}

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

	it("takes a stored spec back unchanged, and an edit of it as a new revision, for every source", async () => {
		await withStore(({ store }) => {
			for (const spec of everySource()) {
				for (const lifecycle of ["draft", "enabled"] as const) {
					const trigger = created(store, spec, lifecycle);
					const stored = store.get(trigger.id)!.spec;
					expect(store.update({ id: trigger.id, expectedRevision: 1, spec: stored }), JSON.stringify(stored.source)).toMatchObject({ ok: true, trigger: { revision: 1, generation: trigger.generation } });
					expect(store.update({ id: trigger.id, expectedRevision: 1, spec: { ...stored, label: "Edited" } }), JSON.stringify(stored.source)).toMatchObject({
						ok: true,
						trigger: { revision: 2, generation: trigger.generation, spec: { ...stored, label: "Edited" } },
					});
				}
			}
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

	it("deletes a trigger by stopping it, cancelling only what no attempt claimed, and keeping its record until the space is erased", async () => {
		await withStore(({ store, clock, sql }) => {
			created(store, eventSpec({ instruction: "First" }), "enabled", "flights");
			for (const eventId of ["a", "b", "c"]) store.admit({ id: "flights", generation: 1, eventId, observedAt: START, payload: {} });
			const done = store.claim({ leaseMs: MINUTE })!;
			store.complete({ outboxId: done.item.id, attempt: done.attempt });
			// `b` is under way: its deliverer's submission was accepted, and it is deleted before the deliverer records that.
			const underWay = store.claim({ leaseMs: MINUTE })!;
			store.update({ id: "flights", expectedRevision: 1, spec: eventSpec({ instruction: "Second" }) });
			clock.now += 1_000;
			expect(store.remove({ id: "flights", expectedRevision: 1 })).toMatchObject({ ok: false, reason: "revision_mismatch" });
			expect(store.remove({ id: "flights", expectedRevision: 2 })).toEqual({ ok: true });
			// Only `c`, which nothing had claimed, is cancelled. Whether `b` was handed on is unknown, not cancelled.
			expect(store.occurrences("flights").map((occurrence) => occurrence.status)).toEqual(["delivered", "outcome_unknown", "cancelled"]);
			expect(store.outbox("flights").map((item) => item.status)).toEqual(["done", "outcome_unknown", "cancelled"]);
			// The attempt can't settle it as if the trigger were alive, and nothing more is claimed or taken in.
			expect(store.complete({ outboxId: underWay.item.id, attempt: underWay.attempt })).toEqual({ ok: false });
			expect(store.fail({ outboxId: underWay.item.id, attempt: underWay.attempt, retryAt: clock.now, error: "x" })).toMatchObject({ ok: false });
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();
			expect(store.admit({ id: "flights", generation: store.get("flights")!.generation, eventId: "d", observedAt: clock.now, payload: {} })).toEqual({ status: "deleted" });
			// What happened is recorded once known, without claiming anything or bringing the trigger back.
			expect(store.reconcile({ outboxId: store.outbox("flights")[2]!.id, outcome: "delivered" })).toEqual({ ok: false });
			expect(store.reconcile({ outboxId: underWay.item.id, outcome: "delivered" })).toEqual({ ok: true });
			expect(store.occurrences("flights").map((occurrence) => occurrence.status)).toEqual(["delivered", "delivered", "cancelled"]);
			expect(store.claim({ leaseMs: MINUTE })).toBeUndefined();
			// What it did stays: its revisions, its occurrences and how each ended.
			expect(store.get("flights")).toMatchObject({ lifecycle: "deleted", revision: 2, spec: { instruction: "Second" } });
			expect(store.list()).toEqual([]);
			expect(store.revision("flights", 1)?.instruction).toBe("First");
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

			// A one-time trigger whose time has passed is refused when it is saved, not left to wait for nothing.
			expect(() => store.create({ spec: { ...base, source: { kind: "time", schedule: "once", at: START } }, lifecycle: "enabled" })).toThrow(TriggerValidationError);
			created(store, { ...base, source: { kind: "time", schedule: "once", at: START + 3 * MINUTE } }, "enabled", "late");
			created(store, { ...base, source: { kind: "time", schedule: "interval", everyMs: 10 * MINUTE, anchorAt: START } }, "enabled", "every");
			clock.now = START + 64 * MINUTE;
			expect(store.admitTimeFiring({ id: "late", generation: 1, scheduledFor: START + 3 * MINUTE })).toMatchObject({ status: "accepted", occurrence: { status: "missed" } });
			expect(store.outbox("late")).toEqual([]);

			expect(store.admitTimeFiring({ id: "every", generation: 1, scheduledFor: START + 5 * MINUTE })).toEqual({ status: "schedule_mismatch" });
			expect(store.admitTimeFiring({ id: "every", generation: 1, scheduledFor: START + 60 * MINUTE })).toMatchObject({ status: "accepted", occurrence: { status: "pending" } });
			expect(store.admitTimeFiring({ id: "every", generation: 1, scheduledFor: START + 60 * MINUTE })).toEqual({ status: "duplicate" });
			expect(store.admitTimeFiring({ id: "every", generation: 1, scheduledFor: START + 50 * MINUTE })).toEqual({ status: "out_of_order" });
		});
	});

	it("admits only the instants a schedule names, and none from before its current enabling", async () => {
		await withStore(({ store, clock, make }) => {
			// 09:00 in New York on weekdays; START is a Friday, 03:00 there.
			created(store, { ...base, source: { kind: "time", schedule: "cron", expression: "0 9 * * 1-5", timeZone: "America/New_York" } }, "enabled", "cron");
			expect(store.sourceState("cron")).toMatchObject({ activeSince: START, nextWakeAt: START });
			clock.now = START + 7 * HOUR;
			// 09:00 UTC and 09:01 New York are not firings; 09:00 New York (14:00 UTC) is.
			expect(store.admitTimeFiring({ id: "cron", generation: 1, scheduledFor: START + HOUR })).toEqual({ status: "schedule_mismatch" });
			expect(store.admitTimeFiring({ id: "cron", generation: 1, scheduledFor: START + 6 * HOUR + MINUTE })).toEqual({ status: "schedule_mismatch" });
			expect(store.admitTimeFiring({ id: "cron", generation: 1, scheduledFor: START + 6 * HOUR })).toMatchObject({ status: "accepted", occurrence: { status: "pending" } });
			// Thursday's 09:00 came before it was enabled.
			created(store, { ...base, source: { kind: "time", schedule: "cron", expression: "0 9 * * 1-5", timeZone: "America/New_York" } }, "enabled", "late");
			expect(store.admitTimeFiring({ id: "late", generation: 1, scheduledFor: START - 18 * HOUR })).toEqual({ status: "before_enabled" });

			// The boundary is durable: another store on the database, as after a restart, reads the same one.
			expect(make().sourceState("late")?.activeSince).toBe(START + 7 * HOUR);
			// A new label keeps it; pausing clears it and the wake; enabling again, or a new source while enabled, starts it afresh.
			clock.now = START + 8 * HOUR;
			const spec = store.get("late")!.spec;
			store.update({ id: "late", expectedRevision: 1, spec: { ...spec, label: "Later" } });
			expect(store.sourceState("late")).toMatchObject({ activeSince: START + 7 * HOUR, nextWakeAt: START + 7 * HOUR });
			store.setLifecycle({ id: "late", to: "paused" });
			expect(store.sourceState("late")).toMatchObject({ activeSince: null, nextWakeAt: null });
			clock.now = START + 9 * HOUR;
			store.setLifecycle({ id: "late", to: "enabled", expectedRevision: 2 });
			expect(store.sourceState("late")).toMatchObject({ activeSince: START + 9 * HOUR, nextWakeAt: START + 9 * HOUR });
			clock.now = START + 10 * HOUR;
			store.update({ id: "late", expectedRevision: 2, spec: { ...spec, label: "Later", source: { kind: "time", schedule: "cron", expression: "0 10 * * 1-5", timeZone: "America/New_York" } } });
			expect(store.sourceState("late")).toMatchObject({ activeSince: START + 10 * HOUR, nextWakeAt: START + 10 * HOUR, lastObservedAt: null });
			// A source that would never fire again is refused, and the trigger is left as it was: from 2033, the next 29th of February on a Sunday is in 2060, past the horizon.
			clock.now = Date.parse("2033-01-01T00:00:00Z");
			expect(() => store.update({ id: "late", expectedRevision: 3, spec: { ...spec, source: { kind: "time", schedule: "cron", expression: "0 0 29 2 */7", timeZone: "UTC" } } })).toThrow(TriggerValidationError);
			expect(store.get("late")?.revision).toBe(3);
		});
	});

	it("admits a time trigger's latest due firing once, with a count of the older ones, and sets its next wake", async () => {
		await withStore(({ store, clock }) => {
			created(store, { ...base, source: { kind: "time", schedule: "interval", everyMs: 10 * MINUTE, anchorAt: START + 10 * MINUTE } }, "enabled", "every");
			// Down for five firings: the latest runs, 5 minutes late; four are counted, not listed or run.
			clock.now = START + 55 * MINUTE;
			const tick = store.admitDueTime({ id: "every", generation: 1 });
			expect(tick).toMatchObject({ status: "admitted", older: { count: 4, first: START + 10 * MINUTE, last: START + 40 * MINUTE, complete: true }, nextWakeAt: START + 60 * MINUTE, limit: null });
			expect(store.occurrences("every")).toMatchObject([{ key: `time:${START + 50 * MINUTE}`, evidence: { reason: "time", scheduledFor: START + 50 * MINUTE, older: { count: 4 } } }]);
			expect(store.admitDueTime({ id: "every", generation: 1 })).toMatchObject({ status: "idle", occurrence: null, nextWakeAt: START + 60 * MINUTE });
			expect(store.dueTimeTriggers({ now: clock.now, limit: 10 })).toEqual([]);
			expect(store.dueTimeTriggers({ now: START + 60 * MINUTE, limit: 10 })).toEqual([{ id: "every", generation: 1, nextWakeAt: START + 60 * MINUTE }]);
			// Measured when it is admitted: an hour late, inclusive, still runs; a millisecond more is missed.
			clock.now = START + 60 * MINUTE + HOUR;
			expect(store.admitDueTime({ id: "every", generation: 1 })).toMatchObject({ status: "admitted", occurrence: { dueAt: START + 120 * MINUTE }, older: { count: 6 } });
			expect(store.outbox("every").map((item) => item.status)).toEqual(["superseded", "pending"]);
			expect(store.admitDueTime({ id: "every", generation: 2 })).toEqual({ status: "stale_generation" });

			// Every two hours, down from 3:00 to 7:00 and a millisecond: 6:00 is past its hour, and recorded as missed; it supersedes nothing.
			clock.now = START + 2 * HOUR;
			created(store, { ...base, source: { kind: "time", schedule: "interval", everyMs: 2 * HOUR, anchorAt: START + 2 * HOUR } }, "enabled", "rare");
			expect(store.admitDueTime({ id: "rare", generation: 1 })).toMatchObject({ status: "admitted", occurrence: { dueAt: START + 2 * HOUR } });
			clock.now = START + 7 * HOUR + 1;
			expect(store.admitDueTime({ id: "rare", generation: 1 })).toMatchObject({ status: "missed", occurrence: { status: "missed", dueAt: START + 6 * HOUR }, older: { count: 1, first: START + 4 * HOUR } });
			expect(store.outbox("rare").map((item) => item.status)).toEqual(["pending"]);
		});
	});

	it("takes the first and last supported instants as firings, both included, when saved, enabled and admitted", async () => {
		await withStore(({ store, clock }) => {
			const first = TRIGGER_LIMITS.earliestAt;
			const last = TRIGGER_LIMITS.latestAt;
			const once = (at: number) => ({ ...base, source: { kind: "time", schedule: "once", at } });
			clock.now = first;
			created(store, once(first), "enabled", "first");
			expect(store.admitDueTime({ id: "first", generation: 1 })).toMatchObject({ status: "admitted", occurrence: { dueAt: first } });
			created(store, { ...base, source: { kind: "time", schedule: "interval", everyMs: MINUTE, anchorAt: first } }, "enabled", "grid");
			expect(store.admitDueTime({ id: "grid", generation: 1 })).toMatchObject({ status: "admitted", occurrence: { dueAt: first }, nextWakeAt: first + MINUTE });
			created(store, once(first), "draft", "draft");
			expect(store.setLifecycle({ id: "draft", to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: true });
			// `after` is exclusive, so it may be one millisecond before 2000, and no earlier.
			const source = parseTriggerSpec(once(first)).source as TimeSource;
			expect(selectDueFiring(source, { now: first, after: first - 1 })).toMatchObject({ status: "due", scheduledFor: first });
			expect(() => selectDueFiring(source, { now: first, after: first - 2 })).toThrow(TriggerValidationError);

			clock.now = last - 1;
			created(store, once(last), "enabled", "last");
			clock.now = last;
			created(store, once(last), "draft", "at-last");
			expect(store.setLifecycle({ id: "at-last", to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: true });
			expect(store.admitDueTime({ id: "last", generation: 1 })).toMatchObject({ status: "admitted", occurrence: { dueAt: last } });
			expect(store.admitDueTime({ id: "at-last", generation: 2 })).toMatchObject({ status: "admitted", occurrence: { dueAt: last } });
		});
	});

	it("claims only the named trigger's next item when asked to", async () => {
		await withStore(({ store }) => {
			created(store, eventSpec(), "enabled", "flights");
			created(store, eventSpec(), "enabled", "trains");
			store.admit({ id: "flights", generation: 1, eventId: "a", observedAt: START, payload: {} });
			store.admit({ id: "trains", generation: 1, eventId: "b", observedAt: START, payload: {} });
			expect(store.claim({ leaseMs: MINUTE, triggerId: "trains" })?.item.triggerId).toBe("trains");
			expect(store.claim({ leaseMs: MINUTE, triggerId: "trains" })).toBeUndefined();
			expect(store.claim({ leaseMs: MINUTE, triggerId: "nobody" })).toBeUndefined();
			expect(store.claim({ leaseMs: MINUTE })?.item.triggerId).toBe("flights");
		});
	});
});
