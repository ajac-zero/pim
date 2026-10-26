import * as fs from "node:fs/promises";
import { getAgentByName } from "agents";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Relay, type Session, type SessionEvents, serveWithWebSocketPair } from "../computer/cua-bridge";
import { Link, type Machine } from "../computer/pim-computer";
import { FIXTURE_KEY, LEASE_ID, seedCuaFixture } from "../preview/cua-fixture";
import { currentTrace } from "../src/computer-control-runtime";
import { PROVIDER_KEY } from "../src/cua";
import { OWNER_HEADER, Pim as RealPim } from "../src/pim";
import type { Approval } from "../src/store";
import { PreviewPim } from "./worker";

/**
 * The preview's one-shot Cua fixture (preview/cua-fixture.ts), run by the
 * preview's own `Pim` (preview/worker.ts), which vitest.config.ts binds as
 * `PREVIEW_PIM` for these tests only. Each start below is a real one: the
 * Durable Object is evicted (`evictDurableObject`, which ends its instance
 * and keeps its storage) and the next call makes a new instance, whose
 * constructor runs the fixture. That is a restart of one object in the
 * local test runtime, not of a running preview (`wrangler dev`). The bridge
 * is the reviewed relay behind an injected `fetch`, with in-memory sessions
 * that run nothing.
 */

const TOKEN = "preview-cua-fixture-token-0123456789abcdef";
const HOST = "https://bridge.preview-fixture.test";
const CONTROL_KEY = "computer_control";
/** Everything the fixture reads or writes. */
const KEYS = [PROVIDER_KEY, CONTROL_KEY, FIXTURE_KEY, "computer_token", "computer_machine"];

type Space = Awaited<ReturnType<typeof space>>;

const previews = (env as unknown as { PREVIEW_PIM: DurableObjectNamespace<PreviewPim> }).PREVIEW_PIM;
const settings = env as unknown as Record<string, unknown>;
const bridgeOf = (owner: string, changes: Record<string, unknown> = {}) => ({ url: `${HOST}/${owner}`, token: TOKEN, ...changes });
const marker = (owner: string) => JSON.stringify({ provider: "cua", space: owner });

/** What the preview's private environment holds: the fixture's opt-in and owner, and `CUA_BRIDGES`. */
function configure(values: { flag?: string; owner?: string; bridges?: unknown }) {
	for (const [key, value] of [
		["PREVIEW_CUA_FIXTURE", values.flag],
		["PREVIEW_CUA_FIXTURE_OWNER", values.owner],
		["CUA_BRIDGES", values.bridges === undefined || typeof values.bridges === "string" ? values.bridges : JSON.stringify(values.bridges)],
	] as const) {
		if (value === undefined) delete settings[key];
		else settings[key] = value;
	}
}

