import * as fs from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type LogEntry, Relay, type Session, type SessionEvents, serveWithWebSocketPair } from "../computer/cua-bridge";
import { Link, type Machine } from "../computer/pim-computer";
import { ControlCoordinator } from "../src/computer-control-runtime";
import type { ControlState } from "../src/computer-control";
import { PROVIDER_KEY } from "../src/cua";
import type { Approval } from "../src/store";
import { api, opens, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

/**
 * Pim's own selection and admission of a Cua computer (the real Durable
 * Object, `selection`, `bridgeFor`, `Cua`, `#controlled` and the control
 * coordinator), joined to the reviewed relay (computer/cua-bridge.ts).
 * Application integration only, in the local test runtime. Real: the Pim
 * Durable Object, the relay and its `WebSocketPair` adapter, Pim's `Cua`
 * connector, pim-computer's `Link`. Injected: `fetch` (answered in this
 * process by the relay), and each `OpenSession`, which is in memory and
 * whose commands only record what they were asked. No process, shell,
 * browser, host adapter, session launcher or network is involved, so this
 * says nothing of a VM, a host, a real network upgrade, or whether input has
 * quiesced anywhere.
 */

const TOKEN = "cua-relay-qualification-token-0123456789abcdef";
const WRONG_TOKEN = "cua-relay-qualification-wrongone-0123456789abc";
const HOST = "https://bridge.cua.test";

/** What a space's session did: its commands, how many sessions were asked for, and what the relay logged. */
type Fixture = {
	relay: Relay;
	/** Sessions the relay asked this fixture to open: a connection that passed the relay's checks. */
	opened: number;
	/** What reached a session's `send`: the only commands that reached the computer. */
	sent: string[];
	/** What the session's pim-computer ran, by command line. */
	ran: string[];
	/** Requests that reached the relay's adapter at all, whether it refused or took them. */
	connections: number;
	/** The relay's refusals and events. */
	logged: LogEntry[];
	/** Set to "drop" and a session that gets a command closes without answering it. */
	mode: "answer" | "drop";
};

/** `owner`'s bridge: a relay for that space, serving `/<owner>` with `token`, whose sessions are in memory. */
async function relayFor(owner: string, token = TOKEN): Promise<Fixture> {
	const root = `/tmp/cua-relay-qualification-${crypto.randomUUID()}`;
	await fs.mkdir(root, { recursive: true });
	const ran: string[] = [];
	const machine: Machine = {
		root: await fs.realpath(root),
		exec: async (args) => {
			ran.push(args.command);
			return { exitCode: 0, signal: null, stdout: `ran ${args.command}\n`, stderr: "", timedOut: false, truncated: false };
		},
	};
	const fixture: Fixture = { relay: undefined as unknown as Relay, opened: 0, sent: [], ran, connections: 0, logged: [], mode: "answer" };
	const open = async (events: SessionEvents): Promise<Session> => {
		fixture.opened++;
		const link = new Link(machine, (message) => events.message(message));
		events.message(JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/test", hostname: "cua-vm", platform: "linux", arch: "x64", user: "desktop", root: machine.root, browser: null }));
		return {
			send(message) {
				fixture.sent.push(message);
				if (fixture.mode === "drop") queueMicrotask(() => events.closed());
				else link.receive(message);
			},
			close: () => link.close(),
		};
	};
	fixture.relay = new Relay({ space: owner, token, path: `/${owner}`, open, log: (entry) => fixture.logged.push(entry) });
	return fixture;
}

const ownerPath = (owner: string) => `${HOST}/${owner}`;
const choice = (owner: string) => JSON.stringify({ provider: "cua", space: owner });
const entry = (owner: string, changes: Record<string, unknown> = {}) => ({ url: ownerPath(owner), token: TOKEN, ...changes });
const secretEnv = (instance: Pim) => (instance as unknown as { env: Record<string, unknown> }).env;

function lastToolResult(messages: readonly Message[]) {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const fixtures = new Map<string, Fixture>();
/** Every request made to anything but a space's own bridge, Sprites least of all: none should be. */
const elsewhere: string[] = [];
const logged: unknown[][] = [];

/** A space whose operator's marker is stored before it first runs, as the docs have it, with its person's API. */
async function space(username: string) {
	const directory = env.Directory.getByName("directory");
	const registered = await directory.register({ username, ip: "192.0.2.9", claim: { window: true }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
	if (!registered.ok) throw new Error(registered.error);
	const owner = registered.account.ownerId;
	await directory.activate(owner);
	const within = <T>(fn: (instance: Pim) => T | Promise<T>) => runInDurableObject(env.Pim.getByName(owner), (instance: Pim) => fn(instance));
	await within((instance) => instance.store.setMeta(PROVIDER_KEY, choice(owner)));
	fixtures.set(owner, await within(() => relayFor(owner)));
	const agent = await getAgentByName(env.Pim, owner);
	await agent.provision({ ownerId: owner, username });
	const token = (await env.Auth.getByName(owner).createToken(owner, "tests", Date.now())).token;
	const call = <T = any>(path: string, init: RequestInit = {}) => api<T>(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) } });
	const root: string = (await call("/")).body.rootSession;
	const post = <T = any>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });
	const self = {
		owner,
		token,
		api: call,
		post,
		within,
		fixture: () => fixtures.get(owner)!,
		stateOf: async (): Promise<ControlState> => (await within((instance) => instance.control.state))!,
		/** Only tests seed a control lease; nothing in Pim enables, resumes or takes over. */
		seed: (leaseId: string) =>
			within((instance) => {
				instance.control.enable();
				return instance.control.apply({ type: "resume", leaseId });
			}),
		/** As after a restart, for what can be: the control state read anew from what the space stored. */
		reread: () =>
			within((instance) => {
				const storage = { read: () => instance.store.meta("computer_control"), write: (value: string) => instance.store.setMeta("computer_control", value) };
				Object.defineProperty(instance, "control", { configurable: true, value: new ControlCoordinator(instance.name, storage) });
			}),
		/** The agent asks to run `command`, it is approved, and the turn ends: what the agent heard. */
		async run(command: string) {
			let result = "";
			faux.setResponses([() => toolUse("shell", { command }), (context) => ((result = lastToolResult(context.messages)), toolUse("send_to_user", { message: "Ok." }))]);
			const turn = post(`/sessions/${root}/messages`, { content: "Run it", wait: true });
			const pending = await vi.waitFor(
				async () => {
					const [approval] = (await call<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals;
					expect(approval).toBeDefined();
					return approval!;
				},
				{ timeout: 15_000, interval: 200 },
			);
			await post(`/approvals/${pending.id}/approve`);
			await turn;
			return result;
		},
	};
	return self;
}

type Space = Awaited<ReturnType<typeof space>>;

/** The commands a space's session got, as pim-computer's calls. */
const commandsOf = (fixture: Fixture) => fixture.sent.map((message) => JSON.parse(message));

describe("Pim's Cua selection and admission, joined to the relay", () => {
	let ada: Space;
	let bob: Space;

	beforeAll(async () => {
		ada = await space("relayada");
		bob = await space("relaybob");
		// The Worker's secret is one for every space.
		await ada.within((instance) => {
			secretEnv(instance).CUA_BRIDGES = JSON.stringify({ [ada.owner]: entry(ada.owner), [bob.owner]: entry(bob.owner) });
		});
	});

	// Mocks are restored after each test, so they are made before each.
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const fixture = url.origin === HOST ? fixtures.get(url.pathname.slice(1)) : undefined;
			if (!fixture) {
				elsewhere.push(url.href);
				throw new Error(`This test reaches only its relays, not ${url.href}`);
			}
			fixture.connections++;
			return await serveWithWebSocketPair(fixture.relay, new Request(input, init));
		});
		for (const method of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
	});

	afterEach(() => {
		expect(elsewhere).toEqual([]);
	});

	/** Counts of what each space's relay has done, to compare before and after. */
	const counts = (...spaces: Space[]) => spaces.map((one) => [one.fixture().connections, one.fixture().opened, one.fixture().sent.length]);

	it("sends one authorized command to exactly the matching owner's session, and none to another space's", async () => {
		await ada.seed("lease-ada");
		const before = counts(ada, bob);
		const heard = await ada.run("echo qualified");
		expect(heard).toContain("ran echo qualified");

		const [adaCounts, bobCounts] = counts(ada, bob);
		// One connection, one session and one command, all of the matching owner's relay.
		expect(adaCounts).toEqual([before[0]![0]! + 1, before[0]![1]! + 1, before[0]![2]! + 1]);
		expect(bobCounts).toEqual(before[1]);
		expect(commandsOf(ada.fixture()).at(-1)).toMatchObject({ type: "call" });
		expect(ada.fixture().sent.at(-1)).toContain("echo qualified");
		expect(ada.fixture().ran).toEqual(["echo qualified"]);
		expect(bob.fixture().ran).toEqual([]);
		expect((await ada.stateOf()).requests).toEqual([expect.objectContaining({ status: "completed" })]);
		expect((await ada.api("/computer")).body).toMatchObject({ state: "online", provider: "cua", computer: { hostname: "cua-vm" } });
	});

	it("sends nothing without an admission: no control state, a damaged one, or the person's control", async () => {
		const quiet = await space("relayquiet");
		await quiet.within((instance) => {
			secretEnv(instance).CUA_BRIDGES = JSON.stringify({ [quiet.owner]: entry(quiet.owner) });
		});
		const refused = () => counts(quiet);
		const start = refused();

		expect(await quiet.run("echo none")).toMatch(/it has none\), so nothing was sent/);
		await quiet.within((instance) => instance.store.setMeta("computer_control", "not json"));
		await quiet.reread();
		expect(await quiet.run("echo damaged")).toMatch(/not JSON\), so nothing was sent/);
		await quiet.within((instance) => instance.store.deleteMeta("computer_control"));
		await quiet.reread();
		await quiet.within((instance) => instance.control.enable());
		expect(await quiet.run("echo human")).toMatch(/not filed under a lease\), so nothing was sent/);

		// Not even a connection, let alone a session or a command.
		expect(refused()).toEqual(start);
		expect(quiet.fixture().ran).toEqual([]);
		expect(quiet.fixture().logged).toEqual([]);
	});

	it("refuses a bridge for another owner, or with another token, at the relay: a connection, but no session and no command", async () => {
		const guarded = await space("relayguard");
		await guarded.seed("lease-guard");
		const secret = (value: Record<string, unknown>) => guarded.within((instance) => void (secretEnv(instance).CUA_BRIDGES = JSON.stringify({ [guarded.owner]: value })));
		const cases: [string, Record<string, unknown>, RegExp, number][] = [
			// Pim connects to the relay of another space, naming this one: the relay refuses the space.
			["another owner's address", entry(guarded.owner, { url: ownerPath(ada.owner) }), /refused the connection \(403\)/, 403],
			// The right address with a token the relay doesn't hold.
			["another token", entry(guarded.owner, { token: WRONG_TOKEN }), /refused the connection \(401\)/, 401],
		];
		for (const [name, value, message, status] of cases) {
			await secret(value);
			const target = value.url === ownerPath(ada.owner) ? ada : guarded;
			const before = counts(ada, guarded);
			const result = await guarded.run(`echo ${status}`);
			expect(result, name).toMatch(message);
			expect(result).not.toContain(TOKEN);
			expect(result).not.toContain(WRONG_TOKEN);
			const [adaNow, guardedNow] = counts(ada, guarded);
			// A connection was made, and refused: no session was opened, and no command was sent, by either relay.
			const [seen, other] = target === ada ? [adaNow, guardedNow] : [guardedNow, adaNow];
			const [seenBefore, otherBefore] = target === ada ? before : [before[1], before[0]];
			expect(seen, name).toEqual([seenBefore![0]! + 1, seenBefore![1], seenBefore![2]]);
			expect(other, name).toEqual(otherBefore);
			expect(target.fixture().logged.at(-1), name).toEqual({ event: "bridge.refused", reason: expect.any(String), status });
			expect((await guarded.stateOf()).requests.at(-1), name).toMatchObject({ status: "rejected" });
		}
		expect(guarded.fixture().ran).toEqual([]);
		expect(ada.fixture().sent).toHaveLength(1);
		await secret(entry(guarded.owner));
	});

	it("blocks on a command a session took and ended without answering, replays nothing, and tries no other computer", async () => {
		const dropped = await space("relaydrop");
		await dropped.within((instance) => void (secretEnv(instance).CUA_BRIDGES = JSON.stringify({ [dropped.owner]: entry(dropped.owner) })));
		await dropped.seed("lease-drop");
		dropped.fixture().mode = "drop";
		await dropped.run("echo dropped");
		expect((await dropped.stateOf()).requests.at(-1)).toMatchObject({ status: "unknown" });
		expect(dropped.fixture().sent).toHaveLength(1);

		// A later request, with the session answering again, is refused: nothing connects, sends or falls back.
		dropped.fixture().mode = "answer";
		const before = counts(dropped);
		expect(await dropped.run("echo later")).toMatch(/blocked|nothing was sent/);
		expect(counts(dropped)).toEqual(before);
		expect(dropped.fixture().ran).toEqual([]);

		// The control state read anew from what the space stored (the supported helper; a whole Durable Object restart isn't done here) is as blocked.
		await dropped.reread();
		expect((await dropped.stateOf()).requests.at(-1)).toMatchObject({ status: "unknown" });
		expect(await dropped.run("echo after reread")).toMatch(/blocked|nothing was sent/);
		expect(counts(dropped)).toEqual(before);
		expect(dropped.fixture().ran).toEqual([]);
		// Neither a paired computer nor a Sprite was reached or recorded; the elsewhere check after each test covers Sprites' address.
		expect(await dropped.within((instance) => ["computer_token", "computer_machine"].map((key) => instance.store.meta(key) ?? null))).toEqual([null, null]);
	});

	it("keeps the bridge's secrets out of what people and logs see, and offers no takeover, with input quiescence unproven", async () => {
		const status = await ada.api("/computer");
		const stored = await runInDurableObject(env.Pim.getByName(ada.owner), (_instance: Pim, state) => JSON.stringify(state.storage.sql.exec("SELECT * FROM pim_meta").toArray()));
		const visible = JSON.stringify([status.body, (await ada.api("/browser")).body, (await ada.stateOf()), stored, logged, ada.fixture().logged, bob.fixture().logged]);
		for (const secret of [TOKEN, WRONG_TOKEN, "bridge.cua.test"]) expect(visible, secret).not.toContain(secret);

		expect(status.body).toEqual({ state: "online", managed: false, pairedAt: null, computer: expect.any(Object), provider: "cua", startable: false });
		expect((await ada.api("/browser")).body).toEqual(expect.objectContaining({ takeOver: false }));
		const live = await opens("/browser/live", ada.token);
		const closed = new Promise<CloseEvent>((resolve) => live.webSocket!.addEventListener("close", resolve));
		live.webSocket!.accept();
		expect((await closed).code).toBe(4005);
		expect((await ada.api("/computer", { method: "DELETE" })).status).toBe(409);
		expect((await ada.post("/computer")).status).toBe(409);
		expect((await ada.stateOf()).inputQuiescence).toBe("unproven");
		// Tests alone seeded the lease: the state says the agent owns it, and that nothing is proved of the machine.
		expect((await ada.stateOf()).owner).toBe("agent");
	});
});
