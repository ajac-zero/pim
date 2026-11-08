import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSecret, signWebhook } from "../src/extensions/app-events";
import type { Pim } from "../src/pim";
import type { AppWatch } from "../src/store";
import { ConnectorIngress } from "../src/triggers/connector";
import type { TriggerEngine } from "../src/triggers/engine";
import {
	adoptedSubscription,
	type LegacySchedule,
	MIGRATION_VARIABLE,
	type MigrationContext,
	type MigrationRecord,
	type PlanItem,
	TriggerMigration,
	cronMismatch,
	legacyEventOperationId,
	mapSchedule,
	mapWatch,
	migrationAllowed,
	planMigration,
} from "../src/triggers/migration";
import { TriggerStore } from "../src/triggers/store";
import { OWNER, ROOT, url } from "./helpers";
import { faux, triggerClock } from "./worker";

// Moving schedules and watches to triggers: the pure mapping, then the preview, apply and rollback in a real space,
// with its own SQLite database and the legacy paths as they are. The migration's gate is set only inside the tests that apply.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const SECRET = "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I=";

const context = (over: Partial<MigrationContext> = {}): MigrationContext => ({
	now: NOW,
	owner: "o_ada",
	publicUrl: "https://pim.test",
	agentExists: (id) => id === "scout",
	chatAgent: (chat) => (chat === "7" ? "planner" : "majordomo"),
	chatOpen: (chat) => chat !== "gone",
	...over,
});

const schedule = (over: Partial<LegacySchedule> & Record<string, unknown> = {}): LegacySchedule =>
	({ id: "s1", type: "scheduled", time: NOW / 1000 + 3600, payload: { session: "7", instruction: "Check the fare.", label: "Fare check" }, ...over }) as LegacySchedule;

const watch = (over: Partial<AppWatch> = {}): AppWatch => ({
	id: "w-1",
	serverId: "travel",
	event: "flight.price_changed",
	arguments: { route: "JFK-LIS" },
	instruction: "Tell me if it drops below $500.",
	session: "7",
	secret: SECRET,
	url: "https://pim.test/mcp/events/o_ada/w-1",
	remoteId: "sub_1",
	cursor: "cursor-value-9",
	refreshBefore: NOW + HOUR,
	status: "active",
	lastError: null,
	lastEventAt: NOW - MINUTE,
	createdAt: NOW - DAY,
	...over,
});

const SCHEDULE_DIFFERENCES = ["run_text", "lateness_bound", "refused_runs_retry", "agent_fixed"];