/** A person registered and provisioned in the preview with the fixture off, as an operator gets an owner ID before opting in. */
async function space(username: string) {
	configure({});
	const directory = env.Directory.getByName("directory");
	const registered = await directory.register({ username, ip: "192.0.2.10", claim: { window: true }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
	if (!registered.ok) throw new Error(registered.error);
	const owner = registered.account.ownerId;
	await directory.activate(owner);
	await (await getAgentByName(previews, owner)).provision({ ownerId: owner, username });
	const stub = previews.getByName(owner);
	const within = <T>(fn: (instance: PreviewPim, state: DurableObjectState) => T | Promise<T>) => runInDurableObject(stub, fn);
	return {
		owner,
		stub,
		within,
		/** The space ended and started again: a new instance, whose constructor runs the fixture with what `configure` set. */
		restart: async () => {
			await evictDurableObject(stub);
			return within((instance) => instance.constructor.name);
		},
		/** What the space holds under the fixture's keys, raw. */
		stored: () => within((instance) => Object.fromEntries(KEYS.map((key) => [key, instance.store.meta(key) ?? null]))),
		/** Asks the space's own `fetch`, as the Worker forwards an API request. */
		fetch: async <T = any>(path: string, init: RequestInit = {}) => {
			const response = await stub.fetch(new Request(`https://pim.test${path}`, { ...init, headers: { [OWNER_HEADER]: owner, "content-type": "application/json", ...(init.headers as Record<string, string>) } }));
			return { status: response.status, body: (await response.json()) as T };
		},
	};
}

const nothing = { [PROVIDER_KEY]: null, [CONTROL_KEY]: null, [FIXTURE_KEY]: null, computer_token: null, computer_machine: null };

const logged: unknown[][] = [];
/** The fixture's own log lines, parsed. */
const fixtureLines = () =>
	logged.flatMap(([line]) => {
		if (typeof line !== "string" || !line.includes('"preview.cua_fixture"')) return [];
		return [JSON.parse(line) as Record<string, unknown>];
	});

beforeEach(() => {
	logged.length = 0;
	for (const method of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
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

	it("does nothing when it is off, opted in with anything but `seed`, or names another space", async () => {
		const ada = await space("fixtureoff");
		const bob = await space("fixtureother");
		const bridges = { [ada.owner]: bridgeOf(ada.owner), [bob.owner]: bridgeOf(bob.owner) };
		for (const values of [{ owner: ada.owner, bridges }, { flag: "1", owner: ada.owner, bridges }, { flag: "SEED", owner: ada.owner, bridges }, { flag: "seed", owner: bob.owner, bridges }]) {
			configure(values);
			await ada.restart();
			expect(await ada.stored(), JSON.stringify(values.flag ?? null)).toEqual(nothing);
		}
		expect(fixtureLines()).toEqual([]);
		// The space named, but not provisioned yet, is refused before anything is stored, and a malformed owner refuses every space.
		configure({ flag: "seed", owner: "o_not-an-owner", bridges });
		await ada.restart();
		expect(await ada.stored()).toEqual(nothing);
		expect(fixtureLines()).toEqual([{ event: "preview.cua_fixture", space: ada.owner, outcome: "refused", reason: "owner" }]);
		expect(await bob.stored()).toEqual(nothing);
	});

	it("refuses, storing nothing, a space without a usable bridge for exactly its owner, or that isn't provisioned", async () => {
		const ada = await space("fixturebridge");
		const other = "o_" + "z".repeat(26);
		const cases: [string, unknown][] = [
			["no secret", undefined],
			["not JSON", "{not json"],
			["another owner's entry only", { [other]: bridgeOf(other) }],
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
			await ada.restart();
			expect(await ada.stored(), name).toEqual(nothing);
			expect(fixtureLines(), name).toEqual([{ event: "preview.cua_fixture", space: ada.owner, outcome: "refused", reason: "bridge" }]);
		}

		// A space whose owner profile isn't there (not provisioned, or erased) is refused too.
		logged.length = 0;
		configure({});
		await ada.within((instance) => instance.store.deleteMeta("owner"));
		configure({ flag: "seed", owner: ada.owner, bridges: { [ada.owner]: bridgeOf(ada.owner) } });
		await ada.restart();
		expect(await ada.stored()).toEqual(nothing);
		expect(fixtureLines()).toEqual([{ event: "preview.cua_fixture", space: ada.owner, outcome: "refused", reason: "space" }]);
	});

	it("refuses, changing nothing, a space that already holds a marker, any control state, a computer or another record", async () => {
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
			["a paired computer", { computer_token: "hash" }, "computer"],
			["a Sprite", { computer_machine: "pim-sprite" }, "computer"],
			["a record it doesn't know", { [FIXTURE_KEY]: "done" }, "record"],
		];
		for (const [name, held, reason] of cases) {
			const one = await space(`fixturec${cases.findIndex(([each]) => each === name)}`);
			const values = Object.fromEntries(Object.entries(held).map(([key, value]) => [key, value.replace("SPACE", one.owner).replace("MARKER", marker(one.owner))]));
			await one.within((instance) => {
				for (const [key, value] of Object.entries(values)) instance.store.setMeta(key, value);
			});
			const before = await one.stored();
			logged.length = 0;
			configure({ flag: "seed", owner: one.owner, bridges: { [one.owner]: bridgeOf(one.owner) } });
			await one.restart();
			expect(await one.stored(), name).toEqual(before);
			expect(fixtureLines(), name).toEqual([{ event: "preview.cua_fixture", space: one.owner, outcome: "refused", reason }]);
			// Nothing resumed or renewed: a blocked state stays blocked.
			if (name.includes("unknown")) expect(await one.within((instance) => instance.control.state?.requests[0]?.status)).toBe("unknown");
		}
	});

	it("seeds the designated space once, with its marker and a lease, and leaves every other space as it was", async () => {
		const ada = await space("fixtureseed");
		const bob = await space("fixtureseedbob");
		configure({ flag: "seed", owner: ada.owner, bridges: { [ada.owner]: bridgeOf(ada.owner), [bob.owner]: bridgeOf(bob.owner) } });
		await ada.restart();
		await bob.restart();

		const stored = await ada.stored();
		expect(stored[PROVIDER_KEY]).toBe(marker(ada.owner));
		expect(stored[FIXTURE_KEY]).toBe("seeded");
		const state = await ada.within((instance) => ({ enabled: instance.control.enabled, blocked: instance.control.blocked, state: instance.control.state, selected: instance.computer.selected() }));
		expect(state).toEqual({
			enabled: true,
			blocked: null,
			selected: "cua",
			state: { version: 1, epoch: 1, owner: "agent", lease: { epoch: 1, leaseId: LEASE_ID }, inputQuiescence: "unproven", requests: [], viewers: [] },
		});
		expect(fixtureLines()).toEqual([{ event: "preview.cua_fixture", space: ada.owner, outcome: "seeded" }]);
		// Neither the bridge's address nor its token is in the space's storage.
		const everything = await runInDurableObject(ada.stub, (_instance, state) => JSON.stringify(state.storage.sql.exec("SELECT * FROM pim_meta").toArray()));
		expect(everything).not.toContain(TOKEN);
		expect(everything).not.toContain("bridge.preview-fixture.test");

		// Bob, with a bridge of his own in the secret, is not the space named: nothing of his changed.
		expect(await bob.stored()).toEqual(nothing);
		expect(await bob.within((instance) => [instance.control.enabled, instance.computer.selected()])).toEqual([false, null]);
		// The person's own routes offer no takeover, and keep refusing to pair or remove the computer.
		expect((await ada.fetch("/computer")).body).toMatchObject({ provider: "cua", startable: false });
		expect((await ada.fetch("/browser")).body).toMatchObject({ takeOver: false });
		expect((await ada.fetch("/computer", { method: "DELETE" })).status).toBe(409);
	});

	it("leaves a seeded space as it is at every later start: nothing is re-enabled, resumed or renewed", async () => {
		const ada = await space("fixturerestart");
		configure({ flag: "seed", owner: ada.owner, bridges: { [ada.owner]: bridgeOf(ada.owner) } });
		await ada.restart();
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
		logged.length = 0;
		await ada.restart();
		expect(await ada.stored()).toEqual(blocked);
		expect(await ada.within((instance) => instance.control.state?.requests)).toEqual([{ requestId: "request-1", agentId: "agent", epoch: 1, status: "unknown" }]);
		expect(fixtureLines()).toEqual([{ event: "preview.cua_fixture", space: ada.owner, outcome: "already-seeded" }]);

		// The person in control (as a takeover leaves it), or the control state gone: neither is given back to the agent.
		await ada.within((instance) => void instance.control.apply({ type: "takeover" }));
		const human = await ada.stored();
		await ada.restart();
		expect(await ada.stored()).toEqual(human);
		expect(await ada.within((instance) => [instance.control.state?.owner, instance.control.state?.lease])).toEqual(["human", null]);
		await ada.within((instance) => instance.store.deleteMeta(CONTROL_KEY));
		await ada.restart();
		expect((await ada.stored())[CONTROL_KEY]).toBeNull();
		expect(await ada.within((instance) => instance.control.enabled)).toBe(false);
	});

	it("never tries again once it began: a failed or interrupted seed leaves only its record, and the space reaches no computer", async () => {
		const bridges = (owner: string) => ({ [owner]: bridgeOf(owner) });
		/** Runs the fixture in the space as its constructor does, with one write or wait made to fail. */
		const failing = (one: Space, fail: { key?: string; when?: (value: string) => boolean; sync?: boolean }) =>
			one.within(async (instance, state) =>
				seedCuaFixture(
					{
						name: state.id.name,
						meta: {
							meta: (key) => instance.store.meta(key),
							setMeta: (key, value) => {
								if (key === fail.key && (fail.when?.(value) ?? true)) throw new Error("disk full");
								instance.store.setMeta(key, value);
							},
						},
						transaction: (fn) => state.storage.transactionSync(fn),
						sync: () => (fail.sync ? Promise.reject(new Error("disk gone")) : state.storage.sync()),
					},
					{ PREVIEW_CUA_FIXTURE: "seed", PREVIEW_CUA_FIXTURE_OWNER: one.owner, CUA_BRIDGES: JSON.stringify(bridges(one.owner)) },
				),
			);

		// Each write in the transaction failing: the marker, enabling, the lease, and the `seeded` record.
		const writes: [string, { key: string; when?: (value: string) => boolean }][] = [
			["the marker", { key: PROVIDER_KEY }],
			["enabling", { key: CONTROL_KEY, when: (value) => value.includes('"owner":"human"') }],
			["the lease", { key: CONTROL_KEY, when: (value) => value.includes('"owner":"agent"') }],
			["the seeded record", { key: FIXTURE_KEY, when: (value) => value === "seeded" }],
		];
		for (const [index, [name, fail]] of writes.entries()) {
			const one = await space(`fixturefail${index}`);
			expect(await failing(one, fail), name).toEqual({ outcome: "failed", reason: "seed" });
			// Only the record that it began: the transaction kept nothing else.
			expect(await one.stored(), name).toEqual({ ...nothing, [FIXTURE_KEY]: "seeding" });
			// The space's own coordinator, made after, reads what was stored: not opted in, and no operator's computer.
			expect(await one.within((instance) => [instance.control.enabled, instance.computer.selected()]), name).toEqual([false, null]);

			// Started again, opted in and with a usable bridge, it does nothing.
			logged.length = 0;
			configure({ flag: "seed", owner: one.owner, bridges: bridges(one.owner) });
			await one.restart();
			expect(await one.stored(), name).toEqual({ ...nothing, [FIXTURE_KEY]: "seeding" });
			expect(fixtureLines(), name).toEqual([{ event: "preview.cua_fixture", space: one.owner, outcome: "interrupted" }]);
			configure({});
		}

		// The record written and not known to be on disk: the same, at the next start.
		const unsynced = await space("fixtureunsynced");
		expect(await failing(unsynced, { sync: true })).toEqual({ outcome: "failed", reason: "record" });
		expect(await unsynced.stored()).toEqual({ ...nothing, [FIXTURE_KEY]: "seeding" });
		configure({ flag: "seed", owner: unsynced.owner, bridges: bridges(unsynced.owner) });
		await unsynced.restart();
		expect(await unsynced.stored()).toEqual({ ...nothing, [FIXTURE_KEY]: "seeding" });
		configure({});

		// The record itself not stored: nothing is, so the next start is the first (the one failure it can't record).
		const unrecorded = await space("fixtureunrecorded");
		expect(await failing(unrecorded, { key: FIXTURE_KEY })).toEqual({ outcome: "failed", reason: "record" });
		expect(await unrecorded.stored()).toEqual(nothing);
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
			if (url.href !== `${HOST}/${owner}`) throw new Error(`This test reaches only its bridge, not ${url.href}`);
			seen.connections++;
			return await serveWithWebSocketPair(relay, new Request(input, init));
		});
		return seen;
	}

	it("sends the preview model's shell call only after the person approves it, once, to the owner's bridge", async () => {
		const ada = await space("fixtureapproval");
		// The preview's own policy: the majordomo reviews, and the preview model asks the person about everything.
		await ada.within((instance) => instance.applySettings({ approvalPolicy: "majordomo" }));
		configure({ flag: "seed", owner: ada.owner, bridges: { [ada.owner]: bridgeOf(ada.owner) } });
		await ada.restart();
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
		// Filed, reviewed and escalated: nothing has reached the bridge.
		expect(seen).toEqual({ connections: 0, sent: [], ran: [] });

		expect((await ada.fetch(`/approvals/${pending.id}/approve`, { method: "POST", body: "{}" })).status).toBe(200);
		await vi.waitFor(() => expect(seen.ran).toEqual(["echo fixture"]), { timeout: 15_000, interval: 200 });
		expect(seen.connections).toBe(1);
		expect(seen.sent.filter((message) => message.includes("echo fixture"))).toHaveLength(1);
		await vi.waitFor(async () => expect((await ada.within((instance) => instance.control.state))?.requests).toEqual([expect.objectContaining({ requestId: `approval:${pending.id}`, status: "completed" })]));
	});
});
