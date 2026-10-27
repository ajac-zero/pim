import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentByName } from "agents";
import { createExecutionContext, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Relay, type Session, type SessionEvents, serveWithWebSocketPair } from "../computer/cua-bridge";
import { Link, type Machine } from "../computer/pim-computer";
import { ClaimRecord, type EvalDirectory } from "../preview/cua-eval";
import { FIXTURE_KEY, LEASE_ID } from "../preview/cua-fixture";
import previewWorker from "../preview/worker";
import { currentTrace } from "../src/computer-control-runtime";
import { PROVIDER_KEY } from "../src/cua";
import { initialObservationState, type ObservationState } from "../src/cua-observation";
import { Directory as BaseDirectory } from "../src/directory";
import { OBSERVATION_KEY } from "../src/cua-observation-runtime";
import { OWNER_HEADER, Pim as RealPim, SIGNED_IN_HEADER } from "../src/pim";
import { type Approval, PimStore } from "../src/store";
import { Authenticator } from "./webauthn";
import { PreviewPim } from "./worker";

/**
 * The preview's one-shot Cua fixture (preview/cua-fixture.ts), run by the
 * preview's own `Pim` (preview/worker.ts), which vitest.config.ts binds as
 * `PREVIEW_PIM` for these tests only. Each start below is a real one: the
 * Durable Object is evicted (`evictDurableObject`, which ends its instance
 * and keeps its storage) and the next call makes a new instance, whose
 * constructor runs the fixture. That is a restart of one object in the
 * local test runtime, not of a running preview (`wrangler dev`). Failures
 * are injected into that constructor through `PimStore.prototype.setMeta`.
 * The bridge is the reviewed relay behind an injected `fetch`, with
 * in-memory sessions that run nothing. The test environment configures
 * Sprites (`SPRITES_TOKEN`), so a space that fell back to the default
 * computer could start one.
 *
 * The preview's Cua evaluation mode (preview/cua-eval.ts) is tested here too:
 * the preview's own Worker called directly, as the ingress would reach it,
 * with the preview's Directory (`PREVIEW_DIRECTORY`, a fresh one for each
 * test) and its Pim. Passkeys are made by the tests' software authenticator
 * in the real ceremony. Nothing leaves the isolate.
 */

const TOKEN = "preview-cua-fixture-token-0123456789abcdef";
const HOST = "https://bridge.preview-fixture.test";
const CONTROL_KEY = "computer_control";
/** Everything the fixture reads or writes. */
const KEYS = [PROVIDER_KEY, CONTROL_KEY, FIXTURE_KEY, OBSERVATION_KEY, "computer_token", "computer_machine"];
const DOES_NOT_START = /Cua fixture didn't seed it, so it doesn't start/;

type Space = Awaited<ReturnType<typeof space>>;

const previews = (env as unknown as { PREVIEW_PIM: DurableObjectNamespace<PreviewPim> }).PREVIEW_PIM;
const settings = env as unknown as Record<string, unknown>;
const bridgeOf = (owner: string, changes: Record<string, unknown> = {}) => ({ url: `${HOST}/${owner}`, token: TOKEN, ...changes });
const bridgesOf = (owner: string) => ({ [owner]: bridgeOf(owner) });
const marker = (owner: string) => JSON.stringify({ provider: "cua", space: owner });
const ENV_KEYS = ["PREVIEW_CUA_FIXTURE", "PREVIEW_CUA_FIXTURE_OWNER", "CUA_BRIDGES"] as const;

/** What the preview's private environment holds: the fixture's opt-in and owner, and `CUA_BRIDGES`. */
function configure(values: { flag?: string; owner?: string; bridges?: unknown }) {
	const bridges = values.bridges === undefined || typeof values.bridges === "string" ? values.bridges : JSON.stringify(values.bridges);
	for (const [key, value] of [
		["PREVIEW_CUA_FIXTURE", values.flag],
		["PREVIEW_CUA_FIXTURE_OWNER", values.owner],
		["CUA_BRIDGES", bridges],
	] as const) {
		if (value === undefined) delete settings[key];
		else settings[key] = value;
	}
}

/** Every request that left the isolate: to Sprites, a paired computer's relay, a bridge, anywhere. */
const sent: string[] = [];