describe("mapping schedules and watches", () => {
	it("maps every field of a one-time schedule, at its own instant, to its chat and that chat's agent", () => {
		expect(mapSchedule(schedule(), context())).toEqual({
			kind: "schedule",
			legacyId: "s1",
			record: null,
			status: "migratable",
			triggerId: "legacy:schedule:s1:1",
			spec: {
				version: 1,
				owningAgentId: "planner",
				originChatId: "7",
				label: "Fare check",
				instruction: "Check the fare.",
				source: { kind: "time", schedule: "once", at: NOW + HOUR, maxLatenessMs: 7 * DAY },
				condition: null,
				destination: { type: "existing_chat", chatId: "7" },
				delivery: { rawSamples: false, maxPendingEvents: null },
				authorizationRef: null,
			},
			differences: SCHEDULE_DIFFERENCES,
			cutoverBlockers: ["firing_notification"],
			binding: null,
		});
	});

	it("keeps a delay as the instant it ends at, not as now plus the delay", () => {
		const item = mapSchedule(schedule({ type: "delayed", time: NOW / 1000 + 7200, delayInSeconds: 60 }), context());
		expect(item.status === "migratable" && item.spec.source).toEqual({ kind: "time", schedule: "once", at: NOW + 2 * HOUR, maxLatenessMs: 7 * DAY });
	});

	it("keeps a cron expression as it is, in UTC", () => {
		const item = mapSchedule(schedule({ type: "cron", time: NOW / 1000 + 600, cron: "30 7 * * 1-5" }), context());
		expect(item.status === "migratable" && item.spec.source).toEqual({ kind: "time", schedule: "cron", expression: "30 7 * * 1-5", timeZone: "UTC", catchUpMs: 7 * DAY });
	});

	it("starts a new chat each time with the agent the schedule names, or its chat's when that agent is gone", () => {
		const own = mapSchedule(schedule({ payload: { session: "7", instruction: "Brief me.", label: "Brief", newChat: true } }), context());
		const scout = mapSchedule(schedule({ payload: { session: "7", instruction: "Brief me.", label: "Brief", newChat: true, agent: "scout" } }), context());
		const gone = mapSchedule(schedule({ payload: { session: "7", instruction: "Brief me.", label: "Brief", newChat: true, agent: "ghost" } }), context());
		for (const [item, agent] of [
			[own, "planner"],
			[scout, "scout"],
			[gone, "planner"],
		] as const) {
			expect(item.status).toBe("migratable");
			if (item.status !== "migratable") continue;
			expect(item.spec.owningAgentId).toBe(agent);
			expect(item.spec.destination).toEqual({ type: "new_chat" });
			expect(item.spec.originChatId).toBe("7");
		}
		// A new chat each time needs no open chat to deliver to.
		expect(mapSchedule(schedule({ payload: { session: "gone", instruction: "Brief me.", newChat: true } }), context()).status).toBe("migratable");
	});

	it("labels an unlabelled schedule with its instruction's first line, as its chats are titled, cut to the spec's length", () => {
		const short = mapSchedule(schedule({ payload: { session: "7", instruction: "  Water the plants.\nThen tell me." } }), context());
		expect(short.status === "migratable" && short.spec.label).toBe("Water the plants.");
		expect(short.status === "migratable" && short.differences).toEqual([...SCHEDULE_DIFFERENCES, "label_derived"]);
		const long = mapSchedule(schedule({ payload: { session: "7", instruction: "x".repeat(200) } }), context());
		expect(long.status === "migratable" && long.spec.label).toBe(`${"x".repeat(119)}…`);
	});

	it("names each attempt's trigger apart, so one rolled back is made again under a new id", () => {
		const record = (phase: MigrationRecord["phase"], attempt: number): MigrationRecord => ({ kind: "schedule", legacyId: "s1", attempt, triggerId: `legacy:schedule:s1:${attempt}`, owner: "legacy", phase, createdAt: NOW, updatedAt: NOW });
		expect(mapSchedule(schedule(), context(), record("rolled_back", 1))).toMatchObject({ triggerId: "legacy:schedule:s1:2" });
		expect(mapSchedule(schedule(), context(), record("shadow", 2))).toMatchObject({ triggerId: "legacy:schedule:s1:2" });
	});

	it("maps every field of a watch, and the binding it would adopt by reference, with no secret or cursor in it", () => {
		const item = mapWatch(watch(), context());
		expect(item).toEqual({
			kind: "watch",
			legacyId: "w-1",
			record: null,
			status: "migratable",
			triggerId: "legacy:watch:w-1:1",
			spec: {
				version: 1,
				owningAgentId: "planner",
				originChatId: "7",
				label: "Connector event flight.price_changed",
				instruction: "Tell me if it drops below $500.",
				source: { kind: "connector_event", connectorId: "travel", event: "flight.price_changed", arguments: { route: "JFK-LIS" } },
				condition: null,
				destination: { type: "existing_chat", chatId: "7" },
				delivery: { rawSamples: false, maxPendingEvents: 20 },
				authorizationRef: null,
			},
			differences: ["run_text", "agent_fixed", "label_derived"],
			cutoverBlockers: ["event_contents", "stricter_ingress", "legacy_event_ids", "binding_adoption"],
			binding: {
				key: "w-1",
				callbackPath: "/mcp/events/o_ada/w-1",
				providerSubscriptionId: "sub_1",
				secret: "kept_in_watch",
				cursor: "kept",
				refreshBefore: NOW + HOUR,
				legacyOperationId: "event:w-1:<eventId>",
			},
		});
		const text = JSON.stringify(item);
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("whsec_");
		expect(text).not.toContain("cursor-value-9");
		expect(mapWatch(watch({ cursor: null }), context())).toMatchObject({ binding: { cursor: "none" } });
		expect(legacyEventOperationId("w-1", "evt_7")).toBe("event:w-1:evt_7");
	});

	it("reports what it can't represent, with the reason and never a value", () => {
		const cases: [string, PlanItem, string][] = [
			["interval", mapSchedule(schedule({ type: "interval", time: NOW / 1000 + 60, intervalSeconds: 600 }), context()), "interval_schedule"],
			["one-time, due now", mapSchedule(schedule({ time: NOW / 1000 }), context()), "one_time_due"],
			["one-time, overdue", mapSchedule(schedule({ time: NOW / 1000 - 1 }), context()), "one_time_due"],
			["cron with a name", mapSchedule(schedule({ type: "cron", cron: "0 9 * * MON" }), context()), "cron_syntax"],
			["cron macro", mapSchedule(schedule({ type: "cron", cron: "@daily" }), context()), "cron_syntax"],
			["cron with seconds", mapSchedule(schedule({ type: "cron", cron: "0 0 9 * * *" }), context()), "cron_syntax"],
			["cron step from a value", mapSchedule(schedule({ type: "cron", cron: "5/15 * * * *" }), context()), "cron_semantics"],
			["cron */2 days and a weekday", mapSchedule(schedule({ type: "cron", cron: "0 9 */2 * 5" }), context()), "cron_semantics"],
			["cron 1-31 days and a weekday", mapSchedule(schedule({ type: "cron", cron: "0 9 1-31 * 5" }), context()), "cron_semantics"],
			["deleted chat", mapSchedule(schedule({ payload: { session: "gone", instruction: "Check." } }), context()), "chat_unavailable"],
			["label too long", mapSchedule(schedule({ payload: { session: "7", instruction: "Check.", label: "l".repeat(121) } }), context()), "invalid_field"],
			["instruction too long", mapSchedule(schedule({ payload: { session: "7", instruction: "i".repeat(10_001), label: "Long" } }), context()), "invalid_field"],
			["ended watch", mapWatch(watch({ status: "ended" }), context()), "watch_ended"],
			["pending watch", mapWatch(watch({ status: "pending" }), context()), "watch_not_subscribed"],
			["watch without a subscription id", mapWatch(watch({ remoteId: null }), context()), "watch_not_subscribed"],
			["watch on another origin", mapWatch(watch({ url: "https://old.pim.test/mcp/events/o_ada/w-1" }), context()), "callback_changed"],
			["watch with no known origin", mapWatch(watch(), context({ publicUrl: null })), "callback_changed"],
			["watch on a deleted chat", mapWatch(watch({ session: "gone" }), context()), "chat_unavailable"],
			["watch with arguments past 4 KB", mapWatch(watch({ arguments: { note: "a".repeat(5_000) } }), context()), "invalid_field"],
		];
		for (const [name, item, reason] of cases) {
			expect({ name, status: item.status, reason: item.status === "unsupported" ? item.reason : null }).toEqual({ name, status: "unsupported", reason });
		}
		const tooLong = cases[11]![1];
		expect(tooLong.status === "unsupported" && tooLong.detail).toBe("spec.instruction can't be kept as it is");
	});

	it("takes cron expressions both read the same way, and compares the day fields on every day", () => {
		for (const same of ["*/15 * * * *", "0 9 * * 1-5", "0 9 13 * 5", "0 0 1 * *", "0 9 * * 0,7", "0 9 1-5/2 * *", "0 9 */2 * *"]) expect({ same, problem: cronMismatch(same) }).toEqual({ same, problem: null });
		// Both restricted the same way in both readings: a day matches either field.
		expect(cronMismatch("0 9 1,15 * 1")).toBeNull();
		// Triggers read */1 as unrestricted, as the SDK does with all 31 days.
		expect(cronMismatch("0 9 */1 * 5")).toBeNull();
	});

	it("plans the same way whatever order it reads things in, and lists records whose item is gone", () => {
		const schedules = [schedule({ id: "b" }), schedule({ id: "a", type: "cron", cron: "0 9 * * *" })];
		const watches = [watch({ id: "w-2", url: "https://pim.test/mcp/events/o_ada/w-2" }), watch()];
		const orphan: MigrationRecord = { kind: "schedule", legacyId: "fired", attempt: 1, triggerId: "legacy:schedule:fired:1", owner: "legacy", phase: "shadow", createdAt: NOW, updatedAt: NOW };
		const plan = planMigration({ schedules, watches, records: [orphan] }, context());
		expect(planMigration({ schedules: [...schedules].reverse(), watches: [...watches].reverse(), records: [orphan] }, context())).toEqual(plan);
		expect(plan.items.map((item) => `${item.kind}:${item.legacyId}`)).toEqual(["schedule:a", "schedule:b", "watch:w-1", "watch:w-2"]);
		expect(plan.orphans).toEqual([orphan]);
	});
});

