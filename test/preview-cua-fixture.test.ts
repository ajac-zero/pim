import * as fs from "node:fs/promises";
import { getAgentByName } from "agents";
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Relay, type Session, type SessionEvents, serveWithWebSocketPair } from "../computer/cua-bridge";
import { Link, type Machine } from "../computer/pim-computer";
import { FIXTURE_KEY, LEASE_ID } from "../preview/cua-fixture";
import { currentTrace } from "../src/computer-control-runtime";
import { PROVIDER_KEY } from "../src/cua";
import { initialObservationState, type ObservationState } from "../src/cua-observation";
import { OBSERVATION_KEY } from "../src/cua-observation-runtime";
import { OWNER_HEADER, Pim as RealPim, SIGNED_IN_HEADER } from "../src/pim";
import { type Approval, PimStore } from "../src/store";
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
			const fault = failing(key, when);
			logged.length = 0;
			configure({ flag: "seed", owner: one.owner, bridges: bridgesOf(one.owner) });
			// The start that failed, and every one after it, opted in or not, serves nothing and reaches nothing.
			expect(await tryEverything(one), name).toEqual(refusedEverything);
			expect(fixtureLines()[0], name).toEqual({ event: "preview.cua_fixture", space: one.owner, outcome: "failed", reason: "seed" });
			expect(fixtureLines().slice(1).every((line) => line.outcome === "interrupted"), name).toBe(true);
			fault.mockRestore();
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
		configure({ flag: "seed", owner: one.owner, bridges: bridgesOf(one.owner) });
		expect(await tryEverything(one)).toEqual(refusedEverything);
		expect(fixtureLines()[0]).toEqual({ event: "preview.cua_fixture", space: one.owner, outcome: "failed", reason: "record" });
		expect(sent).toEqual([]);
		fault.mockRestore();
		expect(await one.peek()).toEqual(nothing);
		// Nothing says a seed was tried: this start can't know, and seeds.
		expect(await one.restart()).toBe("started");
		expect((await one.stored())[FIXTURE_KEY]).toBe("seeded");
	});
});

describe("a seeded preview space and its bridge", () => {
	/** The space's bridge: the relay, whose sessions record what reached them and run nothing. */
	async function bridge(owner: string) {
		const root = `/tmp/preview-cua-fixture-${crypto.randomUUID()}`;
		await fs.mkdir(root, { recursive: true });
		const seen = { connections: 0, sent: [] as string[], ran: [] as string[] };
		const machine: Machine = {
			root: await fs.realpath(root),
			exec: async (args) => {
				seen.ran.push(args.command);
				return { exitCode: 0, signal: null, stdout: `ran ${args.command}\n`, stderr: "", timedOut: false, truncated: false };
			},
		};
		const open = async (events: SessionEvents): Promise<Session> => {
			const link = new Link(machine, (message) => events.message(message));
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
		return seen;
	}

	it("sends the preview model's shell call only after the person approves it, once, to the owner's bridge", async () => {
		const ada = await space("fixtureapproval");
		// The preview's own policy: the majordomo reviews, and the preview model asks the person about everything.
		await ada.within((instance) => instance.applySettings({ approvalPolicy: "majordomo" }));
		configure({ flag: "seed", owner: ada.owner, bridges: bridgesOf(ada.owner) });
		expect(await ada.restart()).toBe("started");
		const seen = await bridge(ada.owner);

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