/** A person registered and provisioned in the preview with the fixture off, as an operator gets an owner ID before opting in. */
async function space(username: string) {
	const saved = ENV_KEYS.map((key) => [key, settings[key]] as const);
	configure({});
	const directory = env.Directory.getByName("directory");
	const registered = await directory.register({ username, ip: "192.0.2.10", claim: { window: true }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
	if (!registered.ok) throw new Error(registered.error);
	const owner = registered.account.ownerId;
	await directory.activate(owner);
	await (await getAgentByName(previews, owner)).provision({ ownerId: owner, username });
	for (const [key, value] of saved) if (value !== undefined) settings[key] = value;
	const stub = previews.getByName(owner);
	const within = <T>(fn: (instance: PreviewPim, state: DurableObjectState) => T | Promise<T>) => runInDurableObject(stub, fn);
	/** What the space holds under the fixture's keys, read from its storage directly. */
	const raw = (state: DurableObjectState) => Object.fromEntries(KEYS.map((key) => [key, (state.storage.sql.exec("SELECT value FROM pim_meta WHERE key = ?", key).toArray()[0]?.value as string | undefined) ?? null]));
	const self = {
		owner,
		stub,
		within,
		/** The space ended and started again: a new instance, whose constructor runs the fixture with what `configure` set. "started", or what it threw. */
		restart: async () => {
			await evictDurableObject(stub).catch(() => undefined);
			return within(() => "started").catch((error: unknown) => String(error));
		},
		/** What the space holds under the fixture's keys, from a running instance. */
		stored: () => within((_instance, state) => raw(state)),
		/**
		 * The same, for a space that doesn't start: an instance made with the fixture off and its record
		 * hidden from the constructor, for the test to read storage only, and evicted after.
		 */
		peek: async () => {
			const kept = ENV_KEYS.map((key) => [key, settings[key]] as const);
			configure({});
			const meta = PimStore.prototype.meta;
			const hide = vi.spyOn(PimStore.prototype, "meta").mockImplementation(function (this: PimStore, key: string) {
				return key === FIXTURE_KEY ? undefined : meta.call(this, key);
			});
			try {
				await evictDurableObject(stub).catch(() => undefined);
				return await within((_instance, state) => raw(state));
			} finally {
				hide.mockRestore();
				await evictDurableObject(stub).catch(() => undefined);
				for (const [key, value] of kept) if (value !== undefined) settings[key] = value;
			}
		},
		/** Asks the space's own `fetch`, as the Worker forwards an API request. */
		fetch: async <T = any>(path: string, init: RequestInit = {}) => {
			const response = await stub.fetch(new Request(`https://pim.test${path}`, { ...init, headers: { [OWNER_HEADER]: owner, "content-type": "application/json", ...(init.headers as Record<string, string>) } }));
			return { status: response.status, body: (await response.json()) as T };
		},
	};
	return self;
}

/**
 * Everything that could start, pair or wake a computer, or take a person's input, tried on a space
 * that has just ended: what each did ("refused" when the space wasn't constructed). With `call`, a
 * call to the space's RPC method too, after which the test runtime can't evict it again, so it is
 * the last thing done to that space.
 */
async function tryEverything(one: Space, { call = false } = {}) {
	await evictDurableObject(one.stub).catch(() => undefined);
	const attempt = async (name: string, run: () => Promise<unknown>) => {
		try {
			const result = await run();
			return [name, result instanceof Response ? `answered ${result.status}` : "answered"];
		} catch (error) {
			return [name, DOES_NOT_START.test(String(error)) ? "refused" : `threw ${String(error)}`];
		}
	};
	const request = (path: string, init: RequestInit = {}) => () => one.stub.fetch(new Request(`https://pim.test${path}`, { ...init, headers: { [OWNER_HEADER]: one.owner, ...(init.headers as Record<string, string>) } }));
	const upgrade = { headers: { Upgrade: "websocket" } };
	return Object.fromEntries([
		// The first, constructing the space, and every one after it.
		await attempt("start a Sprite", request("/computer", { method: "POST", body: JSON.stringify({ managed: true }) })),
		await attempt("pair a computer", request("/computer", { method: "POST", body: "{}" })),
		await attempt("a paired computer connects", request("/computer/connect", upgrade)),
		await attempt("read the person's files", request("/files")),
		await attempt("take the browser over", request("/browser/live", upgrade)),
		await attempt("ask to run a command", request("/sessions/any/messages", { method: "POST", body: JSON.stringify({ content: '/tool shell {"command": "echo no"}' }) })),
		await attempt("approve an approval", request("/approvals/any/approve", { method: "POST", body: "{}" })),
		await attempt("its alarm", () => runDurableObjectAlarm(one.stub)),
		...(call ? [await attempt("call the space", () => (one.stub as unknown as { usageReport(): Promise<unknown> }).usageReport())] : []),
	]);
}

const refusedEverything = {
	"start a Sprite": "refused",
	"pair a computer": "refused",
	"a paired computer connects": "refused",
	"read the person's files": "refused",
	"take the browser over": "refused",
	"ask to run a command": "refused",
	"approve an approval": "refused",
	"its alarm": "refused",
};
const refusedEverythingAndCalls = { ...refusedEverything, "call the space": "refused" };

const nothing = { [PROVIDER_KEY]: null, [CONTROL_KEY]: null, [FIXTURE_KEY]: null, [OBSERVATION_KEY]: null, computer_token: null, computer_machine: null };

const logged: unknown[][] = [];
/** The fixture's own log lines, parsed. */
const fixtureLines = () =>
	logged.flatMap(([line]) => {
		if (typeof line !== "string" || !line.includes('"preview.cua_fixture"')) return [];
		return [JSON.parse(line) as Record<string, unknown>];
	});

beforeEach(() => {
	logged.length = 0;
	sent.length = 0;
	for (const method of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
	// Nothing leaves unless a test puts a bridge here; Sprites, above all, is never reached.
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		sent.push(new URL(input instanceof Request ? input.url : String(input)).href);
		throw new Error("This test reaches nothing");
	});
});

afterEach(() => {
	configure({});
	// Nothing anywhere repeats the bridge.
	expect(JSON.stringify(logged)).not.toContain(TOKEN);
	expect(JSON.stringify(logged)).not.toContain("bridge.preview-fixture.test");
});

describe("the preview's Cua fixture", () => {
	it("is no route, RPC method or tool: the preview's Pim adds nothing callable to the real one", () => {
		const own = Object.getOwnPropertyNames(PreviewPim.prototype).filter((name) => name !== "constructor");
		for (const name of own) expect(name in RealPim.prototype, name).toBe(true);
		expect(own).not.toContain("seedCuaFixture");
	});

	it("changes nothing when it is off, opted in with anything but `seed`, or names another space or no owner at all", async () => {
		const ada = await space("fixtureoff");
		const bob = await space("fixtureother");
		const bridges = { ...bridgesOf(ada.owner), ...bridgesOf(bob.owner) };
		for (const values of [{ owner: ada.owner, bridges }, { flag: "1", owner: ada.owner, bridges }, { flag: "SEED", owner: ada.owner, bridges }, { flag: "seed", owner: bob.owner, bridges }]) {
			configure(values);
			expect(await ada.restart(), JSON.stringify(values.flag ?? null)).toBe("started");
			expect(await ada.stored(), JSON.stringify(values.flag ?? null)).toEqual(nothing);
		}
		expect(fixtureLines()).toEqual([]);
		// An owner that can't be an owner ID selects no space: each starts as it was, and the log says why.
		configure({ flag: "seed", owner: "o_not-an-owner", bridges });
		expect(await ada.restart()).toBe("started");
		expect(await ada.stored()).toEqual(nothing);
		expect(fixtureLines()).toEqual([{ event: "preview.cua_fixture", space: ada.owner, outcome: "refused", reason: "owner" }]);
		expect(await ada.within((instance) => [instance.control.enabled, instance.computer.selected()])).toEqual([false, null]);
		expect(sent).toEqual([]);
	});

	it("doesn't start the space named, and stores nothing, without a usable bridge for exactly its owner or a profile", async () => {
		const ada = await space("fixturebridge");
		const other = "o_" + "z".repeat(26);
		const cases: [string, unknown][] = [
			["no secret", undefined],
			["not JSON", "{not json"],
			["another owner's entry only", bridgesOf(other)],
			["plain HTTP", { [ada.owner]: bridgeOf(ada.owner, { url: `http://bridge.preview-fixture.test/${ada.owner}` }) }],
			["a query", { [ada.owner]: bridgeOf(ada.owner, { url: `${HOST}/${ada.owner}?` }) }],
			["a fragment", { [ada.owner]: bridgeOf(ada.owner, { url: `${HOST}/${ada.owner}#x` }) }],
			["credentials", { [ada.owner]: bridgeOf(ada.owner, { url: `https://user:pass@bridge.preview-fixture.test/${ada.owner}` }) }],
			["a short token", { [ada.owner]: bridgeOf(ada.owner, { token: "short" }) }],
			["a token with a space", { [ada.owner]: bridgeOf(ada.owner, { token: `${TOKEN} x` }) }],
			["another field", { [ada.owner]: bridgeOf(ada.owner, { space: ada.owner }) }],
		];
		for (const [name, bridges] of cases) {
			logged.length = 0;
			configure({ flag: "seed", owner: ada.owner, bridges });
			expect(await ada.restart(), name).toMatch(DOES_NOT_START);
			expect(fixtureLines(), name).toEqual([{ event: "preview.cua_fixture", space: ada.owner, outcome: "refused", reason: "bridge" }]);
		}
		// The instance that refused served nothing: no default computer, no pairing, no input, nothing sent.
		configure({ flag: "seed", owner: ada.owner });
		expect(await tryEverything(ada)).toEqual(refusedEverything);
		expect(sent).toEqual([]);
		expect(await ada.peek()).toEqual(nothing);

		// Refusing changed nothing, so it is checked again: with the bridge fixed, the space is seeded.
		configure({ flag: "seed", owner: ada.owner, bridges: bridgesOf(ada.owner) });
		expect(await ada.restart()).toBe("started");
		expect((await ada.stored())[FIXTURE_KEY]).toBe("seeded");

		// A space named without an owner profile (not provisioned, or erased) doesn't start either.
		const bob = await space("fixturenoprofile");
		await bob.within((instance) => instance.store.deleteMeta("owner"));
		logged.length = 0;
		configure({ flag: "seed", owner: bob.owner, bridges: bridgesOf(bob.owner) });
		expect(await bob.restart()).toMatch(DOES_NOT_START);
		expect(fixtureLines()[0]).toEqual({ event: "preview.cua_fixture", space: bob.owner, outcome: "refused", reason: "space" });
		expect(await bob.peek()).toEqual(nothing);
		expect(await tryEverything(bob, { call: true })).toEqual(refusedEverythingAndCalls);
		expect(sent).toEqual([]);
	});

	it("doesn't start, and changes nothing in, a space named that already holds a marker, any control state, a computer or another record", async () => {
		const human = JSON.stringify({ version: 1, space: "SPACE", state: { version: 1, epoch: 0, owner: "human", lease: null, inputQuiescence: "unproven", requests: [], viewers: [] }, bindings: [] });
		const unknown = JSON.stringify({
			version: 1,
			space: "SPACE",
			state: { version: 1, epoch: 1, owner: "agent", lease: { epoch: 1, leaseId: "old" }, inputQuiescence: "unproven", requests: [{ requestId: "r", agentId: "a", epoch: 1, status: "unknown" }], viewers: [] },
			bindings: [],
		});
		const cases: [string, Record<string, string>, string][] = [
			["the exact marker", { [PROVIDER_KEY]: "MARKER" }, "marker"],
			["an unreadable marker", { [PROVIDER_KEY]: "cua" }, "marker"],
			["control state with the person in control", { [CONTROL_KEY]: human }, "control"],
			["control state blocked by an unknown request", { [CONTROL_KEY]: unknown }, "control"],
			["damaged control state", { [CONTROL_KEY]: "not json" }, "control"],
			["another space's control state", { [CONTROL_KEY]: human.replace("SPACE", "o_" + "y".repeat(26)) }, "control"],
			["an observation ledger", { [OBSERVATION_KEY]: JSON.stringify({ version: 1, owner: "SPACE", records: [] }) }, "observations"],
			["a paired computer", { computer_token: "hash" }, "computer"],
			["a Sprite", { computer_machine: "pim-sprite" }, "computer"],
		];
		for (const [index, [name, held, reason]] of cases.entries()) {
			const one = await space(`fixturec${index}`);
			const values = Object.fromEntries(Object.entries(held).map(([key, value]) => [key, value.replace("SPACE", one.owner).replace("MARKER", marker(one.owner))]));
			await one.within((instance) => {
				for (const [key, value] of Object.entries(values)) instance.store.setMeta(key, value);
			});
			const before = await one.stored();
			logged.length = 0;
			configure({ flag: "seed", owner: one.owner, bridges: bridgesOf(one.owner) });
			expect(await one.restart(), name).toMatch(DOES_NOT_START);
			expect(fixtureLines(), name).toEqual([{ event: "preview.cua_fixture", space: one.owner, outcome: "refused", reason }]);
			expect(await one.peek(), name).toEqual(before);
		}
		expect(sent).toEqual([]);

		// A record the fixture doesn't know keeps the space from starting whatever the environment says.
		const odd = await space("fixtureodd");
		await odd.within((instance) => instance.store.setMeta(FIXTURE_KEY, "done"));
		logged.length = 0;
		expect(await odd.restart()).toMatch(DOES_NOT_START);
		expect(fixtureLines()).toEqual([{ event: "preview.cua_fixture", space: odd.owner, outcome: "refused", reason: "record" }]);
	});

	it("seeds the space named once, with its marker and a lease, and leaves every other space as it was", async () => {
		const ada = await space("fixtureseed");
		const bob = await space("fixtureseedbob");
		configure({ flag: "seed", owner: ada.owner, bridges: { ...bridgesOf(ada.owner), ...bridgesOf(bob.owner) } });
		expect(await ada.restart()).toBe("started");
		expect(await bob.restart()).toBe("started");

		const stored = await ada.stored();
		expect(stored[PROVIDER_KEY]).toBe(marker(ada.owner));
		expect(stored[FIXTURE_KEY]).toBe("seeded");
		// The one place a ledger is provisioned: empty, for this owner, in the seed's own transaction.
		expect(stored[OBSERVATION_KEY]).toBe(JSON.stringify(initialObservationState(ada.owner)));
		const state = await ada.within((instance) => ({ enabled: instance.control.enabled, blocked: instance.control.blocked, state: instance.control.state, selected: instance.computer.selected() }));
		expect(state).toEqual({
			enabled: true,
			blocked: null,
			selected: "cua",
			state: { version: 1, epoch: 1, owner: "agent", lease: { epoch: 1, leaseId: LEASE_ID }, inputQuiescence: "unproven", requests: [], viewers: [] },
		});
		expect(fixtureLines()).toEqual([{ event: "preview.cua_fixture", space: ada.owner, outcome: "seeded" }]);
		// Neither the bridge's address nor its token is in the space's storage.
		const everything = await ada.within((_instance, state) => JSON.stringify(state.storage.sql.exec("SELECT * FROM pim_meta").toArray()));
		expect(everything).not.toContain(TOKEN);
		expect(everything).not.toContain("bridge.preview-fixture.test");

		// Bob, with a bridge of his own in the secret, is not the space named: nothing of his changed.
		expect(await bob.stored()).toEqual(nothing);
		expect(await bob.within((instance) => [instance.control.enabled, instance.computer.selected()])).toEqual([false, null]);
		// The person's own routes offer no takeover, and keep refusing to start, pair or remove a computer.
		expect((await ada.fetch("/computer")).body).toMatchObject({ provider: "cua", startable: false });
		expect((await ada.fetch("/browser")).body).toMatchObject({ takeOver: false });
		expect((await ada.fetch("/computer", { method: "POST", body: JSON.stringify({ managed: true }) })).status).toBe(409);
		expect((await ada.fetch("/computer", { method: "DELETE" })).status).toBe(409);
		expect(sent).toEqual([]);
	});

	it("starts a seeded space as it is at every later start, opted in or not: nothing is re-enabled, resumed or renewed", async () => {
		const ada = await space("fixturerestart");
		configure({ flag: "seed", owner: ada.owner, bridges: bridgesOf(ada.owner) });
		expect(await ada.restart()).toBe("started");
		expect((await ada.stored())[FIXTURE_KEY]).toBe("seeded");

		// A request sent and not answered leaves the state blocked by an unknown request.
		await ada.within((instance) =>
			instance.control.dispatch({ space: ada.owner, agentId: "agent", requestId: "request-1" }, async () => {
				const trace = currentTrace()!;
				trace.sent = true;
				trace.uncertain = true;
			}),
		);
		const blocked = await ada.stored();
		for (const values of [{ flag: "seed", owner: ada.owner, bridges: bridgesOf(ada.owner) }, {}]) {
			logged.length = 0;
			configure(values);
			expect(await ada.restart()).toBe("started");
			expect(await ada.stored()).toEqual(blocked);
			expect(await ada.within((instance) => [instance.control.blocked, instance.control.state?.requests])).toEqual([null, [{ requestId: "request-1", agentId: "agent", epoch: 1, status: "unknown" }]]);
			expect(fixtureLines()).toEqual([{ event: "preview.cua_fixture", space: ada.owner, outcome: "already-seeded" }]);
		}

		// The person in control (as a takeover leaves it), or the control state gone: neither is given back to the agent.
		configure({ flag: "seed", owner: ada.owner, bridges: bridgesOf(ada.owner) });
		await ada.within((instance) => void instance.control.apply({ type: "takeover" }));
		const human = await ada.stored();
		expect(await ada.restart()).toBe("started");
		expect(await ada.stored()).toEqual(human);
		expect(await ada.within((instance) => [instance.control.state?.owner, instance.control.state?.lease])).toEqual(["human", null]);
		await ada.within((instance) => instance.store.deleteMeta(CONTROL_KEY));
		expect(await ada.restart()).toBe("started");
		expect((await ada.stored())[CONTROL_KEY]).toBeNull();
		expect(await ada.within((instance) => [instance.control.enabled, instance.computer.selected()])).toEqual([false, "cua"]);

		// Its marker gone, it would use the default computer: it doesn't start, opted in or not.
		await ada.within((instance) => instance.store.deleteMeta(PROVIDER_KEY));
		for (const [index, values] of [{ flag: "seed", owner: ada.owner, bridges: bridgesOf(ada.owner) }, {}].entries()) {
			logged.length = 0;
			configure(values);
			expect(await tryEverything(ada, { call: index === 1 })).toEqual(index === 1 ? refusedEverythingAndCalls : refusedEverything);
			expect(fixtureLines()[0]).toEqual({ event: "preview.cua_fixture", space: ada.owner, outcome: "refused", reason: "marker" });
		}
		expect(sent).toEqual([]);
	});

	it("never starts a space whose seed failed after it began, and never tries again", async () => {
		// Each write in the transaction failing, in the constructor of a real start: the marker, enabling, the lease, and `seeded`.
		const setMeta = PimStore.prototype.setMeta;
		const failing = (key: string, when: (value: string) => boolean = () => true) =>
			vi.spyOn(PimStore.prototype, "setMeta").mockImplementation(function (this: PimStore, name: string, value: string) {
				if (name === key && when(value)) throw new Error("disk full");
				setMeta.call(this, name, value);
			});
		const writes: [string, string, ((value: string) => boolean)?][] = [
			["the marker", PROVIDER_KEY],
			["enabling", CONTROL_KEY, (value) => value.includes('"owner":"human"')],
			["the lease", CONTROL_KEY, (value) => value.includes('"owner":"agent"')],
			["the observation ledger", OBSERVATION_KEY],
			["the seeded record", FIXTURE_KEY, (value) => value === "seeded"],
		];
		for (const [index, [name, key, when]] of writes.entries()) {
			const one = await space(`fixturefail${index}`);
			// The fault is the test's own, and is taken off however its assertions end, so no later test meets it.
			const fault = failing(key, when);
			try {
				logged.length = 0;
				configure({ flag: "seed", owner: one.owner, bridges: bridgesOf(one.owner) });
				// The start that failed, and every one after it, opted in or not, serves nothing and reaches nothing.
				expect(await tryEverything(one), name).toEqual(refusedEverything);
				expect(fixtureLines()[0], name).toEqual({ event: "preview.cua_fixture", space: one.owner, outcome: "failed", reason: "seed" });
				expect(fixtureLines().slice(1).every((line) => line.outcome === "interrupted"), name).toBe(true);
			} finally {
				fault.mockRestore();
			}
			// The transaction kept nothing: only the record that it began.
			expect(await one.peek(), name).toEqual({ ...nothing, [FIXTURE_KEY]: "seeding" });
			for (const [round, values] of [{ flag: "seed", owner: one.owner, bridges: bridgesOf(one.owner) }, {}].entries()) {
				logged.length = 0;
				configure(values);
				expect(await tryEverything(one, { call: round === 1 }), name).toEqual(round === 1 ? refusedEverythingAndCalls : refusedEverything);
				expect(fixtureLines()[0], name).toEqual({ event: "preview.cua_fixture", space: one.owner, outcome: "interrupted" });
			}
		}
		expect(sent).toEqual([]);
	});

	it("doesn't serve the start whose first write failed, which stored nothing, so the next start is a first one", async () => {
		const one = await space("fixtureunrecorded");
		const setMeta = PimStore.prototype.setMeta;
		const fault = vi.spyOn(PimStore.prototype, "setMeta").mockImplementation(function (this: PimStore, key: string, value: string) {
			if (key === FIXTURE_KEY) throw new Error("disk full");
			setMeta.call(this, key, value);
		});
		try {
			configure({ flag: "seed", owner: one.owner, bridges: bridgesOf(one.owner) });
			expect(await tryEverything(one)).toEqual(refusedEverything);
			expect(fixtureLines()[0]).toEqual({ event: "preview.cua_fixture", space: one.owner, outcome: "failed", reason: "record" });
			expect(sent).toEqual([]);
		} finally {
			fault.mockRestore();
		}
		expect(await one.peek()).toEqual(nothing);
		// Nothing says a seed was tried: this start can't know, and seeds.
		expect(await one.restart()).toBe("started");
		expect((await one.stored())[FIXTURE_KEY]).toBe("seeded");
	});
});

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Throws what failed: one error as it is, several together, none at all when nothing did. */
function rethrow(errors: readonly unknown[], summary: string): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, `${summary} (${errors.map(messageOf).join("; ")})`);
}