// In a real space.

const space = () => env.Pim.getByName(OWNER);
const inSpace = <T>(work: (pim: Pim) => T | Promise<T>) => runInDurableObject(space(), work);
const sqlOf = (pim: Pim) => (pim as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
const stateOf = (pim: Pim) => (pim as unknown as { ctx: DurableObjectState }).ctx;
const engineOf = (pim: Pim): TriggerEngine => pim.triggerEngine()!;
const clock = () => Date.now() + triggerClock.offset;

/** Runs `work` with the migration's gate set on this space's env, as no deployment sets it. */
async function gated<T>(pim: Pim, work: () => T | Promise<T>): Promise<T> {
	const own = (pim as unknown as { env: Record<string, unknown> }).env;
	own[MIGRATION_VARIABLE] = "internal";
	try {
		expect(migrationAllowed(own)).toBe(true);
		return await work();
	} finally {
		delete own[MIGRATION_VARIABLE];
	}
}

/** Every row of every table of the space, for telling that nothing was written. */
function snapshot(pim: Pim): string {
	const sql = sqlOf(pim);
	const tables = sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
		.toArray()
		.map((row) => String(row.name));
	return JSON.stringify(tables.map((table) => [table, sql.exec(`SELECT * FROM ${table}`).toArray()]));
}

/** The space's root chat, by its own id. */
const root = (pim: Pim) => pim.store.sessionOf(ROOT)!;

/** A one-time schedule, as schedule_task makes it, an hour from the triggers' clock. */
async function oneTime(pim: Pim, chat: string, instruction = "Check the fare.") {
	return pim.schedule(new Date(clock() + HOUR), "runScheduledTask", { session: chat, instruction, label: "Fare check" });
}

/** A watch, as watch_connector_event leaves it once the connector answered its subscribe. */
function addWatch(pim: Pim, chat: string): AppWatch {
	const id = crypto.randomUUID();
	pim.store.addWatch({ id, serverId: "travel", event: "flight.price_changed", arguments: { route: "JFK-LIS" }, instruction: "Tell me if it drops.", session: chat, secret: newSecret(), url: `https://pim.test/mcp/events/${OWNER}/${id}` });
	pim.store.updateWatch(id, { status: "active", remoteId: "sub_travel_1", cursor: "cursor-41-kept", refreshBefore: Date.now() + HOUR });
	return pim.store.watch(id)!;
}

/** Delivers a signed event to a watch's own callback, as its connector would. */
async function deliver(watchId: string, secret: string, eventId: string) {
	const raw = JSON.stringify({ eventId, name: "flight.price_changed", timestamp: "2026-11-08T12:00:00Z", data: { price: 480 }, cursor: "c-42" });
	const timestamp = String(Math.floor(Date.now() / 1000));
	return exports.default.fetch(url(`/mcp/events/${OWNER}/${watchId}`), {
		method: "POST",
		headers: { "content-type": "application/json", "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": await signWebhook(secret, eventId, timestamp, raw), "X-MCP-Subscription-Id": "sub_travel_1" },
		body: raw,
	});
}

/** pi's records of inputs to a chat whose key contains `key`. */
const submissions = (pim: Pim, chat: string, key: string) =>
	sqlOf(pim)
		.exec("SELECT request_id FROM pi_submissions WHERE conversation_id = ? AND instr(request_id, ?) > 0", Number(chat), key)
		.toArray()
		.map((row) => JSON.parse(String(row.request_id)) as string);

/** Leaves the space as each test found it: no schedules, watches, migration records or triggers of these tests, and the clock as it is. */
async function cleanUp() {
	triggerClock.offset = 0;
	await inSpace(async (pim) => {
		for (const scheduled of await pim.listSchedules()) if (scheduled.callback === "runScheduledTask") await pim.cancelSchedule(scheduled.id);
		for (const kept of pim.store.watches()) pim.store.deleteWatch(kept.id);
		const engine = pim.triggerEngine();
		if (engine) {
			pim.rollbackTriggerMigration();
			for (const trigger of engine.store.list()) engine.store.remove({ id: trigger.id });
		}
		if (sqlOf(pim).exec("SELECT 1 FROM sqlite_master WHERE name = 'pim_trigger_migrations'").toArray().length > 0) sqlOf(pim).exec("DELETE FROM pim_trigger_migrations");
	});
	await vi.waitFor(() => expect(faux.getPendingResponseCount()).toBe(0));
}

describe("the migration in a space", () => {
	afterEach(cleanUp);

	it("previews without writing anything, with the engine off or on, and without any secret", async () => {
		await inSpace(async (pim) => {
			const chat = root(pim);
			const scheduled = await oneTime(pim, chat);
			const kept = addWatch(pim, chat);
			expect(pim.triggerEngine()).toBeNull();
			const before = snapshot(pim);
			// This space's majordomo was never made: the preview says so, and doesn't make it.
			const unmade = await pim.previewTriggerMigration();
			expect(snapshot(pim)).toBe(before);
			expect(unmade.items.map((item) => (item.status === "unsupported" ? item.reason : item.status))).toEqual(["agent_unavailable", "agent_unavailable"]);
			pim.agents.majordomo();
			const made = snapshot(pim);
			const plan = await pim.previewTriggerMigration();
			expect(snapshot(pim)).toBe(made);
			expect(sqlOf(pim).exec("SELECT name FROM sqlite_master WHERE name LIKE 'pim_trigger%'").toArray()).toEqual([]);
			expect(plan.items.map((item) => [item.kind, item.legacyId, item.status])).toEqual([
				["schedule", scheduled.id, "migratable"],
				["watch", kept.id, "migratable"],
			]);
			const text = JSON.stringify(plan);
			expect(text).not.toContain(kept.secret);
			expect(text).not.toContain("cursor-41-kept");

			await pim.enableTriggerEngine();
			engineOf(pim);
			const on = snapshot(pim);
			expect(await pim.previewTriggerMigration()).toEqual(plan);
			expect(snapshot(pim)).toBe(on);
			await pim.disableTriggerEngine();
		});
	});

	it("applies nothing where the gate is off or the engine isn't on", async () => {
		await inSpace(async (pim) => {
			await oneTime(pim, root(pim));
			expect(await pim.applyTriggerMigration()).toBeNull();
			expect(await gated(pim, () => pim.applyTriggerMigration())).toBeNull();
			await pim.enableTriggerEngine();
			expect(await pim.applyTriggerMigration()).toBeNull();
			expect(pim.rollbackTriggerMigration()).toBeNull();
			expect(sqlOf(pim).exec("SELECT name FROM sqlite_master WHERE name = 'pim_trigger_migrations'").toArray()).toEqual([]);
			await pim.disableTriggerEngine();
		});
	});

	it("makes each shadow once, as a draft owned by its schedule or watch, however often it is applied", async () => {
		await inSpace(async (pim) => {
			const chat = root(pim);
			const scheduled = await oneTime(pim, chat);
			const daily = await pim.schedule("0 9 * * *", "runScheduledTask", { session: chat, instruction: "Write my brief.", label: "Brief", newChat: true });
			const kept = addWatch(pim, chat);
			await pim.enableTriggerEngine();
			const first = await gated(pim, () => pim.applyTriggerMigration());
			const [early, late] = [scheduled.id, daily.id].sort();
			expect(first).toEqual([
				{ kind: "schedule", legacyId: early, outcome: "created", triggerId: `legacy:schedule:${early}:1` },
				{ kind: "schedule", legacyId: late, outcome: "created", triggerId: `legacy:schedule:${late}:1` },
				{ kind: "watch", legacyId: kept.id, outcome: "created", triggerId: `legacy:watch:${kept.id}:1` },
			]);
			const shadows = engineOf(pim)
				.store.list()
				.map((trigger) => [trigger.id, trigger.lifecycle, trigger.revision])
				.sort();
			expect(shadows).toEqual([`legacy:schedule:${early}:1`, `legacy:schedule:${late}:1`, `legacy:watch:${kept.id}:1`].map((id) => [id, "draft", 1]).sort());
			const daySpec = engineOf(pim).store.get(`legacy:schedule:${daily.id}:1`)!.spec;
			expect(daySpec.source).toEqual({ kind: "time", schedule: "cron", expression: "0 9 * * *", timeZone: "UTC", catchUpMs: 7 * DAY });
			expect(daySpec.destination).toEqual({ type: "new_chat" });

			const records = snapshot(pim);
			const again = await gated(pim, () => pim.applyTriggerMigration());
			expect(again!.map((item) => item.outcome)).toEqual(["already", "already", "already"]);
			expect(snapshot(pim)).toBe(records);
			// Every record names the legacy side as the owner.
			expect(sqlOf(pim).exec("SELECT DISTINCT owner, phase FROM pim_trigger_migrations").toArray()).toEqual([{ owner: "legacy", phase: "shadow" }]);
			await pim.disableTriggerEngine();
		});
	});

	it("leaves an item as it was when cut short at any step, and finishes it when applied again", async () => {
		await inSpace(async (pim) => {
			const chat = root(pim);
			await oneTime(pim, chat, "First.");
			await oneTime(pim, chat, "Second.");
			await pim.enableTriggerEngine();
			const engine = engineOf(pim);
			const plan = await pim.previewTriggerMigration();
			const [a, b] = plan.items;
			const transaction = <T>(work: () => T) => stateOf(pim).storage.transactionSync(work);
			const made = (store: Pick<TriggerStore, "create" | "get" | "remove">, failing?: { commit: boolean }) =>
				new TriggerMigration(sqlOf(pim), {
					store,
					transaction: failing ? <T>(work: () => T) => transaction(() => {
						const result = work();
						if (failing.commit) throw new Error("the database refused the commit");
						return result;
					}) : transaction,
					now: clock,
				});
			const ids = plan.items.map((item) => (item.status === "migratable" ? item.triggerId : ""));
			const triggerCount = () => ids.filter((id) => engine.store.get(id) !== undefined).length;
			const recordCount = () => Number(sqlOf(pim).exec("SELECT COUNT(*) AS n FROM pim_trigger_migrations").one().n);
			const cut = (when: "before" | "after", on?: string): Pick<TriggerStore, "create" | "get" | "remove"> => ({
				get: (id) => engine.store.get(id),
				remove: (input) => engine.store.remove(input),
				create: (input) => {
					if (on !== undefined && input.id !== on) return engine.store.create(input);
					if (when === "before") throw new Error("cut before the trigger");
					engine.store.create(input);
					throw new Error("cut after the trigger");
				},
			});

			// Cut after the record, before its trigger; after its trigger; and at the commit: nothing of it is left.
			expect(() => made(cut("before")).apply(plan)).toThrow("cut before the trigger");
			expect([recordCount(), triggerCount()]).toEqual([0, 0]);
			expect(() => made(cut("after")).apply(plan)).toThrow("cut after the trigger");
			expect([recordCount(), triggerCount()]).toEqual([0, 0]);
			expect(() => made(engine.store, { commit: true }).apply(plan)).toThrow("refused the commit");
			expect([recordCount(), triggerCount()]).toEqual([0, 0]);

			// Cut between items: the first stays done, and applying again does only the second.
			const second = b!.status === "migratable" ? b!.triggerId : "";
			expect(() => made(cut("before", second)).apply(plan)).toThrow("cut before the trigger");
			expect([recordCount(), triggerCount()]).toEqual([1, 1]);
			expect(made(engine.store).apply(plan).map((item) => item.outcome)).toEqual(["already", "created"]);
			expect([recordCount(), triggerCount()]).toEqual([2, 2]);
			expect(a!.status).toBe("migratable");
			await pim.disableTriggerEngine();
		});
	});

	it("never fires a due schedule twice: its alarm runs it once, its shadow never, across a restart and a second apply", async () => {
		await inSpace(async (pim) => {
			const chat = root(pim);
			const scheduled = await oneTime(pim, chat);
			await pim.enableTriggerEngine();
			const [applied] = (await gated(pim, () => pim.applyTriggerMigration()))!;
			const id = applied!.outcome === "created" ? applied!.triggerId : "";

			// The shadow's time comes and goes.
			triggerClock.offset = HOUR + MINUTE;
			await pim.runTriggerTick();
			expect(engineOf(pim).store.occurrences(id)).toEqual([]);
			expect(engineOf(pim).coordinator.runs(id)).toEqual([]);
			// Nothing enables it while the schedule owns it.
			expect(engineOf(pim).store.setLifecycle({ id, to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: false, reason: "owned_elsewhere" });

			// The schedule's alarm runs it, retried once, as one submission.
			faux.setResponses([fauxAssistantMessage("Checked.")]);
			await pim.runScheduledTask(scheduled.payload, scheduled);
			await pim.runScheduledTask(scheduled.payload, scheduled);
			await vi.waitFor(() => expect(faux.getPendingResponseCount()).toBe(0));
			expect(submissions(pim, chat, `schedule:${scheduled.id}:`)).toEqual([`schedule:${scheduled.id}:${scheduled.time}`]);

			// A restart builds the engine again; applying again changes nothing; the shadow still never fires.
			await pim.disableTriggerEngine();
			await pim.enableTriggerEngine();
			// Its time has passed, so it no longer maps; its shadow is kept as it was.
			expect((await gated(pim, () => pim.applyTriggerMigration()))!.find((item) => item.legacyId === scheduled.id)).toEqual({ kind: "schedule", legacyId: scheduled.id, outcome: "already", triggerId: id });
			await pim.runTriggerTick();
			expect(engineOf(pim).store.occurrences(id)).toEqual([]);
			expect(engineOf(pim).store.get(id)!.lifecycle).toBe("draft");
			expect(submissions(pim, chat, "trigger:")).toEqual([]);
			await pim.disableTriggerEngine();
		});
	});

	it("never takes a watch's event twice: its callback runs it once, its shadow refuses it", async () => {
		const { kept, chat, triggerId } = await inSpace(async (pim) => {
			const chat = root(pim);
			const kept = addWatch(pim, chat);
			await pim.enableTriggerEngine();
			const [applied] = (await gated(pim, () => pim.applyTriggerMigration()))!;
			return { kept, chat, triggerId: applied!.outcome === "created" ? applied!.triggerId : "" };
		});
		faux.setResponses([fauxAssistantMessage("Noted.")]);
		expect((await deliver(kept.id, kept.secret, "evt_1")).status).toBe(204);
		// The connector sends it again.
		expect((await deliver(kept.id, kept.secret, "evt_1")).status).toBe(204);
		await vi.waitFor(() => expect(faux.getPendingResponseCount()).toBe(0));
		await inSpace(async (pim) => {
			// One run, under the operation id a cutover must honor.
			expect(submissions(pim, chat, `event:${kept.id}:`)).toEqual([legacyEventOperationId(kept.id, "evt_1")]);
			// The watch is as it was but for what its own callback records; its secret and subscription are the same.
			expect(pim.store.watch(kept.id)).toMatchObject({ secret: kept.secret, remoteId: "sub_travel_1", cursor: "c-42", status: "active" });

			// The same delivery, were it routed to the shadow through the binding it would adopt, is refused before anything is read.
			const engine = engineOf(pim);
			const trigger = engine.store.get(triggerId)!;
			const ingress = new ConnectorIngress({
				store: engine.store,
				host: {
					owner: () => OWNER,
					subscription: (key) => (key === kept.id ? adoptedSubscription(pim.store.watch(key)!, { id: trigger.id, generation: trigger.generation, sourceRevision: engine.store.sourceState(trigger.id)!.sourceRevision }) : undefined),
					connector: () => "connected",
				},
				now: clock,
			});
			const raw = JSON.stringify({ eventId: "evt_1", name: "flight.price_changed", timestamp: "2026-11-08T12:00:00Z", data: { price: 480 } });
			const at = String(Math.floor(clock() / 1000));
			const request = new Request("https://pim.test/hook", {
				method: "POST",
				headers: { "content-type": "application/json", "webhook-id": "evt_1", "webhook-timestamp": at, "webhook-signature": await signWebhook(kept.secret, "evt_1", at, raw), "x-mcp-subscription-id": "sub_travel_1" },
				body: raw,
			});
			expect(await ingress.receive({ owner: OWNER, key: kept.id }, request)).toMatchObject({ disposition: "reject", reason: "not_enabled" });
			expect(engine.store.occurrences(triggerId)).toEqual([]);
			await pim.runTriggerTick();
			expect(submissions(pim, chat, "trigger:")).toEqual([]);
			await pim.disableTriggerEngine();
		});
	});

	it("rolls back to the schedule and watch, idempotently, and applies again as a new trigger", async () => {
		await inSpace(async (pim) => {
			const chat = root(pim);
			const scheduled = await oneTime(pim, chat);
			const kept = addWatch(pim, chat);
			await pim.enableTriggerEngine();
			await gated(pim, () => pim.applyTriggerMigration());
			const rolled = pim.rollbackTriggerMigration()!;
			expect(rolled.map((item) => [item.kind, item.outcome])).toEqual([
				["schedule", "rolled_back"],
				["watch", "rolled_back"],
			]);
			for (const item of rolled) expect(engineOf(pim).store.get(item.triggerId)!.lifecycle).toBe("deleted");
			expect(sqlOf(pim).exec("SELECT DISTINCT owner, phase FROM pim_trigger_migrations").toArray()).toEqual([{ owner: "legacy", phase: "rolled_back" }]);
			// The schedule and the watch are exactly as they were.
			expect((await pim.listSchedules()).filter((item) => item.id === scheduled.id)).toEqual([expect.objectContaining({ id: scheduled.id, type: scheduled.type, time: scheduled.time, payload: scheduled.payload })]);
			expect(pim.store.watch(kept.id)).toEqual(kept);
			expect(pim.rollbackTriggerMigration()!.map((item) => item.outcome)).toEqual(["already", "already"]);

			const again = (await gated(pim, () => pim.applyTriggerMigration()))!;
			expect(again).toEqual([
				{ kind: "schedule", legacyId: scheduled.id, outcome: "created", triggerId: `legacy:schedule:${scheduled.id}:2` },
				{ kind: "watch", legacyId: kept.id, outcome: "created", triggerId: `legacy:watch:${kept.id}:2` },
			]);
			expect(engineOf(pim).store.setLifecycle({ id: `legacy:watch:${kept.id}:2`, to: "enabled", expectedRevision: 1 })).toMatchObject({ ok: false, reason: "owned_elsewhere" });
			await pim.disableTriggerEngine();
		});
	});

	it("keeps its records in the export and what the space holds, with no secret, cursor or callback URL in them", async () => {
		await inSpace(async (pim) => {
			const chat = root(pim);
			const kept = addWatch(pim, chat);
			await oneTime(pim, chat);
			await pim.enableTriggerEngine();
			const outcomes = await gated(pim, () => pim.applyTriggerMigration());
			const exported = await pim.exportData();
			const records = JSON.parse(exported).triggers.pim_trigger_migrations as Record<string, unknown>[];
			expect(records).toHaveLength(2);
			expect(Object.keys(records[0]!).sort()).toEqual(["attempt", "created_at", "legacy_id", "legacy_kind", "owner", "phase", "trigger_id", "updated_at"]);
			for (const text of [exported, JSON.stringify(outcomes), JSON.stringify(sqlOf(pim).exec("SELECT * FROM pim_trigger_migrations").toArray())]) {
				expect(text).not.toContain(kept.secret);
			}
			expect(JSON.stringify(records)).not.toContain("cursor-41-kept");
			expect(JSON.stringify(records)).not.toContain(kept.url);
			expect(await pim.remainingData()).toContain("schedules and watches moved to triggers");
			await pim.disableTriggerEngine();
		});
	});
});

describe("adopting a watch's binding", () => {
	it("takes a delivery signed with the watch's own secret, to its own key and subscription, once per event id", async () => {
		await runInDurableObject(env.Pim.getByName(`adoption-${crypto.randomUUID()}`), async (_pim: Pim, state) => {
			let now = NOW;
			const store = new TriggerStore(state.storage.sql, { transaction: (work) => state.storage.transactionSync(work), now: () => now });
			const kept = watch({ secret: newSecret() });
			const plan = mapWatch(kept, context());
			if (plan.status !== "migratable") throw new Error(plan.reason);
			// A store with nothing else delivering this work, as one after a cutover would be.
			const created = store.create({ id: plan.triggerId, spec: plan.spec, lifecycle: "enabled" });
			if (!created.ok) throw new Error(created.reason);
			const binding = adoptedSubscription(kept, { id: plan.triggerId, generation: created.trigger.generation, sourceRevision: store.sourceState(plan.triggerId)!.sourceRevision });
			expect(binding).toEqual({ key: "w-1", triggerId: plan.triggerId, sourceRevision: 1, generation: created.trigger.generation, connectorId: "travel", event: "flight.price_changed", providerSubscriptionId: "sub_1", secret: kept.secret, status: "active" });
			const ingress = new ConnectorIngress({ store, host: { owner: () => "o_ada", subscription: (key) => (key === binding.key ? binding : undefined), connector: () => "connected" }, now: () => now });
			const send = async () => {
				const raw = JSON.stringify({ eventId: "evt_9", name: "flight.price_changed", timestamp: new Date(now).toISOString(), data: { price: 470 }, cursor: "c-43" });
				const at = String(Math.floor(now / 1000));
				return ingress.receive(
					{ owner: "o_ada", key: "w-1" },
					new Request("https://pim.test/hook", {
						method: "POST",
						headers: { "content-type": "application/json", "webhook-id": "evt_9", "webhook-timestamp": at, "webhook-signature": await signWebhook(kept.secret, "evt_9", at, raw), "x-mcp-subscription-id": "sub_1" },
						body: raw,
					}),
				);
			};
			expect(await send()).toMatchObject({ disposition: "accepted", reason: "admitted" });
			now += MINUTE;
			expect(await send()).toMatchObject({ disposition: "accepted", reason: "duplicate" });
			// Its occurrence is keyed by the trigger's source, not the watch's operation id: why `legacy_event_ids` blocks a cutover.
			expect(store.occurrences(plan.triggerId).map((occurrence) => occurrence.key)).toEqual([`event:${plan.triggerId}#1:evt_9`]);
		});
	});
});
