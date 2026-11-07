import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signWebhook } from "../src/extensions/app-events";
import type { Pim } from "../src/pim";
import { type ConnectorStatus, ConnectorIngress, EFFECT_DEADLINE_MS, RENEW_MARGIN_MS } from "../src/triggers/connector";
import { TriggerCoordinator } from "../src/triggers/coordinator";
import { triggerHistory } from "../src/triggers/engine";
import { TriggerStore } from "../src/triggers/store";
import {
	ConnectorSubscriptionManager,
	type ProviderAnswer,
	type ProviderGrant,
	SUBSCRIPTION_TTL_MS,
	type SubscribeRequest,
	type SubscriptionManagerOptions,
	type UnsubscribeRequest,
} from "../src/triggers/subscriptions";

// The subscription manager on a Durable Object's database of its own, with a fake connector: no MCP bridge, route or network is involved.

const START = 1_800_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OWNER = "o_ada";
const EVENT = "flight.price_changed";
const ORIGIN = "https://pim.test/triggers/events";

/** What the fake connector does with the next request: answer, refuse with a code, throw, never answer, or do it and then lose the answer. */
type Behavior = "ok" | { code: number } | "throw" | "hang" | "ok_then_hang" | "ok_then_throw" | { gate: Promise<void> } | { refreshBefore: unknown };

/**
 * A connector that keeps subscriptions by callback URL, as the draft MCP
 * Events extension does: subscribing the same URL again is the same
 * subscription. It counts every subscription it ever made, so a second
 * one for a binding shows.
 */
class FakeConnector {
	readonly subscriptions = new Map<string, { id: string; name: string; arguments: unknown; secret: string; refreshBefore: unknown }>();
	readonly requests: { kind: "subscribe" | "unsubscribe"; request: SubscribeRequest | UnsubscribeRequest }[] = [];
	readonly statuses = new Map<string, ConnectorStatus>([["travel", "connected"]]);
	readonly script: Behavior[] = [];
	/** What a grant's `refreshBefore` is, given the clock. */
	refreshBefore: (now: number) => unknown = (now) => new Date(now + HOUR).toISOString();
	made = 0;
	/** Called after a subscription is made and before the answer, to cut the step there. */
	afterEffect: () => void = () => undefined;

	constructor(readonly clock: { now: number }) {}

	connector(connectorId: string): ConnectorStatus {
		return this.statuses.get(connectorId) ?? "removed";
	}

	async subscribe(request: SubscribeRequest, _signal: AbortSignal): Promise<ProviderAnswer<ProviderGrant>> {
		this.requests.push({ kind: "subscribe", request });
		const behavior = this.script.shift() ?? "ok";
		if (typeof behavior === "object" && "code" in behavior) return { ok: false, code: behavior.code };
		if (behavior === "throw") throw new Error(`connection reset while posting to ${request.delivery.url} with ${request.delivery.secret}`);
		if (behavior === "hang") return new Promise(() => undefined);
		if (typeof behavior === "object" && "gate" in behavior) await behavior.gate;
		const existing = this.subscriptions.get(request.delivery.url);
		const id = existing?.id ?? `sub_${++this.made}`;
		const refreshBefore = typeof behavior === "object" && "refreshBefore" in behavior ? behavior.refreshBefore : this.refreshBefore(this.clock.now);
		this.subscriptions.set(request.delivery.url, { id, name: request.name, arguments: request.arguments, secret: request.delivery.secret, refreshBefore });
		this.afterEffect();
		if (behavior === "ok_then_hang") return new Promise(() => undefined);
		if (behavior === "ok_then_throw") throw new Error(`lost the answer for ${request.delivery.url}`);
		return { ok: true, value: refreshBefore === undefined ? { id } : { id, refreshBefore } };
	}

	async unsubscribe(request: UnsubscribeRequest, _signal: AbortSignal): Promise<ProviderAnswer<unknown>> {
		this.requests.push({ kind: "unsubscribe", request });
		const behavior = this.script.shift() ?? "ok";
		if (typeof behavior === "object" && "code" in behavior) return { ok: false, code: behavior.code };
		if (behavior === "throw") throw new Error(`connection reset while posting to ${request.delivery.url}`);
		if (behavior === "hang") return new Promise(() => undefined);
		if (typeof behavior === "object" && "gate" in behavior) await behavior.gate;
		this.subscriptions.delete(request.delivery.url);
		if (behavior === "ok_then_hang") return new Promise(() => undefined);
		return { ok: true, value: {} };
	}

	count(kind: "subscribe" | "unsubscribe"): number {
		return this.requests.filter((entry) => entry.kind === kind).length;
	}