/**
 * Runs `body`, then `cleanup` however `body` ended, as test/cua-native-identity.test.ts does:
 * the body's failure, the cleanup's, or both in one AggregateError, the body's first. Neither
 * hides the other.
 */
async function afterwards(body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
	let failure: { readonly error: unknown } | undefined;
	try {
		await body();
	} catch (error) {
		failure = { error };
	}
	let cleaned: { readonly error: unknown } | undefined;
	try {
		await cleanup();
	} catch (error) {
		cleaned = { error };
	}
	if (failure && cleaned) {
		throw new AggregateError([failure.error, cleaned.error], `The test failed (${messageOf(failure.error)}), and cleaning up after it failed too (${messageOf(cleaned.error)})`);
	}
	if (failure) throw failure.error;
	if (cleaned) throw cleaned.error;
}

describe("a seeded preview space and its bridge", () => {
	/**
	 * The space's bridge: the relay, whose sessions record what reached them and run nothing. The
	 * test owns a temporary directory, made fresh under `os.tmpdir()` for the machine's root, and
	 * every session the relay opens. `cleanup` refuses any session after it starts, ends each owned
	 * one (its Link closes, and the relay ends its connection), and removes that directory only.
	 * When anything fails before the bridge is handed back, the directory is removed here.
	 */
	async function bridge(owner: string) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "preview-cua-fixture-"));
		try {
			const seen = { connections: 0, sent: [] as string[], ran: [] as string[] };
			const owned: (() => void)[] = [];
			let closing = false;
			const machine: Machine = {
				root: await fs.realpath(root),
				exec: async (args) => {
					seen.ran.push(args.command);
					return { exitCode: 0, signal: null, stdout: `ran ${args.command}\n`, stderr: "", timedOut: false, truncated: false };
				},
			};
			const open = async (events: SessionEvents): Promise<Session> => {
				if (closing) throw new Error("This test's bridge is being cleaned up and opens no more sessions");
				const link = new Link(machine, (message) => events.message(message));
				owned.push(() => {
					link.close();
					events.closed();
				});
				events.message(JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/test", hostname: "cua-vm", platform: "linux", arch: "x64", user: "desktop", root: machine.root, browser: null }));
				return {
					send(message) {
						seen.sent.push(message);
						link.receive(message);
					},
					close: () => link.close(),
				};
			};
			const relay = new Relay({ space: owner, token: TOKEN, path: `/${owner}`, open, log: () => undefined });
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.href !== `${HOST}/${owner}`) {
					sent.push(url.href);
					throw new Error(`This test reaches only its bridge, not ${url.href}`);
				}
				seen.connections++;
				return await serveWithWebSocketPair(relay, new Request(input, init));
			});
			const cleanup = async () => {
				closing = true;
				const errors: unknown[] = [];
				for (const end of owned.splice(0)) {
					try {
						end();
					} catch (error) {
						errors.push(error);
					}
				}
				try {
					await fs.rm(root, { recursive: true });
				} catch (error) {
					errors.push(error);
				}
				rethrow(errors, "Cleaning up the bridge failed");
			};
			return { seen, cleanup };
		} catch (error) {
			const errors: unknown[] = [error];
			try {
				await fs.rm(root, { recursive: true });
			} catch (cleanup) {
				errors.push(cleanup);
			}
			rethrow(errors, "Making the bridge failed, and removing its directory failed too");
			throw error;
		}
	}

	it("sends the preview model's shell call only after the person approves it, once, to the owner's bridge", async () => {
		const ada = await space("fixtureapproval");
		// The preview's own policy: the majordomo reviews, and the preview model asks the person about everything.
		await ada.within((instance) => instance.applySettings({ approvalPolicy: "majordomo" }));
		configure({ flag: "seed", owner: ada.owner, bridges: bridgesOf(ada.owner) });
		expect(await ada.restart()).toBe("started");
		const { seen, cleanup } = await bridge(ada.owner);
		await afterwards(async () => {
			const root: string = (await ada.fetch("/")).body.rootSession;
			await ada.fetch(`/sessions/${root}/messages`, { method: "POST", body: JSON.stringify({ content: '/tool shell {"command": "echo fixture"}' }) });
			const pending = await vi.waitFor(
				async () => {
					const [approval] = (await ada.fetch<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals;
					expect(approval).toBeDefined();
					return approval!;
				},
				{ timeout: 15_000, interval: 200 },
			);
			// Filed and waiting for the person: nothing has reached the bridge.
			expect(seen).toEqual({ connections: 0, sent: [], ran: [] });

			expect((await ada.fetch(`/approvals/${pending.id}/approve`, { method: "POST", body: "{}" })).status).toBe(200);
			await vi.waitFor(() => expect(seen.ran).toEqual(["echo fixture"]), { timeout: 15_000, interval: 200 });
			expect(seen.connections).toBe(1);
			expect(seen.sent.filter((message) => message.includes("echo fixture"))).toHaveLength(1);
			await vi.waitFor(async () => expect((await ada.within((instance) => instance.control.state))?.requests).toEqual([expect.objectContaining({ requestId: `approval:${pending.id}`, status: "completed" })]));
			expect(sent).toEqual([]);
		}, cleanup);
	});

	it("lets the seeded owner's browser session start watching on the bridge's viewer host, view only, and leaves the agent's lease as it was", async () => {
		const ada = await space("fixturewatch");
		configure({ flag: "seed", owner: ada.owner, bridges: bridgesOf(ada.owner) });
		expect(await ada.restart()).toBe("started");
		const launch = "V".repeat(22);
		const credential = "k".repeat(43);
		const asked: { url: string; headers: Headers; body: string }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			const entry = { url: request.url, headers: request.headers, body: await request.text() };
			asked.push(entry);
			if (entry.url === `${HOST}/${ada.owner}/observations/launch`) {
				const { key, notAfter } = JSON.parse(entry.body) as { key: string; notAfter: number };
				return Response.json({ outcome: "launched", key, launchId: launch, generation: "gen-1", notAfter, viewerPath: `/${launch}/viewer/#ticket=${credential}&clipboard=0`, replayed: false });
			}
			sent.push(entry.url);
			throw new Error("This test reaches only its bridge's viewer host");
		});
		const session = { [SIGNED_IN_HEADER]: "1", origin: "https://pim.test" };
		// At an HTTPS address, the computer can be told to let this page frame the viewer.
		expect((await ada.fetch("/api/observations", { headers: session })).body).toEqual({ agent: "stand-in", frame: "embeddable", blocked: null, observations: [] });
		// Not the browser's session: nothing is recorded or asked.
		expect((await ada.fetch("/api/observations", { method: "POST", headers: { origin: "https://pim.test" } })).status).toBe(401);
		expect(asked).toEqual([]);

		const watched = await ada.fetch("/api/observations", { method: "POST", headers: session });
		expect(watched.status).toBe(200);
		const { observation, viewer } = watched.body as { observation: { id: string; status: string; notAfter: number }; viewer: string };
		expect(observation.status).toBe("open");
		// The browser opens the viewer on the host itself; the address carries the launch's credential and nothing of the bridge's.
		expect(viewer).toBe(`${HOST}/${launch}/viewer/#ticket=${credential}&clipboard=0`);
		expect(viewer).not.toContain(TOKEN);
		expect(asked[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(asked[0]!.headers.get("x-pim-space")).toBe(ada.owner);
		expect(JSON.parse(asked[0]!.body)).toEqual({ key: observation.id, owner: ada.owner, notAfter: observation.notAfter });

		// Pim carries nothing of the viewer: its page under Pim's path doesn't exist, and nothing is sent for it.
		const page = await ada.stub.fetch(new Request(`https://pim.test/api/observations/${observation.id}/viewer/`, { headers: { [OWNER_HEADER]: ada.owner, [SIGNED_IN_HEADER]: "1" } }));
		expect(page.status).toBe(404);

		const ledger = JSON.parse((await ada.stored())[OBSERVATION_KEY] as string) as ObservationState;
		expect(ledger.records).toEqual([expect.objectContaining({ observationId: observation.id, status: "open", hostLaunchId: launch, hostGeneration: "gen-1" })]);
		expect(JSON.stringify(ledger)).not.toContain(credential);
		// Watching took no lease and changed nothing of control: the agent still holds the fixture's.
		expect(await ada.within((instance) => instance.control.state)).toMatchObject({ owner: "agent", lease: { epoch: 1, leaseId: LEASE_ID }, viewers: [] });
		expect(JSON.stringify(ledger)).not.toContain(TOKEN);
		expect(asked).toHaveLength(1);
		expect(sent).toEqual([]);
	});

	it("fails closed in a seeded space whose ledger is gone, and mounts nothing in a space it didn't seed", async () => {
		const ada = await space("fixturenoledger");
		const bob = await space("fixturenoledgerbob");
		configure({ flag: "seed", owner: ada.owner, bridges: bridgesOf(ada.owner) });
		expect(await ada.restart()).toBe("started");
		await ada.within((instance) => instance.store.deleteMeta(OBSERVATION_KEY));
		expect(await ada.restart()).toBe("started");
		const session = { [SIGNED_IN_HEADER]: "1", origin: "https://pim.test" };
		expect((await ada.fetch("/api/observations", { headers: session })).body.blocked).toMatch(/no ledger is stored/);
		expect((await ada.fetch("/api/observations", { method: "POST", headers: session })).status).toBe(503);
		// Nothing made one, and nothing was asked of the bridge.
		expect((await ada.stored())[OBSERVATION_KEY]).toBeNull();
		// Bob's space, which the fixture didn't seed, has no observations; nor has Ada's once the environment stops naming it.
		expect((await bob.fetch("/api/observations", { headers: session })).status).toBe(404);
		configure({});
		expect(await ada.restart()).toBe("started");
		expect((await ada.fetch("/api/observations", { headers: session })).status).toBe(404);
		expect(sent).toEqual([]);
	});
});

describe("the preview's Cua evaluation mode", () => {
	const SECRET = "preview-eval-ingress-secret-0123456789abcdef";
	/** The operator's claim code, made privately, of which the preview is given only the SHA-256. */
	const CODE = "evalclaim".padEnd(43, "x");
	const ONCE = "This evaluation's owner was set up once already, and isn't set up again.";
	const EVAL_KEYS = ["PREVIEW_MODE", "PIM_INGRESS_SECRET", "PREVIEW_EVAL_CLAIM_SHA256", "PIM_PUBLIC_URL", "PIM_REGISTRATION"] as const;
	const previewDirectories = (env as unknown as { PREVIEW_DIRECTORY: DurableObjectNamespace<EvalDirectory> }).PREVIEW_DIRECTORY;
	let kept: (readonly [string, unknown])[] = [];

	beforeEach(() => {
		kept = EVAL_KEYS.map((key) => [key, settings[key]] as const);
	});
	afterEach(() => {
		for (const [key, value] of kept) {
			if (value === undefined) delete settings[key];
			else settings[key] = value;
		}
	});

	const hexOf = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

	/** What the operator's private environment adds for the evaluation. Pim's address stays the tests' `https://pim.test`. */
	async function evaluation() {
		settings.PREVIEW_MODE = "cua-eval";
		settings.PIM_INGRESS_SECRET = SECRET;
		settings.PREVIEW_EVAL_CLAIM_SHA256 = hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CODE)));
	}

	/** Why the preview refused to serve, as it logged it. */
	const refusals = () => logged.flatMap(([line]) => (typeof line === "string" && line.includes('"preview.refused"') ? [(JSON.parse(line) as { reason: string }).reason] : []));

	/**
	 * The preview's Worker, reached as the ingress reaches it through Wrangler run with `--host pim.test
	 * --upstream-protocol https`: at Pim's own address (or at `at`), with the ingress's secret and the client's
	 * address unless `ingress` is null, and, for a body, this app's `Origin` unless the test sends another. Each call
	 * of `worker` has a Directory of its own, of the preview's class, and the preview's Pim.
	 */
	function worker() {
		const run = crypto.randomUUID();
		const directory = (name: string) => previewDirectories.getByName(`${run}:${name}`);
		const target = Object.assign(Object.create(env as object) as object, { Directory: { getByName: directory }, Pim: previews }) as Env;
		const ask = async (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; ingress?: string | null; at?: string } = {}) => {
			const headers = new Headers(init.headers);
			const ingress = init.ingress === undefined ? SECRET : init.ingress;
			if (ingress !== null) {
				headers.set("x-pim-ingress-secret", ingress);
				headers.set("x-pim-client-ip", "192.0.2.40");
			}
			if (init.cookie) headers.set("cookie", init.cookie);
			if (init.body !== undefined) {
				headers.set("content-type", "application/json");
				if (!headers.has("origin")) headers.set("origin", "https://pim.test");
			}
			const method = init.method ?? (init.body === undefined ? "GET" : "POST");
			const request = new Request(`${init.at ?? "https://pim.test"}${path}`, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
			return await served(request, target);
		};
		const register = (username: string, claim?: string) => ask("/auth/register", { body: { username, ...(claim === undefined ? {} : { claim }) } });
		return { directory, ask, register };
	}

	/** The preview's Worker's answer, once whatever it handed its context to wait on has ended too. */
	async function served(request: Request, target: Env): Promise<Response> {
		const ctx = createExecutionContext();
		let answer: Response | undefined;
		await afterwards(
			async () => {
				answer = await previewWorker.fetch(request as never, target, ctx);
			},
			() => waitOnExecutionContext(ctx),
		);
		return answer!;
	}

	const refusal = async (answer: Response) => [answer.status, ((await answer.json()) as { error: string }).error];

	it("leaves the local preview as it was, refuses it behind an ingress or at an HTTPS address, and changes no deployment's Directory", async () => {
		await space("evallocal");
		settings.PIM_PUBLIC_URL = "http://localhost:8787";
		const local = (headers: Record<string, string> = {}) =>
			served(new Request("http://localhost:8787/__dev/sign-in/evallocal?returnTo=/settings", { headers }), env as unknown as Env);
		// As the preview has always signed people in: a passkey made here, and the session cookie.
		const signedIn = await local();
		expect(signedIn.status).toBe(302);
		expect(signedIn.headers.get("location")).toBe("/settings");
		expect(signedIn.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-pim-session="))).toBe(true);
		// Reached through an ingress, a local preview answers nothing, so nobody signs in as anybody through it.
		expect((await local({ "x-pim-ingress-secret": SECRET, "x-pim-client-ip": "192.0.2.40" })).status).toBe(503);
		expect((await local({ "x-pim-client-ip": "192.0.2.40" })).status).toBe(503);
		// Nor does one at an HTTPS address without the evaluation mode.
		settings.PIM_PUBLIC_URL = "https://pim.test";
		expect((await local()).status).toBe(503);
		expect(refusals()).toEqual(["ingress-without-mode", "ingress-without-mode", "https-without-mode"]);
		// The mode is the preview's Directory's alone: a deployment's still makes claim codes with it set, and the preview's does without it.
		await expect(previewDirectories.getByName(crypto.randomUUID()).claimCode()).resolves.toMatchObject({ code: expect.any(String) });
		await evaluation();
		await expect(env.Directory.getByName(crypto.randomUUID()).claimCode()).resolves.toMatchObject({ code: expect.any(String) });
	});

	it("answers nothing under /__dev or for a setup link, by any method or spelling, nothing that didn't come through the ingress or isn't at Pim's address, and nothing when it is set up wrong", async () => {
		await evaluation();
		const { ask, directory } = worker();
		const paths = ["/__dev/sign-in/mallory", "/__DEV/sign-in/mallory", "/%5F%5Fdev/sign-in/mallory", "/%5f_DeV/sign-in/mallory", "//__dev/sign-in/mallory", "/__dev", "/__dev/", "/auth/setup-link", "/auth/setup-link/", "/AUTH/Setup-Link"];
		for (const path of paths) {
			for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
				for (const ingress of [SECRET, null]) {
					const answer = await ask(path, { method, ingress, headers: { origin: "https://pim.test" } });
					expect([path, method, answer.status, answer.headers.getSetCookie()]).toEqual([path, method, 404, []]);
				}
			}
		}
		expect(await directory("directory").resolve("mallory")).toBeNull();
		// Only what the ingress sent reaches the gateway.
		expect((await ask("/auth/username?name=mallory", { ingress: null })).status).toBe(403);
		expect((await ask("/auth/username?name=mallory", { ingress: "another-secret-0123456789abcdef0123456789" })).status).toBe(403);
		expect((await ask("/auth/username?name=mallory")).status).toBe(200);
		// Only at Pim's own address: not loopback, another host, plain HTTP or another port, and no header makes one so.
		const spoofs = { "x-forwarded-host": "pim.test", "x-forwarded-proto": "https", forwarded: "host=pim.test;proto=https", "x-original-host": "pim.test", "mf-original-hostname": "pim.test" };
		for (const at of ["http://127.0.0.1:8787", "http://localhost:8787", "https://evil.example", "http://pim.test", "https://pim.test:8443", "https://sub.pim.test"]) {
			for (const headers of [{}, spoofs]) {
				const answer = await ask("/auth/username?name=mallory", { at, headers });
				expect([at, answer.status, await answer.json()]).toEqual([at, 421, { error: "This preview answers only at its own address." }]);
			}
			expect([at, (await ask("/auth/register", { at, body: { username: "mallory", claim: CODE } })).status]).toEqual([at, 421]);
		}
		// At Pim's address, the same headers change nothing.
		expect((await ask("/auth/username?name=mallory", { headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", forwarded: "host=evil.example;proto=http" } })).status).toBe(200);
		// Set up wrong, it answers nothing at all rather than fall back to the local preview.
		for (const [key, value] of [
			["PIM_INGRESS_SECRET", "short"],
			["PREVIEW_EVAL_CLAIM_SHA256", "not-a-digest"],
			["PIM_PUBLIC_URL", "http://localhost:8787"],
			["PIM_PUBLIC_URL", "https://PIM.test"],
			["PREVIEW_MODE", "eval"],
		] as const) {
			const before = settings[key];
			settings[key] = value;
			expect([key, value, (await ask("/auth/username?name=mallory")).status]).toEqual([key, value, 503]);
			expect([key, value, (await ask("/__dev/sign-in/mallory", { ingress: null })).status]).toEqual([key, value, 503]);
			settings[key] = before;
		}
		expect(refusals()).toEqual(["ingress", "ingress", "claim-digest", "claim-digest", "public-url", "public-url", "public-url", "public-url", "mode", "mode"]);
		expect(await directory("directory").resolve("mallory")).toBeNull();
		expect(JSON.stringify(logged)).not.toMatch(/#claim=|#setup=/);
	});

	it("sets its one owner up once, with the operator's claim code, keeps registration closed whatever the environment says, and never sets one up again", async () => {
		await evaluation();
		// The environment says registration is open; the evaluation doesn't take it.
		expect(settings.PIM_REGISTRATION).toBe("open");
		const { ask, register, directory } = worker();
		expect(await refusal(await register("mallory"))).toEqual([403, "Registration is closed."]);
		expect(await refusal(await register("mallory", "evalclaim".padEnd(43, "y")))).toEqual([403, "That setup link isn't valid."]);
		expect(await refusal(await register("mallory", "evalclaim"))).toEqual([403, "That setup link isn't valid."]);
		// The browser's Origin is taken as it came: from another site, or from the loopback address Wrangler listens on, the operator's code claims nothing.
		for (const origin of ["https://evil.example", "http://127.0.0.1:8787", "http://pim.test"]) {
			const answer = await ask("/auth/register", { body: { username: "mallory", claim: CODE }, headers: { origin } });
			expect([origin, ...(await refusal(answer))]).toEqual([origin, 403, "Requests must come from this app"]);
		}
		// A wrong code, or one from another site, changes nothing: the operator's still claims, once.
		const claimed = await register("evalowner", CODE);
		expect(claimed.status).toBe(201);
		const body = (await claimed.json()) as { role: string; setup: string };
		expect(body.role).toBe("admin");
		const owner = body.setup.split(".")[0]!;
		expect(await refusal(await register("evalsecond", CODE))).toEqual([403, ONCE]);
		expect(await refusal(await register("evalowner", CODE))).toEqual([403, ONCE]);
		expect(await refusal(await register("evalsecond"))).toEqual([403, "Registration is closed."]);
		// Asked directly, two days later, when the owner's registration would have lapsed without a passkey, and after the Directory restarted.
		const dir = directory("directory");
		const later = { username: "evallater", ip: "192.0.2.41", claim: { window: true, code: CODE }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 }, now: Date.now() + 2 * 24 * 60 * 60 * 1000 } as const;
		expect(await dir.register(later)).toEqual({ ok: false, status: 403, error: ONCE });
		await evictDurableObject(dir);
		expect(await dir.register(later)).toEqual({ ok: false, status: 403, error: ONCE });
		await expect(dir.claimCode()).rejects.toThrow(/makes none/);
		expect(await dir.account(owner)).toMatchObject({ role: "admin", status: "pending" });
		expect(await dir.resolve("evalsecond")).toBeNull();
		expect(await dir.resolve("evallater")).toBeNull();
		// Its record says the claim began before anyone was registered; nothing logged the code or a link.
		const claims = logged.flatMap(([line]) => (typeof line === "string" && line.includes('"preview.eval_claim"') ? [JSON.parse(line) as Record<string, unknown>] : []));
		expect(claims).toEqual([
			{ event: "preview.eval_claim", state: "claiming" },
			{ event: "preview.eval_claim", state: "claimed", owner },
		]);
		const logs = JSON.stringify(logged);
		expect(logs).not.toContain(CODE);
		expect(logs).not.toContain(body.setup);
		expect(logs).not.toMatch(/#claim=|#setup=/);
	});

	it("isn't set up over a Directory that already holds an account, and stays refused", async () => {
		const { register, directory } = worker();
		// Made before the mode was on, as a local preview would have.
		expect((await directory("directory").register({ username: "evalearlier", ip: "192.0.2.42", claim: { window: true }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } })).ok).toBe(true);
		await evaluation();
		expect(await refusal(await register("evalowner", CODE))).toEqual([403, "This Pim already has accounts, so it isn't set up for an evaluation."]);
		expect(await refusal(await register("evalowner", CODE))).toEqual([403, ONCE]);
		expect(await directory("directory").resolve("evalowner")).toBeNull();
	});

	it("lets only its owner's passkey session at Pim's address watch: not an anonymous request or an API token", async () => {
		await evaluation();
		const { ask, register } = worker();
		// The person's sign-up as the web app makes it: the claim, then a passkey made in the ceremony for Pim's own host, which gives the session.
		const claimed = await register("evalwatcher", CODE);
		expect(claimed.status).toBe(201);
		const { setup } = (await claimed.json()) as { setup: string };
		const owner = setup.split(".")[0]!;
		// Forwarded headers naming another host change nothing: the passkey is for Pim's own host.
		const options = await ask("/auth/passkeys/options", { body: { setup }, headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", forwarded: "host=evil.example;proto=http" } });
		expect(options.status).toBe(200);
		const challenge = options.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
		const asked = (await options.json()) as { challenge: string; user: { id: string }; rp: { id: string } };
		expect(asked.rp.id).toBe("pim.test");
		const authenticator = await Authenticator.make("ES256", { rpId: "pim.test", origin: "https://pim.test" });
		const registration = await authenticator.register(asked);
		const created = await ask("/auth/passkeys", { body: { ...registration, name: "Evaluation" }, cookie: challenge });
		expect(created.ok).toBe(true);
		const session = created.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-pim-session="));
		// Host-only: no Domain, so no other host under a shared parent gets it.
		expect(session).toMatch(/^__Host-pim-session=[^;]+; Path=\/; Secure; HttpOnly; SameSite=/);
		expect(session).not.toMatch(/domain=/i);
		const cookie = session!.split(";")[0]!;

		// The fixture seeds the owner's space, as the operator's environment names it once the owner exists.
		configure({ flag: "seed", owner, bridges: bridgesOf(owner) });
		await evictDurableObject(previews.getByName(owner)).catch(() => undefined);
		const listing = await ask("/api/observations", { cookie });
		expect(listing.status).toBe(200);
		expect(await listing.json()).toEqual({ agent: "stand-in", frame: "embeddable", blocked: null, observations: [] });
		expect((await ask("/api/observations")).status).toBe(401);
		const made = await ask("/auth/tokens", { body: { name: "cli" }, cookie });
		expect(made.status).toBe(201);
		const { token } = (await made.json()) as { token: string };
		expect((await ask("/api/observations", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
		expect((await ask("/api/observations", { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://pim.test" } })).status).toBe(401);
		expect(sent).toEqual([]);
	});

	/** The evaluation's claim record as the Directory's storage holds it, read with SQL of the test's own. */
	const claimRow = (dir: DurableObjectStub<EvalDirectory>) =>
		runInDurableObject(dir, (_instance, state) => {
			if (state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preview_eval_claim'").toArray().length === 0) return null;
			return (state.storage.sql.exec("SELECT state, username, owner_id FROM preview_eval_claim").toArray() as Record<string, unknown>[])[0] ?? null;
		});
	const evalClaims = () => logged.flatMap(([line]) => (typeof line === "string" && line.includes('"preview.eval_claim"') ? [JSON.parse(line) as Record<string, unknown>] : []));

	it("records its one claim before anyone is registered: a claim it can't record registers nobody, and two at once make one owner", async () => {
		await evaluation();
		const { register, directory } = worker();
		const dir = directory("directory");
		const registering = vi.spyOn(BaseDirectory.prototype, "register");
		const unwritable = vi.spyOn(ClaimRecord.prototype, "begin");
		try {
			unwritable.mockImplementationOnce(() => {
				throw new Error("The disk is full");
			});
			expect(await refusal(await register("evalfirst", CODE))).toEqual([503, "The claim couldn't be recorded, so nobody was set up."]);
			// Nothing was recorded and nobody registered, so the claim is still to be made.
			expect(registering).not.toHaveBeenCalled();
			expect(await dir.resolve("evalfirst")).toBeNull();
			expect(await claimRow(dir)).toBeNull();
			unwritable.mockRestore();
			// Two claims with the operator's code at once: one is recorded and registers its owner; the other is refused.
			// Both are awaited however either ends, so neither is left running past the test.
			const settled = await Promise.allSettled([register("evala", CODE), register("evalb", CODE)]);
			const answers = settled.map((outcome) => {
				if (outcome.status === "rejected") throw outcome.reason;
				return outcome.value;
			});
			expect(answers.map((answer) => answer.status).sort()).toEqual([201, 403]);
			const loser = answers.find((answer) => answer.status === 403)!;
			expect(((await loser.json()) as { error: string }).error).toBe(ONCE);
			expect(registering).toHaveBeenCalledTimes(1);
			const winner = (await claimRow(dir)) as { state: string; username: string; owner_id: string };
			expect(winner.state).toBe("claimed");
			expect(await dir.account(winner.owner_id)).toMatchObject({ username: winner.username, role: "admin" });
			expect(await dir.resolve(winner.username === "evala" ? "evalb" : "evala")).toBeNull();
			expect(evalClaims().map((line) => line.state)).toEqual(["unrecorded", "claiming", "claimed"]);
		} finally {
			unwritable.mockRestore();
			registering.mockRestore();
		}
	});

	it("keeps its record however the registration ends, refused, thrown or unrecorded at the end, and never claims again", async () => {
		await evaluation();
		const later = (username: string) => ({ username, ip: "192.0.2.43", claim: { window: false, code: CODE }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } }) as const;

		// The Directory refuses the registration (no registrations left for the address): the claim is spent.
		const refusedOne = worker();
		const refusedDir = refusedOne.directory("directory");
		expect(await refusedDir.register({ ...later("evalrefused"), policy: { mode: "open", maxAccounts: null, perAddressPerDay: 0 } })).toMatchObject({ ok: false, status: 429 });
		expect(await claimRow(refusedDir)).toMatchObject({ state: "failed", owner_id: null });
		expect(await refusal(await refusedOne.register("evalrefused", CODE))).toEqual([403, ONCE]);

		// The registration throws, and the record can't be moved on either: it stays `claiming`, and the first failure is the one thrown.
		const thrownOne = worker();
		const thrownDir = thrownOne.directory("directory");
		const throwing = vi.spyOn(BaseDirectory.prototype, "register");
		const stuck = vi.spyOn(ClaimRecord.prototype, "finish");
		try {
			throwing.mockRejectedValueOnce(new Error("The Directory went away"));
			stuck.mockImplementationOnce(() => {
				throw new Error("The disk is full");
			});
			await expect(thrownDir.register(later("evalthrown"))).rejects.toThrow(/The Directory went away/);
		} finally {
			throwing.mockRestore();
			stuck.mockRestore();
		}
		expect(await claimRow(thrownDir)).toMatchObject({ state: "claiming", owner_id: null });
		expect(await thrownDir.resolve("evalthrown")).toBeNull();
		expect(await refusal(await thrownOne.register("evalthrown", CODE))).toEqual([403, ONCE]);

		// The owner is registered but the last write fails: the record stays `claiming`, which refuses as surely, and says so in the log.
		const unrecordedOne = worker();
		const unrecordedDir = unrecordedOne.directory("directory");
		const unfinished = vi.spyOn(ClaimRecord.prototype, "finish");
		let owner = "";
		try {
			unfinished.mockImplementationOnce(() => {
				throw new Error("The disk is full");
			});
			const claimed = await unrecordedOne.register("evalunrecorded", CODE);
			expect(claimed.status).toBe(201);
			owner = ((await claimed.json()) as { setup: string }).setup.split(".")[0]!;
		} finally {
			unfinished.mockRestore();
		}
		expect(await claimRow(unrecordedDir)).toMatchObject({ state: "claiming", owner_id: null });
		expect(evalClaims().at(-1)).toEqual({ event: "preview.eval_claim", state: "claiming", unrecorded: "claimed", owner });
		// Restarted, and two days later: still refused, and nothing reset the record.
		await evictDurableObject(unrecordedDir);
		expect(await unrecordedDir.register({ ...later("evalagain"), now: Date.now() + 2 * 24 * 60 * 60 * 1000 })).toEqual({ ok: false, status: 403, error: ONCE });
		expect(await claimRow(unrecordedDir)).toMatchObject({ state: "claiming" });
		expect(await unrecordedDir.account(owner)).toMatchObject({ role: "admin" });
		expect(JSON.stringify(logged)).not.toContain(CODE);
	});
});