	last(kind: "subscribe" | "unsubscribe") {
		return this.requests.filter((entry) => entry.kind === kind).at(-1)?.request;
	}
}

/** Request deadlines that pass only when the test says. */
class FakeTimers {
	readonly #pending = new Set<() => void>();
	sleep = (_ms: number, signal: AbortSignal): Promise<void> =>
		new Promise((resolve) => {
			const fire = () => {
				this.#pending.delete(fire);
				resolve();
			};
			this.#pending.add(fire);
			signal.addEventListener("abort", fire);
		});
	expire(): void {
		for (const fire of [...this.#pending]) fire();
	}
}

type Context = {
	sql: SqlStorage;
	clock: { now: number };
	store: TriggerStore;
	manager: ConnectorSubscriptionManager;
	connector: FakeConnector;
	timers: FakeTimers;
	/** Makes the next transactions throw before they commit. */
	failing: { transactions: boolean };
	transaction: <T>(work: () => T) => T;
	/** A new manager on the same database and connector, as after the Durable Object restarts. */
	restart: (options?: Partial<SubscriptionManagerOptions>) => ConnectorSubscriptionManager;
	/** Makes an enabled trigger on the connector's event, or as `spec` says. */
	trigger: (over?: Record<string, unknown>, lifecycle?: "draft" | "enabled") => string;
	count: (table: string) => number;
};

const base = { version: 1, owningAgentId: "agent-1", originChatId: "chat-1", label: "Fares", instruction: "Tell me about cheap fares.", destination: { type: "existing_chat", chatId: "chat-1" } };
const source = (over: Record<string, unknown> = {}) => ({ kind: "connector_event", connectorId: "travel", event: EVENT, arguments: { route: "JFK-LIS" }, ...over });
const url = (key: string) => `${ORIGIN}/${OWNER}/${key}`;

async function withManager(work: (context: Context) => Promise<void>, options: Partial<SubscriptionManagerOptions> = {}): Promise<void> {
	await runInDurableObject(env.Pim.getByName(`subscriptions-${crypto.randomUUID()}`), async (_pim: Pim, state) => {
		const clock = { now: START };
		const failing = { transactions: false };
		const transaction = <T>(run: () => T): T =>
			state.storage.transactionSync(() => {
				const result = run();
				if (failing.transactions) throw new Error("the database refused the commit");
				return result;
			});
		const store = new TriggerStore(state.storage.sql, { transaction, now: () => clock.now });
		const connector = new FakeConnector(clock);
		const timers = new FakeTimers();
		const restart = (more: Partial<SubscriptionManagerOptions> = {}) =>
			new ConnectorSubscriptionManager(state.storage.sql, {
				store,
				provider: connector,
				transaction,
				now: () => clock.now,
				owner: () => OWNER,
				callbackUrl: ({ owner, key }) => `${ORIGIN}/${owner}/${key}`,
				sleep: timers.sleep,
				...options,
				...more,
			});
		const trigger = (over: Record<string, unknown> = {}, lifecycle: "draft" | "enabled" = "enabled") => {
			const created = store.create({ spec: { ...base, source: source(), ...over }, lifecycle });
			if (!created.ok) throw new Error(created.reason);
			return created.trigger.id;
		};
		await work({
			sql: state.storage.sql,
			clock,
			store,
			manager: restart(),
			connector,
			timers,
			failing,
			transaction,
			restart,
			trigger,
			count: (table) => Number(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n),
		});
	});
}

/** Lets the tick's awaits run, without moving the clock. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const iso = (ms: number) => new Date(ms).toISOString();

describe("keeping connector events' subscriptions (an inert manager)", () => {
	it("subscribes an enabled trigger once, with a key and secret of its own, and its binding admits the connector's signed events", async () => {
		await withManager(async ({ manager, connector, store, trigger, clock, sql }) => {
			const id = trigger();
			const draft = trigger({ label: "Draft" }, "draft");
			trigger({ label: "Daily", source: { kind: "time", schedule: "interval", everyMs: HOUR, anchorAt: START, catchUpMs: MINUTE } });

			const report = await manager.tick();
			expect(report.planned).toEqual([id]);
			expect(report.subscribed).toEqual([id]);
			expect(connector.count("subscribe")).toBe(1);
			const [binding] = manager.bindings(id);
			expect(binding).toMatchObject({ triggerId: id, generation: 1, sourceRevision: 1, connectorId: "travel", event: EVENT, status: "active", phase: "open", providerSubscriptionId: "sub_1", failures: 0, lastError: null, intent: null });
			expect(binding!.grant).toEqual({ providerSubscriptionId: "sub_1", refreshBefore: START + HOUR, grantedAt: START });
			// What the connector was asked, as app-events.ts asks it: the binding's own URL and a fresh secret.
			const request = connector.last("subscribe") as SubscribeRequest;
			expect(request).toEqual({
				connectorId: "travel",
				name: EVENT,
				arguments: { route: "JFK-LIS" },
				delivery: { mode: "webhook", url: url(binding!.key), secret: expect.stringMatching(/^whsec_/) },
				cursor: null,
				ttlMs: SUBSCRIPTION_TTL_MS,
			});
			expect(manager.subscription(binding!.key)).toMatchObject({ status: "active", providerSubscriptionId: "sub_1", secret: request.delivery.secret });
			expect(manager.bindings(draft)).toEqual([]);
			expect(report.nextWakeAt).toBe(START + HOUR - RENEW_MARGIN_MS);

			// Ticking again asks nothing until the renewal is due.
			for (const at of [START, START + 30 * MINUTE, START + HOUR - RENEW_MARGIN_MS - 1]) {
				clock.now = at;
				await manager.tick();
			}
			expect(connector.count("subscribe")).toBe(1);
			expect(manager.bindings(id)).toHaveLength(1);

			// The ingress adapter takes the connector's delivery through the binding, as the callback's route names it.
			clock.now = START + MINUTE;
			const ingress = new ConnectorIngress({ store, host: manager.ingressHost(), now: () => clock.now });
			const body = JSON.stringify({ eventId: "evt_1", name: EVENT, timestamp: iso(clock.now - SECOND), data: { route: "JFK-LIS", price: 480 }, cursor: "c-1" });
			const at = String(Math.floor(clock.now / 1000));
			const headers = new Headers({
				"content-type": "application/json",
				"webhook-id": "evt_1",
				"webhook-timestamp": at,
				"webhook-signature": await signWebhook(request.delivery.secret, "evt_1", at, body),
				"x-mcp-subscription-id": "sub_1",
			});
			expect(await ingress.receive({ owner: OWNER, key: binding!.key }, new Request("https://pim.test/hook", { method: "POST", headers, body }))).toMatchObject({ reason: "admitted" });
			expect(store.outbox(id)).toHaveLength(1);
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM pim_trigger_subscriptions").one().n)).toBe(1);
		});
	});

	it("renews before the grant runs out with the same URL, secret and intent of a binding, and checks a grant without expiry daily", async () => {
		await withManager(async ({ manager, connector, trigger, clock, store }) => {
			const id = trigger();
			await manager.tick();
			const first = connector.last("subscribe") as SubscribeRequest;
			const [binding] = manager.bindings(id);

			// An admitted event's cursor is what a renewal resumes from.
			store.admit({ id, generation: 1, eventId: "evt_1", observedAt: START, payload: {}, checkpoint: { position: 1, cursor: "cursor-7" } });
			clock.now = START + HOUR - RENEW_MARGIN_MS;
			const renewed = await manager.tick();
			expect(renewed.subscribed).toEqual([id]);
			const second = connector.last("subscribe") as SubscribeRequest;
			expect(second).toEqual({ ...first, cursor: "cursor-7" });
			expect(connector.made).toBe(1);
			expect(manager.bindings(id)).toMatchObject([{ key: binding!.key, providerSubscriptionId: "sub_1", grant: { refreshBefore: clock.now + HOUR, grantedAt: clock.now } }]);
			expect(renewed.nextWakeAt).toBe(clock.now + HOUR - RENEW_MARGIN_MS);

			// A grant with no expiry is checked a day after it was granted.
			connector.script.push({ refreshBefore: null });
			clock.now += HOUR - RENEW_MARGIN_MS;
			const daily = await manager.tick();
			expect(daily.nextWakeAt).toBe(clock.now + DAY);
			clock.now += DAY - 1;
			await manager.tick();
			expect(connector.count("subscribe")).toBe(3);
			clock.now += 1;
			await manager.tick();
			expect(connector.count("subscribe")).toBe(4);

			// No `refreshBefore`, or one that can't be read, is the hour asked for; one already past is renewed 30 seconds on, not at once.
			connector.script.push({ refreshBefore: undefined });
			clock.now += HOUR;
			await manager.tick();
			expect(manager.bindings(id)[0]!.grant).toMatchObject({ refreshBefore: clock.now + SUBSCRIPTION_TTL_MS });
			connector.script.push({ refreshBefore: "soon" }, { refreshBefore: iso(clock.now - MINUTE) });
			clock.now += HOUR;
			await manager.tick();
			expect(manager.bindings(id)[0]!.grant).toMatchObject({ refreshBefore: clock.now + SUBSCRIPTION_TTL_MS });
			clock.now += HOUR;
			const past = await manager.tick();
			expect(past.nextWakeAt).toBe(clock.now + 30 * SECOND);
			const before = connector.count("subscribe");
			await manager.tick();
			expect(connector.count("subscribe")).toBe(before);
			clock.now += 30 * SECOND;
			await manager.tick();
			expect(connector.count("subscribe")).toBe(before + 1);
			expect(connector.made).toBe(1);
			expect(new Set(connector.requests.map(({ request }) => request.delivery.url))).toEqual(new Set([url(binding!.key)]));
		});
	});

	it("sends the same request again, never a new subscription, when it was cut short after the intent, after the effect, or before the receipt", async () => {
		// Cut after the intent was recorded, before the connector did anything.
		await withManager(async ({ manager, connector, trigger, clock, restart }) => {
			const id = trigger();
			connector.script.push("hang");
			void manager.tick();
			await settle();
			expect(connector.count("subscribe")).toBe(1);
			expect(connector.subscriptions.size).toBe(0);
			const intent = manager.bindings(id)[0]!.intent!;
			expect(intent).toMatchObject({ kind: "subscribe", state: "sending", sentAt: START });

			// Restarted before the intent's deadline: nothing is sent, since the first request may still be answered.
			const again = restart();
			expect((await again.tick()).nextWakeAt).toBe(START + EFFECT_DEADLINE_MS);
			expect(connector.count("subscribe")).toBe(1);
			clock.now = START + EFFECT_DEADLINE_MS;
			await again.tick();
			expect(connector.count("subscribe")).toBe(2);
			expect(connector.requests[1]).toEqual(connector.requests[0]);
			expect(again.bindings(id)).toMatchObject([{ providerSubscriptionId: "sub_1", intent: null, phase: "open" }]);
			expect(connector.made).toBe(1);
		});

		// Cut after the connector made the subscription, with its answer lost.
		await withManager(async ({ manager, connector, trigger, clock, restart, timers }) => {
			const id = trigger();
			connector.script.push("ok_then_hang");
			void manager.tick();
			await settle();
			expect(connector.subscriptions.size).toBe(1);
			expect(manager.bindings(id)[0]).toMatchObject({ providerSubscriptionId: null, intent: { state: "sending" } });
			clock.now = START + EFFECT_DEADLINE_MS;
			const again = restart();
			await again.tick();
			expect(connector.made).toBe(1);
			expect(connector.requests[1]).toEqual(connector.requests[0]);
			const settled = again.bindings(id);
			expect(settled).toMatchObject([{ providerSubscriptionId: "sub_1", intent: null }]);
			// The first request's deadline passing later changes nothing: its intent was settled by the second.
			timers.expire();
			await settle();
			expect(again.bindings(id)).toEqual(settled);
		});

		// Cut when the receipt's transaction didn't commit.
		await withManager(async ({ manager, connector, trigger, clock, failing }) => {
			const id = trigger();
			connector.afterEffect = () => {
				failing.transactions = true;
			};
			const report = await manager.tick();
			expect(report.unknown).toEqual([id]);
			failing.transactions = false;
			connector.afterEffect = () => undefined;
			expect(manager.bindings(id)[0]).toMatchObject({ providerSubscriptionId: null, intent: { state: "sending" } });
			await manager.tick();
			expect(connector.count("subscribe")).toBe(1);
			clock.now = START + EFFECT_DEADLINE_MS;
			await manager.tick();
			expect(connector.count("subscribe")).toBe(2);
			expect(connector.made).toBe(1);
			expect(manager.bindings(id)).toMatchObject([{ providerSubscriptionId: "sub_1", intent: null, failures: 0 }]);
		});

		// No answer by the deadline, or a throw: unknown, sent again the same after a backoff.
		await withManager(async ({ manager, connector, trigger, clock, timers }) => {
			const id = trigger();
			connector.script.push("hang", "ok_then_throw");
			const pending = manager.tick();
			await settle();
			timers.expire();
			expect((await pending).unknown).toEqual([id]);
			const [binding] = manager.bindings(id);
			expect(binding).toMatchObject({ intent: { state: "unknown" }, failures: 1, lastError: "no_answer", nextAt: START + 30 * SECOND });
			clock.now = START + 30 * SECOND - 1;
			await manager.tick();
			expect(connector.count("subscribe")).toBe(1);
			clock.now = START + 30 * SECOND;
			expect((await manager.tick()).unknown).toEqual([id]);
			expect(manager.bindings(id)[0]).toMatchObject({ intent: { intentId: binding!.intent!.intentId, state: "unknown" }, failures: 2, nextAt: clock.now + MINUTE });
			clock.now += MINUTE;
			await manager.tick();
			expect(manager.bindings(id)[0]).toMatchObject({ providerSubscriptionId: "sub_1", intent: null, failures: 0, lastError: null });
			expect(connector.count("subscribe")).toBe(3);
			expect(new Set(connector.requests.map((entry) => JSON.stringify(entry.request))).size).toBe(1);
			expect(connector.made).toBe(1);
		});
	});

	it("unsubscribes when a trigger is paused, edited or deleted, and binds it anew when enabled again", async () => {
		await withManager(async ({ manager, connector, trigger, clock, store }) => {
			const id = trigger();
			await manager.tick();
			const [first] = manager.bindings(id);
			const ingress = new ConnectorIngress({ store, host: manager.ingressHost(), now: () => clock.now });
			const deliver = (key: string) => ingress.receive({ owner: OWNER, key }, new Request("https://pim.test/hook", { method: "POST", headers: { "x-mcp-subscription-id": "sub_1" }, body: "{}" }));

			// Paused: revoked at once, then unsubscribed with the same URL; its secret is wiped.
			clock.now += MINUTE;
			store.setLifecycle({ id, to: "paused" });
			const paused = await manager.tick();
			expect(paused.revoked).toContain(id);
			expect(paused.unsubscribed).toEqual([id]);
			expect(connector.last("unsubscribe")).toEqual({ connectorId: "travel", name: EVENT, arguments: { route: "JFK-LIS" }, delivery: { url: url(first!.key) } });
			expect(connector.subscriptions.size).toBe(0);
			expect(manager.bindings(id)).toMatchObject([{ key: first!.key, status: "revoked", phase: "ended", intent: null, nextAt: null }]);
			expect(manager.subscription(first!.key)).toMatchObject({ status: "revoked", secret: "" });
			expect(await deliver(first!.key)).toMatchObject({ disposition: "reject", reason: "revoked", status: 410 });
			expect((await manager.tick()).nextWakeAt).toBeNull();

			// Enabled again: a new generation, so a new binding with its own key and secret.
			clock.now += MINUTE;
			store.setLifecycle({ id, to: "enabled", expectedRevision: 1 });
			await manager.tick();
			const second = manager.bindings(id)[1]!;
			expect(second).toMatchObject({ generation: 3, status: "active", providerSubscriptionId: "sub_2" });
			expect(second.key).not.toBe(first!.key);
			expect((connector.last("subscribe") as SubscribeRequest).delivery.secret).not.toBe((connector.requests[0]!.request as SubscribeRequest).delivery.secret);

			// A new label keeps the binding; a new source ends it and binds the new one.
			store.update({ id, expectedRevision: 1, spec: { ...base, label: "Fares to Lisbon", source: source() } });
			const relabelled = await manager.tick();
			expect(relabelled).toMatchObject({ planned: [], revoked: [], subscribed: [], unsubscribed: [] });
			store.update({ id, expectedRevision: 2, spec: { ...base, source: source({ arguments: { route: "JFK-OPO" } }) } });
			const edited = await manager.tick();
			expect(edited.unsubscribed).toEqual([id]);
			expect(edited.subscribed).toEqual([id]);
			const third = manager.bindings(id)[2]!;
			expect(third).toMatchObject({ sourceRevision: 3, generation: 4, status: "active" });
			expect(connector.last("subscribe")).toMatchObject({ arguments: { route: "JFK-OPO" }, delivery: { url: url(third.key) } });
			expect([...connector.subscriptions.keys()]).toEqual([url(third.key)]);

			// Deleted: unsubscribed, and never bound again.
			store.remove({ id });
			const removed = await manager.tick();
			expect(removed.unsubscribed).toEqual([id]);
			expect(connector.subscriptions.size).toBe(0);
			expect(manager.bindings(id).map((binding) => binding.phase)).toEqual(["ended", "ended", "ended"]);
			expect((await manager.tick()).nextWakeAt).toBeNull();
			expect(connector.made).toBe(3);
		});
	});

	it("undoes a subscribe whose answer is unknown once the trigger is paused, and lets a lapsed grant go without asking", async () => {
		await withManager(async ({ manager, connector, trigger, clock, store, timers }) => {
			const id = trigger();
			connector.script.push("ok_then_hang");
			const pending = manager.tick();
			await settle();
			store.setLifecycle({ id, to: "paused" });
			timers.expire();
			await pending;
			expect(manager.bindings(id)[0]).toMatchObject({ intent: { kind: "subscribe", state: "unknown" } });
			clock.now += 30 * SECOND;
			const undone = await manager.tick();
			expect(undone.unsubscribed).toEqual([id]);
			expect(connector.subscriptions.size).toBe(0);
			expect(manager.bindings(id)[0]).toMatchObject({ phase: "ended", intent: null });
		});

		await withManager(async ({ manager, connector, trigger, clock, store }) => {
			const id = trigger();
			await manager.tick();
			// Paused while the connector was away, until the grant ran out.
			connector.statuses.set("travel", "disconnected");
			store.setLifecycle({ id, to: "paused" });
			await manager.tick();
			expect(manager.bindings(id)[0]).toMatchObject({ status: "revoked", phase: "open", nextAt: clock.now + 5 * MINUTE });
			clock.now = START + HOUR;
			connector.statuses.set("travel", "connected");
			const lapsed = await manager.tick();
			expect(lapsed.ended).toEqual([id]);
			expect(connector.count("unsubscribe")).toBe(0);
			expect(manager.bindings(id)[0]).toMatchObject({ phase: "ended", lastError: "lapsed" });
		});
	});

	it("stops for good on a fatal code, with the trigger's health saying why, and backs off on any other", async () => {
		await withManager(async ({ manager, connector, trigger, clock, store }) => {
			const forbidden = trigger();
			connector.script.push({ code: -32012 });
			const report = await manager.tick();
			expect(report.failed).toEqual([forbidden]);
			expect(store.get(forbidden)).toMatchObject({ lifecycle: "enabled", health: "auth_required", healthDetail: "The connector refused the trigger's subscription (code -32012); it must be set up again." });
			expect(manager.bindings(forbidden)).toMatchObject([{ phase: "failed", status: "revoked", lastError: "refused -32012", nextAt: null }]);
			for (const step of [MINUTE, HOUR, DAY]) {
				clock.now += step;
				expect((await manager.tick()).nextWakeAt).toBeNull();
			}
			expect(connector.count("subscribe")).toBe(1);
			// Enabling it again, a new generation, tries again.
			store.setLifecycle({ id: forbidden, to: "paused" });
			store.setLifecycle({ id: forbidden, to: "enabled", expectedRevision: 1 });
			await manager.tick();
			expect(manager.bindings(forbidden)[1]).toMatchObject({ phase: "open", providerSubscriptionId: "sub_1" });

			// Unsupported on a renewal: the trigger's configuration.
			connector.script.push({ code: -32014 });
			clock.now += HOUR;
			await manager.tick();
			expect(store.get(forbidden)).toMatchObject({ health: "configuration_error" });
			expect(manager.bindings(forbidden)[1]).toMatchObject({ phase: "failed", lastError: "refused -32014" });
		});

		await withManager(async ({ manager, connector, trigger, clock, store }) => {
			const id = trigger();
			connector.script.push({ code: -32603 }, { code: -32603 });
			expect((await manager.tick()).refused).toEqual([id]);
			expect(manager.bindings(id)[0]).toMatchObject({ phase: "open", intent: null, failures: 1, lastError: "refused -32603", nextAt: START + 30 * SECOND });
			clock.now = START + 30 * SECOND;
			await manager.tick();
			expect(manager.bindings(id)[0]).toMatchObject({ failures: 2, nextAt: clock.now + MINUTE });
			clock.now += MINUTE;
			await manager.tick();
			expect(manager.bindings(id)[0]).toMatchObject({ failures: 0, lastError: null, providerSubscriptionId: "sub_1" });
			expect(store.get(id)!.health).toBe("unknown");
		});
	});

	it("waits while a connector is disconnected, ends a removed connector's bindings without asking it, and gives up unsubscribing in the end", async () => {
		await withManager(async ({ manager, connector, trigger, clock, store }) => {
			connector.statuses.set("travel", "disconnected");
			const id = trigger();
			const waiting = await manager.tick();
			expect(waiting.planned).toEqual([id]);
			expect(connector.requests).toEqual([]);
			expect(waiting.nextWakeAt).toBe(START + 5 * MINUTE);
			connector.statuses.set("travel", "connected");
			clock.now = START + 5 * MINUTE;
			await manager.tick();
			expect(connector.count("subscribe")).toBe(1);

			connector.statuses.delete("travel");
			clock.now += HOUR;
			const removed = await manager.tick();
			expect(removed.ended).toEqual([id]);
			expect(connector.count("unsubscribe")).toBe(0);
			expect(manager.bindings(id)[0]).toMatchObject({ phase: "ended", status: "revoked", lastError: "connector_removed" });
			expect(store.get(id)).toMatchObject({ health: "configuration_error", healthDetail: "The trigger's connector was removed; it must be set up again." });
		});

		await withManager(async ({ manager, connector, trigger, clock, store }) => {
			// A grant with no expiry never lapses by itself.
			connector.refreshBefore = () => null;
			const id = trigger();
			await manager.tick();
			store.setLifecycle({ id, to: "paused" });
			connector.script.push({ code: -32603 }, "throw", { code: -32603 }, { code: -32603 }, { code: -32603 }, { code: -32603 });
			for (let step = 0; step < 6; step++) {
				await manager.tick();
				clock.now += HOUR;
			}
			expect(connector.count("unsubscribe")).toBe(6);
			expect(manager.bindings(id)[0]).toMatchObject({ phase: "ended", lastError: "unsubscribe_unconfirmed" });
			// A connector that says the subscription isn't there has nothing left to undo.
			store.setLifecycle({ id, to: "enabled", expectedRevision: 1 });
			await manager.tick();
			store.setLifecycle({ id, to: "paused" });
			connector.script.push({ code: -32011 });
			expect((await manager.tick()).unsubscribed).toEqual([id]);
			expect(manager.bindings(id)[1]).toMatchObject({ phase: "ended", lastError: "refused -32011" });
		});
	});

	it("sends one request for a binding however many ticks, and managers, run at once", async () => {
		await withManager(async ({ manager, connector, trigger, restart }) => {
			const id = trigger();
			let release!: () => void;
			connector.script.push({ gate: new Promise<void>((resolve) => (release = resolve)) });
			const other = restart();
			const ticks = [manager.tick(), manager.tick(), other.tick(), other.tick()];
			await settle();
			expect(connector.count("subscribe")).toBe(1);
			release();
			const reports = await Promise.all(ticks);
			expect(reports.flatMap((report) => report.planned)).toEqual([id]);
			expect(reports.flatMap((report) => report.subscribed)).toEqual([id]);
			expect(connector.count("subscribe")).toBe(1);
			expect(manager.bindings(id)).toHaveLength(1);
		});
	});

	it("does bounded work in each tick, and gets to every trigger", async () => {
		await withManager(
			async ({ manager, connector, trigger, clock, store }) => {
				const ids = Array.from({ length: 11 }, (_, index) => trigger({ label: `Fares ${index}` }));
				const reports = [];
				for (let tick = 0; tick < 10; tick++) {
					const report = await manager.tick();
					reports.push(report);
					expect(report.planned.length).toBeLessThanOrEqual(4);
					expect(report.subscribed.length).toBeLessThanOrEqual(3);
					if (report.nextWakeAt !== clock.now) break;
				}
				expect(reports[0]!.nextWakeAt).toBe(clock.now);
				expect(connector.count("subscribe")).toBe(11);
				expect(new Set(reports.flatMap((report) => report.subscribed))).toEqual(new Set(ids));
				expect(reports.at(-1)!.nextWakeAt).toBe(START + HOUR - RENEW_MARGIN_MS);

				// Pausing them all is undone a few at a time too.
				clock.now += MINUTE;
				for (const id of ids) store.setLifecycle({ id, to: "paused" });
				let unsubscribed = 0;
				for (let tick = 0; tick < 10 && unsubscribed < ids.length; tick++) {
					const report = await manager.tick();
					expect(report.revoked.length).toBeLessThanOrEqual(5);
					expect(report.unsubscribed.length).toBeLessThanOrEqual(3);
					unsubscribed += report.unsubscribed.length;
				}
				expect(unsubscribed).toBe(ids.length);
				expect(connector.subscriptions.size).toBe(0);
				expect((await manager.tick()).nextWakeAt).toBeNull();
			},
			{ batch: { plans: 4, effects: 3, revocations: 5 } },
		);
	});

	it("keeps the callback URL and secret out of errors, history and the export", async () => {
		await withManager(async ({ manager, connector, trigger, clock, store, sql, timers }) => {
			const failing = trigger({ label: "Fails" });
			connector.script.push({ code: -32012 });
			const reports = [await manager.tick()];
			const id = trigger();
			connector.script.push("throw");
			reports.push(await manager.tick());
			clock.now += 30 * SECOND;
			reports.push(await manager.tick());
			connector.script.push("hang");
			clock.now += HOUR;
			const hung = manager.tick();
			await settle();
			timers.expire();
			reports.push(await hung);
			store.setLifecycle({ id, to: "paused" });
			clock.now += HOUR;
			reports.push(await manager.tick());

			const secrets = connector.requests.flatMap(({ request }) => ("secret" in request.delivery ? [request.delivery.secret] : []));
			const urls = connector.requests.map(({ request }) => request.delivery.url);
			const keys = [...manager.bindings(id), ...manager.bindings(failing)].map((binding) => binding.key);
			expect(secrets.length).toBeGreaterThan(0);
			const exported = JSON.stringify(triggerHistory(sql));
			expect(exported).toContain("pim_trigger_subscriptions");
			const rows = sql.exec("SELECT * FROM pim_trigger_subscriptions").toArray();
			const kept = JSON.stringify(rows.map(({ secret: _secret, key: _key, ...rest }) => rest));
			const views = JSON.stringify([...manager.bindings(id), ...manager.bindings(failing)].map(({ key: _key, ...rest }) => rest));
			const health = JSON.stringify([store.get(id), store.get(failing)]);
			for (const text of [exported, kept, views, health, JSON.stringify(reports)]) {
				for (const value of [...secrets, ...urls, ...keys, "whsec_", ORIGIN, "connection reset"]) expect(text).not.toContain(value);
			}
			expect(rows.map((row) => row.last_error).sort()).toEqual(["no_answer", "refused -32012"]);
			// Ended bindings wipe their secret; the open one keeps it, for checking signatures.
			expect(rows.map((row) => [row.phase, row.secret === ""]).sort()).toEqual([
				["ended", true],
				["failed", true],
			]);
		});
	});

	it("adds its table beside the engine's, keeping every row they hold, however often it is made", async () => {
		await withManager(async ({ sql, store, transaction, clock, restart, trigger }) => {
			// A space as the accepted engine left it: triggers, a time firing handed on, a run recorded, and no table of the manager's.
			sql.exec("DROP TABLE pim_trigger_subscriptions");
			const id = trigger();
			store.create({ spec: { ...base, label: "Daily", source: { kind: "time", schedule: "interval", everyMs: HOUR, anchorAt: START, catchUpMs: MINUTE } }, lifecycle: "enabled" });
			const coordinator = new TriggerCoordinator(sql, {
				store,
				host: {
					preflight: async () => ({ ok: true }) as const,
					findChat: async () => ({ status: "absent" }) as const,
					createChat: async () => ({ status: "created", chatId: "chat-9" }) as const,
					lookupSubmission: async () => ({ status: "absent" }) as const,
					submit: async () => ({ status: "accepted", receipt: "receipt-1" }) as const,
					lookupRun: async () => "running" as const,
				},
				transaction,
				now: () => clock.now,
			});
			clock.now = START + HOUR;
			await coordinator.tick();
			const tables = () =>
				Object.fromEntries(
					sql
						.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pim_trigger%' ORDER BY name")
						.toArray()
						.map((row) => [String(row.name), sql.exec(`SELECT * FROM ${String(row.name)} ORDER BY rowid`).toArray()]),
				);
			const before = tables();
			expect(Object.keys(before)).toContain("pim_trigger_runs");
			expect(before.pim_trigger_runs).toHaveLength(1);
			expect(Object.keys(before)).not.toContain("pim_trigger_subscriptions");
			const history = triggerHistory(sql);

			restart();
			restart();
			const { pim_trigger_subscriptions: added, ...after } = tables();
			expect(after).toEqual(before);
			expect(added).toEqual([]);
			expect(triggerHistory(sql)).toEqual({ ...history, pim_trigger_subscriptions: [] });
			const objects = sql
				.exec("SELECT type, name FROM sqlite_master WHERE tbl_name = 'pim_trigger_subscriptions' AND name NOT LIKE 'sqlite_autoindex%'")
				.toArray()
				.map((row) => `${row.type}:${row.name}`)
				.sort();
			expect(objects).toEqual(["index:pim_trigger_subscriptions_by_next", "table:pim_trigger_subscriptions", "trigger:pim_trigger_subscriptions_pinned", "trigger:pim_trigger_subscriptions_secret"]);

			// The manager made again binds the connector's trigger, and only that one.
			const manager = restart();
			const report = await manager.tick();
			expect(report.planned).toEqual([id]);
			expect(() => sql.exec("UPDATE pim_trigger_subscriptions SET secret = 'whsec_other'")).toThrow(/keeps its secret/);
			expect(() => sql.exec("UPDATE pim_trigger_subscriptions SET generation = 9")).toThrow(/keeps its key/);
		});
	});

	it("is constructed nowhere in Pim", () => {
		const files = import.meta.glob(["../src/**/*.ts", "../preview/**/*.ts", "../pim.config.ts", "../test/worker.ts", "../web/src/**/*.{ts,tsx}"], { query: "?raw", import: "default", eager: true });
		const users = Object.entries(files)
			.filter(([path]) => path !== "../src/triggers/subscriptions.ts")
			.filter(([, source]) => /ConnectorSubscriptionManager|new ConnectorIngress\b/.test(source as string))
			.map(([path]) => path);
		expect(users).toEqual([]);
	});
});
