import * as fs from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type BrowserHost, type ExecArgs, type ExecResult, Link, type Machine } from "../computer/pim-computer";
import { Computer, IDLE_MS } from "../src/computer";
import { ControlCoordinator, type DispatchTrace, dispatchTrace } from "../src/computer-control-runtime";
import type { ControlState } from "../src/computer-control";
import { CONNECT_MS, Cua, type CuaBridge, MAX_MESSAGE_CHARS, PROVIDER_KEY, SPACE_HEADER } from "../src/cua";
import type { Approval } from "../src/store";
import { exports } from "cloudflare:workers";
import { api, apiUrl, connectTestComputer, fakeChrome, lastUserText, OWNER, opens, post, setup, toolUse, waits } from "./helpers";
import { requestLabel } from "./waits";
import { faux, type Pim } from "./worker";

/**
 * The Cua bridge's link (src/cua.ts), on its own and in a space whose
 * operator chose it. These tests give it their own `fetch`: what answers is
 * a bridge in this process, a WebSocketPair with pim-computer's real `Link`
 * over a test folder behind it. Nothing here reaches the network, and
 * nothing a fixture receives says what a real VM would do.
 */

const SPACE = "o_0123456789abcdefghijklmnop";
const OTHER = "o_zyxwvutsrqponmlkjihgfedcba";
const TOKEN = "cua-bridge-test-token-0123456789abcdef";
const URL_ = "https://bridge.cua.test/pim";
const BRIDGE: CuaBridge = { space: SPACE, url: URL_, token: TOKEN };

type Seen = { url: string; init: RequestInit | undefined; headers: Headers };

/** A bridge's connection, as the test sees it from the bridge's side. */
type Connection = { client: WebSocket; server: WebSocket; received: string[]; closed: CloseEvent | null };

/**
 * A fetch that answers as a bridge does: takes the WebSocket, names the space
 * back, and says hello as pim-computer, whose `Link` answers what arrives
 * unless `relay` is false.
 */
async function bridge(options: { relay?: boolean; space?: string; exec?: (args: ExecArgs) => Promise<ExecResult>; browser?: BrowserHost } = {}) {
	const root = `/tmp/cua-${crypto.randomUUID()}`;
	await fs.mkdir(root, { recursive: true });
	const machine: Machine = {
		root: await fs.realpath(root),
		exec: options.exec ?? (async (args: ExecArgs) => ({ exitCode: 0, signal: null, stdout: `ran ${args.command}\n`, stderr: "", timedOut: false, truncated: false })),
		...(options.browser ? { browser: options.browser } : {}),
	};
	const seen: Seen[] = [];
	const connections: Connection[] = [];
	const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		seen.push({ url, init, headers: new Headers(init?.headers) });
		const { 0: client, 1: server } = new WebSocketPair();
		server.accept();
		const connection: Connection = { client, server, received: [], closed: null };
		connections.push(connection);
		const link = new Link(machine, (message) => server.readyState === WebSocket.OPEN && server.send(message));
		server.addEventListener("message", (event) => {
			connection.received.push(event.data as string);
			if (options.relay !== false) link.receive(event.data as string);
		});
		server.addEventListener("close", (event) => {
			connection.closed = event;
			link.close();
		});
		server.send(JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/test", hostname: "cua-vm", platform: "linux", arch: "x64", user: "desktop", root: machine.root, browser: options.browser ? "chrome" : null }));
		return new Response(null, { status: 101, webSocket: client, headers: { [SPACE_HEADER]: options.space ?? SPACE } });
	});
	return { root: machine.root, seen, connections, fetch: fetcher as unknown as typeof fetch, calls: fetcher };
}

/** A Computer that wakes through `cua`, as one for a computer Pim started does: the link on its own, apart from how a space chooses it (below). */
function computerOn(cua: Cua, space = SPACE) {
	const meta = new Map<string, string>();
	const computer: Computer = new Computer({
		meta: { meta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value), deleteMeta: (key) => meta.delete(key) },
		sockets: () => [],
		wake: () =>
			cua.connect(
				space,
				(message) => computer.receive(message),
				() => computer.disconnected(),
			),
		inUse: () => false,
	});
	computer.started("cua-test", Date.now());
	return { computer, meta };
}

const trace = (): DispatchTrace => ({ sent: false, uncertain: false, awaiting: new Set(), settled: false });

describe("a computer reached through a Cua bridge", () => {
	it("speaks pim-computer's protocol through Computer, with the token only in its header", async () => {
		const test = await bridge();
		const { computer, meta } = computerOn(new Cua(BRIDGE, test.fetch));

		await computer.fs.writeFile("/workspace/notes.md", "Through the bridge");
		expect(await fs.readFile(`${test.root}/notes.md`, "utf8")).toBe("Through the bridge");
		expect(await new Response(await computer.fs.readFile("/workspace/notes.md")).text()).toBe("Through the bridge");
		expect(await computer.exec("uname")).toMatchObject({ exitCode: 0, stdout: "ran uname\n" });
		expect(computer.status()).toMatchObject({ state: "online", managed: true, computer: { hostname: "cua-vm", user: "desktop" } });

		// One connection, to the address as given, with the token and the space in headers and no redirects followed.
		expect(test.seen).toHaveLength(1);
		const [request] = test.seen;
		expect(request!.url).toBe(URL_);
		expect(request!.init?.redirect).toBe("manual");
		expect(request!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
		expect(request!.headers.get("Upgrade")).toBe("websocket");
		expect(request!.headers.get(SPACE_HEADER)).toBe(SPACE);
		// The space keeps nothing of the bridge's token.
		expect(JSON.stringify([...meta])).not.toContain(TOKEN);

		// Unused, the space lets go, which closes the bridge's connection; needed again, it connects again.
		computer.letGoIfIdle(Date.now() + IDLE_MS);
		await vi.waitFor(() => expect(test.connections[0]!.closed?.code).toBe(1000));
		expect(computer.status().state).toBe("offline");
		await computer.fs.writeFile("/workspace/notes.md", "Again");
		expect(test.seen).toHaveLength(2);
		expect(await fs.readFile(`${test.root}/notes.md`, "utf8")).toBe("Again");
	});

	it("refuses a bridge for another space, or one unsafe to send the token to, before reaching the network", async () => {
		const test = await bridge();
		const refusals: [CuaBridge, string, RegExp][] = [
			[{ ...BRIDGE, space: OTHER }, SPACE, /another space/],
			[BRIDGE, OTHER, /another space/],
			[{ ...BRIDGE, space: "" }, "", /another space/],
			[{ ...BRIDGE, space: SPACE.toUpperCase() }, SPACE.toUpperCase(), /another space/],
			[{ ...BRIDGE, url: "http://bridge.cua.test/pim" }, SPACE, /HTTPS/],
			[{ ...BRIDGE, url: "wss://bridge.cua.test/pim" }, SPACE, /HTTPS/],
			[{ ...BRIDGE, url: "https://pim:secret@bridge.cua.test/pim" }, SPACE, /HTTPS/],
			[{ ...BRIDGE, url: `https://bridge.cua.test/pim?token=${TOKEN}` }, SPACE, /HTTPS/],
			[{ ...BRIDGE, url: "https://bridge.cua.test/pim?" }, SPACE, /HTTPS/],
			[{ ...BRIDGE, url: "https://bridge.cua.test/pim#token" }, SPACE, /HTTPS/],
			[{ ...BRIDGE, url: "bridge.cua.test/pim" }, SPACE, /HTTPS/],
			[{ ...BRIDGE, token: "" }, SPACE, /token/],
			[{ ...BRIDGE, token: "short" }, SPACE, /token/],
			[{ ...BRIDGE, token: `${TOKEN} x` }, SPACE, /token/],
			[{ ...BRIDGE, token: `${TOKEN}\r\nx-evil: 1` }, SPACE, /token/],
		];
		for (const [config, space, message] of refusals) {
			const error = await new Cua(config, test.fetch).connect(space, () => undefined, () => undefined).catch((caught: Error) => caught);
			expect(error, JSON.stringify(config)).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(message);
			expect((error as Error).message).not.toContain(TOKEN);
		}
		expect(test.calls).not.toHaveBeenCalled();

		// Through Computer: the call fails having sent nothing.
		const { computer } = computerOn(new Cua({ ...BRIDGE, space: OTHER }, test.fetch));
		const request = trace();
		await expect(dispatchTrace.run(request, () => computer.exec("uname"))).rejects.toThrow(/another space/);
		expect(request).toMatchObject({ sent: false, uncertain: false });
		expect(test.calls).not.toHaveBeenCalled();
	});

	it("follows no redirect, and tries nothing again when the bridge refuses", async () => {
		const answers: [Response, RegExp][] = [
			[new Response(null, { status: 302, headers: { location: "https://elsewhere.test/steal" } }), /redirect/],
			[new Response(null, { status: 307, headers: { location: "https://bridge.cua.test/other" } }), /redirect/],
			[new Response("no", { status: 401 }), /refused the connection \(401\)/],
			[new Response("busy", { status: 503 }), /refused the connection \(503\)/],
			[new Response("ok", { status: 200 }), /refused the connection \(200\)/],
		];
		for (const [response, message] of answers) {
			const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
			const closed = vi.fn();
			await expect(new Cua(BRIDGE, fetcher as unknown as typeof fetch).connect(SPACE, () => undefined, closed)).rejects.toThrow(message);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0]![1]?.redirect).toBe("manual");
			expect(closed).not.toHaveBeenCalled();
		}

		// A bridge that takes the connection without naming this space back isn't used, and its socket is closed.
		for (const named of [null, OTHER]) {
			const { 0: client, 1: server } = new WebSocketPair();
			server.accept();
			const shut = new Promise<CloseEvent>((resolve) => server.addEventListener("close", resolve));
			const fetcher = async () => new Response(null, { status: 101, webSocket: client, headers: named ? { [SPACE_HEADER]: named } : {} });
			await expect(new Cua(BRIDGE, fetcher as unknown as typeof fetch).connect(SPACE, () => undefined, () => undefined)).rejects.toThrow(/didn't name this space/);
			expect((await shut).code).toBe(1008);
		}
	});

	it("passes on and logs nothing of what a failing fetch throws, which may carry the token", async () => {
		const logged: unknown[][] = [];
		for (const method of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
		const named = new TypeError(`fetch failed for ${URL_}`);
		Object.defineProperty(named, "name", { value: `Bearer ${TOKEN}` });
		const thrown: unknown[] = [named, { name: TOKEN, message: TOKEN, cause: TOKEN }, `fetch failed with ${TOKEN}`, null, undefined];
		try {
			for (const value of thrown) {
				const fetcher = vi.fn(async () => {
					throw value;
				});
				const error = await new Cua(BRIDGE, fetcher as unknown as typeof fetch).connect(SPACE, () => undefined, () => undefined).catch((caught: Error) => caught);
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toMatch(/couldn't reach/);
				expect(JSON.stringify({ ...(error as Error), message: (error as Error).message, name: (error as Error).name })).not.toContain(TOKEN);
				expect(fetcher).toHaveBeenCalledTimes(1);
			}
			expect(logged).toEqual(thrown.map(() => [JSON.stringify({ event: "cua.unreachable" })]));
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("gives up on a bridge that doesn't answer in time, once, and uses nothing it answers after", async () => {
		vi.useFakeTimers();
		try {
			// A fetch that waits until it's aborted, as the Worker's does.
			const signals: AbortSignal[] = [];
			const pending = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						signals.push(init!.signal!);
						init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
					}),
			);
			const { computer } = computerOn(new Cua(BRIDGE, pending as unknown as typeof fetch));
			const request = trace();
			const answer = dispatchTrace.run(request, () => computer.exec("uname")).catch((error: Error) => error);
			await vi.advanceTimersByTimeAsync(CONNECT_MS - 1);
			expect(signals[0]!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(signals[0]!.aborted).toBe(true);
			expect(((await answer) as Error).message).toMatch(/didn't answer within 30 seconds/);
			expect(((await answer) as Error).message).not.toContain(TOKEN);
			expect(request).toMatchObject({ sent: false, uncertain: false });
			expect(pending).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);

			// A fetch that answers after Pim gave up, ignoring the abort: its socket is closed, and not used.
			const { 0: client, 1: server } = new WebSocketPair();
			server.accept();
			const shut = new Promise<CloseEvent>((resolve) => server.addEventListener("close", resolve));
			const slow = vi.fn(
				() =>
					new Promise<Response>((resolve) =>
						setTimeout(() => resolve(new Response(null, { status: 101, webSocket: client, headers: { [SPACE_HEADER]: SPACE } })), CONNECT_MS + 1_000),
					),
			);
			const closed = vi.fn();
			const late = new Cua(BRIDGE, slow as unknown as typeof fetch).connect(SPACE, () => undefined, closed).catch((error: Error) => error);
			await vi.advanceTimersByTimeAsync(CONNECT_MS + 1_000);
			expect(((await late) as Error).message).toMatch(/didn't answer within 30 seconds/);
			expect((await shut).code).toBe(1008);
			expect(closed).not.toHaveBeenCalled();
			expect(slow).toHaveBeenCalledTimes(1);

			// One that answers in time leaves no timer behind.
			const test = await bridge();
			const link = await new Cua(BRIDGE, test.fetch).connect(SPACE, () => undefined, () => undefined);
			expect(vi.getTimerCount()).toBe(0);
			link.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("ends the link and closes its socket on an error, and takes nothing after", async () => {
		// Through Computer: a call waiting when the socket errors fails, and may have run.
		const test = await bridge({ relay: false });
		const { computer } = computerOn(new Cua(BRIDGE, test.fetch));
		const request = trace();
		const answer = dispatchTrace.run(request, () => computer.call("stat", { path: "/workspace" })).catch((error: Error) => error);
		await vi.waitFor(() => expect(test.connections[0]?.received).toHaveLength(1));
		test.connections[0]!.client.dispatchEvent(new Event("error"));
		expect(((await answer) as Error).message).toMatch(/disconnected before it answered/);
		expect(request).toMatchObject({ sent: true, uncertain: true });
		await vi.waitFor(() => expect(test.connections[0]!.closed?.code).toBe(1011));
		expect(computer.status().state).toBe("offline");

		// A socket whose close throws: the link ends all the same, once, and nothing more is sent or taken.
		const other = await bridge({ relay: false });
		const receive = vi.fn();
		const closed = vi.fn();
		const link = await new Cua(BRIDGE, other.fetch).connect(SPACE, receive, closed);
		await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
		const { client, server, received } = other.connections[0]!;
		const close = vi.spyOn(client, "close").mockImplementation(() => {
			throw new Error("close failed");
		});
		client.dispatchEvent(new Event("error"));
		expect(close).toHaveBeenCalledWith(1011, "Error");
		expect(closed).toHaveBeenCalledTimes(1);
		expect(link.readyState).toBe(WebSocket.CLOSED);
		expect(() => link.send('{"type":"call","id":"1","op":"stat","args":{}}')).toThrow(/nothing was sent/);
		server.send(JSON.stringify({ type: "reply", id: "1", result: {} }));
		client.dispatchEvent(new Event("error"));
		link.close();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(receive).toHaveBeenCalledTimes(1);
		expect(received).toEqual([]);
		expect(closed).toHaveBeenCalledTimes(1);
		close.mockRestore();
		client.close(1000);
	});

	it("ignores what isn't JSON, and ends the connection on a binary or oversized message", async () => {
		for (const [bad, code] of [
			[new Uint8Array([1, 2, 3]), 1003],
			["x".repeat(MAX_MESSAGE_CHARS + 1), 1009],
		] as const) {
			const test = await bridge({ relay: false });
			const { computer } = computerOn(new Cua(BRIDGE, test.fetch));
			const request = trace();
			const answer = dispatchTrace.run(request, () => computer.call("stat", { path: "/workspace" })).catch((error: Error) => error);
			await vi.waitFor(() => expect(test.connections[0]?.received).toHaveLength(1));
			const { id } = JSON.parse(test.connections[0]!.received[0]!) as { id: string };
			const { server } = test.connections[0]!;

			// Not JSON, or a reply to nothing asked: ignored, and the call still waits.
			server.send("not json");
			server.send(JSON.stringify({ type: "reply", id: "someone-else", result: { size: 1 } }));
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(computer.status().state).toBe("online");

			// What the protocol has no place for ends the connection; the call's own reply after it changes nothing.
			server.send(bad);
			server.send(JSON.stringify({ type: "reply", id, result: { size: 1 } }));
			const error = await answer;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/disconnected before it answered/);
			expect(request).toMatchObject({ sent: true, uncertain: true });
			await vi.waitFor(() => expect(test.connections[0]!.closed?.code).toBe(code));
			expect(computer.status().state).toBe("offline");
		}
	});

	it("sends nothing it can't send whole, and nothing after the connection ends", async () => {
		const test = await bridge({ relay: false });
		const closed = vi.fn();
		const link = await new Cua(BRIDGE, test.fetch).connect(SPACE, () => undefined, closed);
		expect(() => link.send("y".repeat(MAX_MESSAGE_CHARS + 1))).toThrow(/too big/);
		link.send('{"type":"call","id":"1","op":"stat","args":{}}');
		await vi.waitFor(() => expect(test.connections[0]!.received).toEqual(['{"type":"call","id":"1","op":"stat","args":{}}']));
		test.connections[0]!.server.close(1011, "Gone");
		await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
		expect(link.readyState).toBe(WebSocket.CLOSED);
		expect(() => link.send('{"type":"call","id":"2","op":"stat","args":{}}')).toThrow(/nothing was sent/);
		link.close();
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it("leaves a call the bridge took and didn't answer unknown, and never sends it again", async () => {
		const test = await bridge({ relay: false });
		const { computer } = computerOn(new Cua(BRIDGE, test.fetch));
		const request = trace();
		const answer = dispatchTrace.run(request, () => computer.exec("make deploy")).catch((error: Error) => error);
		await vi.waitFor(() => expect(test.connections[0]?.received).toHaveLength(1));
		const first = JSON.parse(test.connections[0]!.received[0]!) as { id: string; op: string; args: { command: string } };
		expect(first).toMatchObject({ type: "call", op: "exec", args: { command: "make deploy" } });

		// The bridge has it, which answers nothing: the call still waits.
		const settled = vi.fn();
		void answer.then(settled);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).not.toHaveBeenCalled();
		expect(request).toMatchObject({ sent: true, uncertain: false });

		// The connection ends before an answer: the call fails, and may have run.
		test.connections[0]!.server.close(1011, "Gone");
		expect(((await answer) as Error).message).toMatch(/disconnected before it answered/);
		expect(request).toMatchObject({ sent: true, uncertain: true });

		// The next call connects again, and only it is sent there.
		const next = computer.exec("date").catch((error: Error) => error);
		await vi.waitFor(() => expect(test.connections[1]?.received).toHaveLength(1));
		const second = JSON.parse(test.connections[1]!.received[0]!) as { id: string; args: { command: string } };
		expect(second.args.command).toBe("date");
		expect(second.id).not.toBe(first.id);
		expect(test.connections[1]!.received.join("\n")).not.toContain("make deploy");
		test.connections[1]!.server.close(1011, "Gone");
		await next;
		expect(test.seen).toHaveLength(2);
	});
});

describe("a space whose operator chose its Cua VM", () => {
	type Fixture = Awaited<ReturnType<typeof bridge>> & { ran: string[] };
	/** Each space's bridge, at `https://bridge.cua.test/<owner>`, naming that space back. */
	const fixtures = new Map<string, Fixture>();
	/** Every request a space made that wasn't to a bridge: none should be, to Sprites least of all. */
	const elsewhere: string[] = [];
	/** What a bridge answers in place of taking the connection, when a test says so, and the requests it answered so. */
	let refusal: (() => Response) | null = null;
	const refused: string[] = [];
	/** Held, a command the bridge's pim-computer got doesn't answer. Each is a test's gate (`waits().gate`), opened after it at the latest. */
	let hold: Promise<void> | null = null;
	/** Held, a bridge takes no connection yet; `held` counts those waiting. */
	let handshake: Promise<void> | null = null;
	let held = 0;
	/** Scripted answers some request other than the turn they were scripted for took, by tool and step. */
	const strays: string[] = [];
	/** What answers the Sprites API, in the tests that start a Sprite. */
	let sprites: ((request: Request) => Promise<Response>) | null = null;
	const chrome = fakeChrome();
	const ok = (command: string): ExecResult => ({ exitCode: 0, signal: null, stdout: `ran ${command}\n`, stderr: "", timedOut: false, truncated: false });

	/** A bridge for `owner`'s space, whose files are made in that space's own /tmp, where its pim-computer works. */
	async function fixtureFor(owner: string): Promise<Fixture> {
		const ran: string[] = [];
		const made = await runInDurableObject(env.Pim.getByName(owner), () => bridge({
			space: owner,
			browser: chrome.host,
			exec: async (args) => {
				ran.push(args.command);
				await hold;
				return ok(args.command);
			},
		}));
		const fixture = { ...made, ran };
		fixtures.set(owner, fixture);
		return fixture;
	}

	beforeEach((context) => {
		// Beside the waits helpers.ts reports: where the bridge stood, as the test ran out of time if it did, by counts only.
		const state = () => {
			const connections = fixture?.connections ?? [];
			return JSON.stringify({ event: "cua.state", held, handshake: handshake !== null, hold: hold !== null, connections: connections.length, open: connections.filter((each) => each.closed === null).length, strays: [...strays] });
		};
		let atTimeout: string | undefined;
		context.signal.addEventListener("abort", () => void (atTimeout = state()), { once: true });
		context.onTestFailed(() => console.info(atTimeout ?? state()));
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (sprites && url.host === "api.sprites.dev") return sprites(new Request(input, init));
			const fixture = url.origin === "https://bridge.cua.test" ? fixtures.get(url.pathname.slice(1)) : undefined;
			if (!fixture) {
				elsewhere.push(url.href);
				throw new Error(`This test reaches only Cua bridges, not ${url.href}`);
			}
			if (handshake) {
				held++;
				await handshake;
			}
			if (refusal) {
				refused.push(url.href);
				return refusal();
			}
			return fixture.fetch(input, init);
		});
	});

	afterEach(() => {
		// The gates themselves are opened after this, with the test's waits (test/helpers.ts); later requests aren't held.
		handshake = hold = null;
	});

	const choice = (owner: string) => JSON.stringify({ provider: "cua", space: owner });
	const bridges = (entries: Record<string, unknown>) => JSON.stringify(entries);
	const bridgeOf = (owner: string) => ({ url: `https://bridge.cua.test/${owner}`, token: TOKEN });

	/**
	 * A space as the operator sets one up: its choice and the Worker's
	 * secret in place before the space first runs, so its tools are those of
	 * a space with that computer. Then the person's API, with a token of theirs.
	 */
	async function space(username: string, setUp: (instance: Pim, owner: string) => void) {
		const directory = env.Directory.getByName("directory");
		const registered = await waits().start("space: register", () => directory.register({ username, ip: "192.0.2.9", claim: { window: true }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } }));
		if (!registered.ok) throw new Error(registered.error);
		const owner = registered.account.ownerId;
		await waits().start("space: activate", () => directory.activate(owner));
		// Before the space first starts, which sets up its tools.
		await waits().start("space: operator's choice", () => runInDurableObject(env.Pim.getByName(owner), (instance: Pim) => setUp(instance, owner)));
		const agent = await waits().start("space: start", () => getAgentByName(env.Pim, owner));
		await waits().start("space: provision", () => agent.provision({ ownerId: owner, username }));
		const token = (await waits().start("space: token", () => env.Auth.getByName(owner).createToken(owner, "tests", Date.now()))).token;
		return inside(owner, token);
	}

	/** A space, through the person's API with `token`, and from inside, as tests reach it. */
	async function inside(owner: string, token: string) {
		// Each request, and each step inside the space, is started through the test's waits: none starts once the test has run out of time, and each must finish after it.
		const call = <T = any>(path: string, init: RequestInit = {}) => {
			const request = new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });
			return waits().start(requestLabel(request), async () => {
				const response = await exports.default.fetch(request);
				return { status: response.status, body: (await response.json()) as T };
			});
		};
		const root: string = (await call("/")).body.rootSession;
		const within = <T>(fn: (instance: Pim) => T | Promise<T>) => waits().start("in the space", () => runInDurableObject(env.Pim.getByName(owner), (instance: Pim) => fn(instance)));
		const self = {
			owner,
			token,
			api: call,
			post: <T = any>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) }),
			within,
			setBridges: (value: string | undefined) =>
				within((instance) => {
					const vars = (instance as unknown as { env: Record<string, unknown> }).env;
					if (value === undefined) delete vars.CUA_BRIDGES;
					else vars.CUA_BRIDGES = value;
				}),
			stateOf: async (): Promise<ControlState> => (await within((instance) => instance.control.state))!,
			grant: (leaseId: string) => within((instance) => instance.control.apply({ type: "resume", leaseId })),
			/** As after a restart: the control state read anew from storage. */
			reread: () =>
				within((instance) => {
					const storage = { read: () => instance.store.meta("computer_control"), write: (value: string) => instance.store.setMeta("computer_control", value) };
					Object.defineProperty(instance, "control", { configurable: true, value: new ControlCoordinator(instance.name, storage) });
				}),
			/** The agent calls `name`; resolves once the turn is over, with what the call returned and how the tool was described. */
			uses(name: string, args: Record<string, unknown>) {
				let result = "";
				let description = "";
				const content = `Use ${name}`;
				const stray = (context: { messages: readonly Message[] }, step: number) => void (lastUserText(context.messages) !== content && strays.push(`${name} ${step}`));
				// The scripted answers are set as the turn starts, so a test that ran out of time sets none.
				const turn = waits().start(`turn: ${name}`, () => {
					faux.setResponses([
						(context) => {
							stray(context, 1);
							const added = context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []));
							description = added.findLast((tool) => tool.name === name)?.description ?? "";
							return toolUse(name, args as never);
						},
						(context) => {
							stray(context, 2);
							result = lastToolResult(context.messages);
							return toolUse("send_to_user", { message: "Ok." });
						},
					]);
					return self.post(`/sessions/${root}/messages`, { content, wait: true });
				});
				return { turn, result: () => result, description: () => description };
			},
			pending: () =>
				waits().start("pending approval", () =>
					vi.waitFor(
						async () => {
							const [approval] = (await call<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals;
							expect(approval).toBeDefined();
							return approval!;
						},
						{ timeout: 15_000, interval: 200 },
					),
				),
			decide: (id: string) => self.post(`/approvals/${id}/approve`),
			/** The agent asks to run `command`, it is approved, and the turn ends: what the agent heard. */
			async run(command: string) {
				const asking = self.uses("shell", { command });
				await self.decide((await self.pending()).id);
				await asking.turn;
				return asking.result();
			},
		};
		return self;
	}

	/** The person's API answered as it is, not as JSON. */
	const raw = (path: string, token: string, init: RequestInit = {}) => {
		const request = new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${token}` } });
		return waits().start(requestLabel(request), () => exports.default.fetch(request));
	};

	function lastToolResult(messages: readonly Message[]) {
		const result = messages.findLast((message) => message.role === "toolResult");
		if (!result || result.role !== "toolResult") throw new Error("no tool result");
		return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
	}

	const REFUSED = /nothing was sent/;
	let cua: Awaited<ReturnType<typeof space>>;
	let fixture: Fixture;

	beforeAll(() =>
		setup(async () => {
			cua = await space("cuaperson", (instance, owner) => {
				instance.store.setMeta(PROVIDER_KEY, choice(owner));
				(instance as unknown as { env: Record<string, unknown> }).env.CUA_BRIDGES = bridges({ [owner]: bridgeOf(owner) });
			});
			fixture = await fixtureFor(cua.owner);
		}),
	);

	it("is the operator's: its status names Cua and nothing of the bridge, and no person's route starts, pairs, removes or takes it over", async () => {
		const status = await cua.api("/computer");
		expect(status.body).toEqual({ state: "offline", managed: false, pairedAt: null, computer: null, provider: "cua", startable: false });
		for (const [method, body] of [
			["POST", {}],
			["POST", { managed: true }],
			["DELETE", undefined],
		] as const) {
			const answer = await cua.api("/computer", { method, ...(body ? { body: JSON.stringify(body) } : {}) });
			expect(answer.status, `${method} ${JSON.stringify(body)}`).toBe(409);
			expect(answer.body.error).toContain("chosen and kept by this Pim's operator");
		}
		// Nothing was paired, started or forgotten: the choice is as the operator stored it.
		expect(
			await cua.within((instance) => ["computer_token", "computer_machine", PROVIDER_KEY].map((key) => instance.store.meta(key) ?? null)),
		).toEqual([null, null, choice(cua.owner)]);
		// A paired computer can't connect in its place, whatever token it brings.
		expect((await opens("/computer/connect", `pimc_${cua.owner}_whatever`)).status).toBe(409);

		// No person takes its browser over, closes its windows, or is told they could.
		expect((await cua.api("/browser")).body).toEqual({ available: true, takeOver: false, page: null });
		expect((await cua.api("/browser", { method: "DELETE" })).status).toBe(409);
		const live = await opens("/browser/live", cua.token);
		const heard: unknown[] = [];
		const closed = new Promise<CloseEvent>((resolve) => live.webSocket!.addEventListener("close", resolve));
		live.webSocket!.addEventListener("message", (event) => heard.push(JSON.parse(event.data as string)));
		live.webSocket!.accept();
		expect((await closed).code).toBe(4005);
		expect(heard).toEqual([{ type: "error", message: expect.stringContaining("Taking over the browser isn't available") }]);

		// None of it reached the bridge, Sprites or anywhere else, and nothing told the person anything of the bridge.
		expect(fixture.calls).not.toHaveBeenCalled();
		expect(elsewhere).toEqual([]);
		expect(JSON.stringify(status.body)).not.toMatch(/bridge|cua-bridge-test-token/);
		// Another space's person sees their own computer, not this one.
		expect((await api("/computer")).body).not.toHaveProperty("provider");
	});

	it("sends nothing without a control state that admits the request: none, a damaged one, or the person's", async () => {
		const asking = cua.uses("shell", { command: "echo none" });
		// The tools are a computer's, offered while it's offline, and say nothing of taking over.
		await cua.decide((await cua.pending()).id);
		await asking.turn;
		expect(asking.result()).toMatch(/it has none\), so nothing was sent/);
		const writing = cua.uses("file_write", { path: "/workspace/a.txt", content: "no" });
		await writing.turn;
		expect(writing.result()).toMatch(REFUSED);
		const opening = cua.uses("browser_open", { url: "https://example.com/" });
		await opening.turn;
		expect(opening.result()).toMatch(REFUSED);
		expect(opening.description()).not.toContain("Take over");

		await cua.within((instance) => instance.store.setMeta("computer_control", "not json"));
		await cua.reread();
		expect(await cua.run("echo damaged")).toMatch(/not JSON\), so nothing was sent/);
		await cua.within((instance) => instance.store.deleteMeta("computer_control"));
		await cua.reread();

		// Opted in, the person has control until a lease is given (only tests give one): an approval filed then holds no lease.
		await cua.within((instance) => instance.control.enable());
		expect(await cua.run("echo human")).toMatch(/not filed under a lease\), so nothing was sent/);
		expect([fixture.calls.mock.calls.length, fixture.ran, elsewhere]).toEqual([0, [], []]);
		expect((await cua.stateOf()).requests).toEqual([]);
	});

	it("dispatches approved actions through the bridge, once each, only after approval under the agent's lease", async () => {
		expect(await cua.grant("lease-1")).toEqual({ ok: true });
		const asking = cua.uses("shell", { command: "echo yes" });
		const approval = await cua.pending();
		expect(fixture.calls).not.toHaveBeenCalled();
		await cua.decide(approval.id);
		await asking.turn;
		expect(asking.result()).toContain("ran echo yes");
		expect(fixture.ran).toEqual(["echo yes"]);
		expect((await cua.stateOf()).requests).toEqual([expect.objectContaining({ requestId: `approval:${approval.id}`, status: "completed" })]);

		// One connection, to this space's bridge, with its token only in the header, for this space only.
		expect(fixture.seen).toHaveLength(1);
		expect(fixture.seen[0]!.url).toBe(bridgeOf(cua.owner).url);
		expect(fixture.seen[0]!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
		expect(fixture.seen[0]!.headers.get(SPACE_HEADER)).toBe(cua.owner);
		expect((await cua.api("/computer")).body).toMatchObject({ state: "online", managed: false, provider: "cua", computer: { hostname: "cua-vm" } });
		// The space keeps nothing of the bridge's address or token.
		const kept = await runInDurableObject(env.Pim.getByName(cua.owner), (_instance: Pim, state) => JSON.stringify(state.storage.sql.exec("SELECT * FROM pim_meta").toArray()));
		expect(kept).not.toContain(TOKEN);
		expect(kept).not.toContain("bridge.cua.test");

		// The file tools, and an approved delete, go the same way.
		const writing = cua.uses("file_write", { path: "/workspace/kept.txt", content: "Through the lease" });
		await writing.turn;
		expect(writing.result()).not.toMatch(REFUSED);
		expect(await cua.within(() => fs.readFile(`${fixture.root}/kept.txt`, "utf8"))).toBe("Through the lease");
		const deleting = cua.uses("file_delete", { path: "/workspace/kept.txt" });
		await cua.pending();
		expect(await cua.within(() => fs.readFile(`${fixture.root}/kept.txt`, "utf8"))).toBe("Through the lease");
		await cua.decide((await cua.pending()).id);
		await deleting.turn;
		expect(await cua.within(() => fs.stat(`${fixture.root}/kept.txt`).then(() => "kept", () => "gone"))).toBe("gone");

		// Clicking and typing in its browser: nothing reaches the page until each approval is decided.
		expect((await cua.uses("browser_open", { url: "https://example.com/" }).turn).status).toBe(200);
		const mark = chrome.packets.length;
		const clicking = cua.uses("browser_click", { ref: 1 });
		const click = await cua.pending();
		expect(chrome.sent("Input.dispatchMouseEvent", mark)).toEqual([]);
		await cua.decide(click.id);
		await clicking.turn;
		expect(chrome.sent("Input.dispatchMouseEvent", mark).map((packet) => packet.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
		const typing = cua.uses("browser_type", { ref: 1, text: "hi" });
		const type = await cua.pending();
		expect(chrome.sent("Input.dispatchKeyEvent", mark)).toEqual([]);
		await cua.decide(type.id);
		await typing.turn;
		expect(chrome.sent("Input.dispatchKeyEvent", mark).length).toBeGreaterThan(0);
		expect((await cua.stateOf()).requests.every((request) => request.status === "completed")).toBe(true);
		expect(elsewhere).toEqual([]);
	});

	it("lets the person read files and look at the browser, but sends nothing else of theirs: no write, delete, window closing or input", async () => {
		const before = await cua.stateOf();
		const big = new Uint8Array(1_500_000).map((_, index) => index % 251);
		await cua.within(() => fs.writeFile(`${fixture.root}/big.bin`, big));
		const listed = await cua.api<{ entries: { name: string }[] }>("/files");
		expect(listed.status, JSON.stringify(listed.body)).toBe(200);
		expect(listed.body.entries.map((entry) => entry.name)).toContain("big.bin");
		const read = await raw(`/files/content?path=${encodeURIComponent("/workspace/big.bin")}`, cua.token);
		expect(new Uint8Array(await read.arrayBuffer())).toEqual(big);
		expect((await cua.api("/browser")).body).toMatchObject({ available: true, takeOver: false, page: { url: "https://example.com/" } });

		const put = await raw(`/files/content?path=${encodeURIComponent("/workspace/big.bin")}`, cua.token, { method: "PUT", body: "replaced" });
		expect(put.status).toBe(409);
		expect((await cua.api(`/files?path=${encodeURIComponent("/workspace/big.bin")}`, { method: "DELETE" })).status).toBe(409);
		expect(new Uint8Array(await cua.within(() => fs.readFile(`${fixture.root}/big.bin`)))).toEqual(big);
		const mark = chrome.packets.length;
		expect((await cua.api("/browser", { method: "DELETE" })).status).toBe(409);
		expect(chrome.sent("Target.closeTarget", mark)).toEqual([]);

		// A live view, here under control state too, is refused before it watches; nothing of it reaches the browser.
		const live = await opens("/browser/live", cua.token);
		const closed = new Promise<CloseEvent>((resolve) => live.webSocket!.addEventListener("close", resolve));
		live.webSocket!.accept();
		expect((await closed).code).toBe(4005);
		expect(chrome.packets.slice(mark).filter((packet) => packet.method.startsWith("Input.") || packet.method === "Page.navigate")).toEqual([]);
		// The person's reads are no agent's requests.
		expect(await cua.stateOf()).toEqual(before);
	});

	it("sends nothing on a warm link, or its browser, once the bridge's configuration is gone, unreadable or another, or a paired computer, a Sprite or an unreadable choice is stored beside it", async () => {
		const valid = bridges({ [cua.owner]: bridgeOf(cua.owner) });
		const meta = (key: string, value: string | null) => (instance: Pim) => (value === null ? instance.store.deleteMeta(key) : instance.store.setMeta(key, value));
		const vars = (value: string | null) => (instance: Pim) => {
			const all = (instance as unknown as { env: Record<string, unknown> }).env;
			if (value === null) delete all.CUA_BRIDGES;
			else all.CUA_BRIDGES = value;
		};
		const changes: [string, (instance: Pim) => void, (instance: Pim) => void][] = [
			["no configuration", vars(null), vars(valid)],
			["unreadable configuration", vars("not json"), vars(valid)],
			["a paired computer on record", meta("computer_token", "0".repeat(64)), meta("computer_token", null)],
			["a Sprite on record", meta("computer_machine", "pim-o-sprite-2"), meta("computer_machine", null)],
			["an unreadable choice", meta(PROVIDER_KEY, "garbage"), meta(PROVIDER_KEY, choice(cua.owner))],
		];
		for (const [name, change, undo] of changes) {
			// Warm: the link up, and the browser connected over it.
			const opening = cua.uses("browser_open", { url: "https://example.com/" });
			await opening.turn;
			expect(opening.result(), name).toContain("# Fixture");
			const link = fixture.connections.at(-1)!;
			const [received, packets, connections] = [link.received.length, chrome.packets.length, fixture.seen.length];
			const requests = (await cua.stateOf()).requests.length;

			await cua.within(change);
			const reading = cua.uses("browser_read", {});
			await reading.turn;
			expect(reading.result(), name).not.toContain("# Fixture");
			expect((await cua.api("/browser")).status, name).not.toBe(200);
			expect((await cua.api("/files")).status, name).not.toBe(200);
			const writing = cua.uses("file_write", { path: "/workspace/warm.txt", content: "no" });
			await writing.turn;
			expect(writing.result(), name).toMatch(/nothing was sent|sent nothing/);
			expect(await cua.run("echo warm"), name).toMatch(/nothing was sent|sent nothing/);

			// Nothing reached the old connection or its browser, nothing connected again, and nothing went elsewhere.
			expect([link.received.length, chrome.packets.length, fixture.seen.length, elsewhere], name).toEqual([received, packets, connections, []]);
			expect(fixture.ran, name).not.toContain("echo warm");
			// Refused before sending: no request was left unknown.
			expect((await cua.stateOf()).requests.slice(requests).map((request) => request.status), name).not.toContain("unknown");
			await cua.within(undo);
		}

		// The secret now names another bridge for the space: the old link takes nothing more, and is let go; what follows goes through a connection to the new one.
		const opening = cua.uses("browser_open", { url: "https://example.com/" });
		await opening.turn;
		const old = fixture.connections.at(-1)!;
		const [received, packets, connections] = [old.received.length, chrome.packets.length, fixture.seen.length];
		const other = "another-cua-bridge-token-0123456789abcdef";
		await cua.setBridges(bridges({ [cua.owner]: { ...bridgeOf(cua.owner), token: other } }));
		const reading = cua.uses("browser_read", {});
		await reading.turn;
		expect(reading.result()).toMatch(/changed since it was connected/);
		expect([old.received.length, chrome.packets.length, fixture.seen.length]).toEqual([received, packets, connections]);
		expect(await cua.run("echo moved")).toContain("ran echo moved");
		expect(old.received.length).toBe(received);
		await vi.waitFor(() => expect(old.closed).not.toBeNull());
		expect(fixture.seen.slice(connections).map((seen) => seen.headers.get("Authorization"))).toEqual([`Bearer ${other}`]);
		await cua.setBridges(valid);
	});

	it("sends nothing on a link whose handshake finished after the choice or the bridge changed, and replays nothing after", async () => {
		// The agent's own lease, whatever the tests before left: the space opted in, taken back by the person, then resumed for the agent.
		await cua.within((instance) => instance.control.enable());
		expect(await cua.within((instance) => instance.control.apply({ type: "takeover" }))).toEqual({ ok: true });
		expect(await cua.grant("lease-race")).toEqual({ ok: true });
		const valid = bridges({ [cua.owner]: bridgeOf(cua.owner) });
		const changes: [(instance: Pim) => void, (instance: Pim) => void, RegExp][] = [
			[
				(instance) => void ((instance as unknown as { env: Record<string, unknown> }).env.CUA_BRIDGES = bridges({ [cua.owner]: { ...bridgeOf(cua.owner), token: "another-cua-bridge-token-0123456789abcdef" } })),
				(instance) => void ((instance as unknown as { env: Record<string, unknown> }).env.CUA_BRIDGES = valid),
				/changed since it was connected/,
			],
			[(instance) => instance.store.setMeta(PROVIDER_KEY, "garbage"), (instance) => instance.store.setMeta(PROVIDER_KEY, choice(cua.owner)), /can't be read/],
		];
		for (const [change, undo, message] of changes) {
			await cua.within((instance) => instance.computer.disconnect("Asleep"));
			const { opened, open: release } = waits().gate("bridge handshake");
			// The change is this test's own: undone below, or else after the test by its cleanup, which runs even once the test has run out of time.
			const undone = waits().defer("undo the race's change", () => cua.within(undo));
			handshake = opened;
			held = 0;
			try {
				const asking = cua.uses("shell", { command: "echo raced" });
				const deciding = cua.decide((await cua.pending()).id);
				await waits().watch("held handshake", vi.waitFor(() => expect(held).toBe(1)));
				await cua.within(change);
				if (handshake === opened) handshake = null;
				release();
				await deciding;
				await asking.turn;
				expect(asking.result()).toMatch(message);
				// The bridge took the connection, which carried nothing and was let go: its close event was seen.
				expect(fixture.connections.at(-1)!.received).toEqual([]);
				await waits().watch("raced connection's close event", vi.waitFor(() => expect(fixture.connections.at(-1)!.closed).not.toBeNull()));
				expect((await cua.stateOf()).requests.at(-1)).toMatchObject({ status: "rejected" });
			} finally {
				// The gate is this iteration's own, opened however it ends; a later continuation of it clears no other gate.
				if (handshake === opened) handshake = null;
				release();
			}
			await cua.within(undo);
			undone();
		}
		expect(await cua.run("echo after the race")).toContain("ran echo after the race");
		expect(fixture.ran).not.toContain("echo raced");
	});

	it("sends nothing on a warm Sprite, or its browser, once the operator's choice is stored beside it, readable or not", async () => {
		const spriteChrome = fakeChrome();
		/** What reached pim-computer on the Sprite, a line at a time, and its launches. */
		const lines: string[] = [];
		let launches = 0;
		const frame = (stream: number, text: string) => {
			const bytes = new TextEncoder().encode(text);
			const framed = new Uint8Array(bytes.byteLength + 1);
			framed[0] = stream;
			framed.set(bytes, 1);
			return framed;
		};
		sprites = async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/v1/sprites" && request.method === "POST") return Response.json({ name: (await request.json<{ name: string }>()).name, status: "cold" }, { status: 201 });
			if (!url.pathname.endsWith("/exec")) return new Response(null, { status: 204 });
			const { 0: client, 1: server } = new WebSocketPair();
			server.binaryType = "arraybuffer";
			server.accept();
			if (!url.searchParams.getAll("cmd").some((arg) => arg.includes("--stdio"))) {
				server.send(Uint8Array.of(3, 0));
				return new Response(null, { status: 101, webSocket: client });
			}
			launches++;
			const root = `/tmp/cua-sprite-${crypto.randomUUID()}`;
			await fs.mkdir(root, { recursive: true });
			const machine: Machine = { root: await fs.realpath(root), exec: async (args) => ok(args.command), browser: spriteChrome.host };
			const link = new Link(machine, (message) => server.send(frame(1, `${message}\n`)));
			server.addEventListener("message", (event) => {
				const data = new Uint8Array(event.data as ArrayBuffer);
				if (data[0] !== 0) return;
				for (const line of new TextDecoder().decode(data.subarray(1)).split("\n")) {
					if (!line) continue;
					lines.push(line);
					link.receive(line);
				}
			});
			server.addEventListener("close", () => link.close());
			const hello = { type: "hello", version: 1, agent: "pim-computer/test", hostname: "sprite", platform: "linux", arch: "x64", user: "sprite", root: machine.root, browser: "chrome" };
			server.send(frame(1, `${JSON.stringify(hello)}\n`));
			return new Response(null, { status: 101, webSocket: client });
		};
		try {
			// A space with no choice, whose bridge the secret names anyway: it starts a Sprite, as before, and browses there.
			// (The Worker's secret is one for every space, so it names the other test space's bridge too.)
			const warm = await space("warmsprite", (instance, owner) => {
				(instance as unknown as { env: Record<string, unknown> }).env.CUA_BRIDGES = bridges({ [owner]: bridgeOf(owner), [cua.owner]: bridgeOf(cua.owner) });
			});
			const own = await fixtureFor(warm.owner);
			expect((await warm.post("/computer", { managed: true })).status).toBe(201);
			await warm.within((instance) => {
				instance.control.enable();
				instance.control.apply({ type: "resume", leaseId: "lease-sprite" });
			});
			for (const stored of [choice(warm.owner), "garbage"]) {
				await warm.within((instance) => instance.store.deleteMeta(PROVIDER_KEY));
				const opening = warm.uses("browser_open", { url: "https://example.com/" });
				await opening.turn;
				expect(opening.result()).toContain("# Fixture");
				const [sent, packets] = [lines.length, spriteChrome.packets.length];

				// The operator's choice is stored, with the Sprite still on record, and nothing disconnected.
				await warm.within((instance) => instance.store.setMeta(PROVIDER_KEY, stored));
				const reading = warm.uses("browser_read", {});
				await reading.turn;
				expect(reading.result(), stored).not.toContain("# Fixture");
				expect((await warm.api("/browser")).status, stored).not.toBe(200);
				expect((await warm.api("/files")).status, stored).not.toBe(200);
				expect([lines.length, spriteChrome.packets.length], stored).toEqual([sent, packets]);
			}
			expect([launches, own.calls.mock.calls.length, elsewhere]).toEqual([1, 0, []]);
			expect(await warm.within((instance) => instance.store.meta("computer_machine"))).toEqual(expect.any(String));
		} finally {
			sprites = null;
		}
	});

	it("keeps an approval filed before the bridge's connection dropped, and runs it once on a new connection when decided", async () => {
		const asking = cua.uses("shell", { command: "echo later" });
		const approval = await cua.pending();
		await cua.within(() => fixture.connections.at(-1)!.server.close(1000));
		await vi.waitFor(async () => expect((await cua.api("/computer")).body.state).toBe("offline"));
		const connections = fixture.seen.length;
		await cua.decide(approval.id);
		await asking.turn;
		expect(asking.result()).toContain("ran echo later");
		expect(fixture.seen).toHaveLength(connections + 1);
		expect(fixture.ran.filter((command) => command === "echo later")).toEqual(["echo later"]);
	});

	it("fails closed, with no other computer tried, when its bridge refuses or its configuration is gone, unreadable or another space's, also after a restart", async () => {
		const logged: unknown[][] = [];
		for (const method of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
		const OTHER_OWNER = "o_zyxwvutsrqponmlkjihgfedcba";
		const configs: [string | undefined, RegExp][] = [
			[undefined, /no usable bridge/],
			["not json", /no usable bridge/],
			[bridges({ [OTHER_OWNER]: bridgeOf(cua.owner) }), /no usable bridge/],
			[bridges({ [cua.owner]: { ...bridgeOf(cua.owner), space: OTHER_OWNER } }), /no usable bridge/],
			[bridges({ [cua.owner]: { ...bridgeOf(cua.owner), url: "http://bridge.cua.test/x" } }), /HTTPS/],
		];
		const seen = fixture.seen.length;
		const ran = fixture.ran.length;
		for (const [config, message] of configs) {
			await cua.within((instance) => instance.computer.disconnect("restart"));
			await cua.reread();
			await cua.setBridges(config);
			const result = await cua.run("echo nowhere");
			expect(result, String(config)).toMatch(message);
			expect(result).not.toContain(TOKEN);
			// Nothing left: a definite refusal, which keeps admissions open, and the choice stays.
			expect((await cua.stateOf()).requests.at(-1)).toMatchObject({ status: "rejected" });
			expect((await cua.api("/computer")).body).toMatchObject({ state: "offline", provider: "cua" });
		}
		expect([fixture.seen.length, fixture.ran.length, elsewhere]).toEqual([seen, ran, []]);

		// A bridge that refuses the connection: one try, nothing sent, and nothing else tried.
		await cua.setBridges(bridges({ [cua.owner]: bridgeOf(cua.owner) }));
		refusal = () => new Response("no", { status: 401 });
		try {
			expect(await cua.run("echo refused")).toMatch(/refused the connection \(401\)/);
		} finally {
			refusal = null;
		}
		expect((await cua.stateOf()).requests.at(-1)).toMatchObject({ status: "rejected" });
		expect([refused, fixture.ran.length, elsewhere]).toEqual([[bridgeOf(cua.owner).url], ran, []]);
		expect(JSON.stringify(logged)).not.toContain(TOKEN);
		expect(await cua.run("echo back")).toContain("ran echo back");
	});

	it("blocks on a command the bridge took and never answered, and never sends it again", async () => {
		// Shut for the whole test, so the command is never answered here; opened after the test, with its waits.
		hold = waits().gate("unanswered command").opened;
		const asking = cua.uses("shell", { command: "echo hang" });
		const deciding = cua.decide((await cua.pending()).id);
		await vi.waitFor(() => expect(fixture.ran.at(-1)).toBe("echo hang"));
		// The bridge's end belongs to the space that opened it.
		await cua.within(() => fixture.connections.at(-1)!.server.close(1011, "Gone"));
		await deciding;
		await asking.turn;
		hold = null;
		expect((await cua.stateOf()).requests.at(-1)).toMatchObject({ status: "unknown" });
		const seen = fixture.seen.length;
		expect(await cua.run("echo after")).toMatch(/blocked|nothing was sent/);
		expect(fixture.ran.filter((command) => command === "echo hang")).toHaveLength(1);
		expect(fixture.ran).not.toContain("echo after");
		expect(fixture.seen).toHaveLength(seen);
	});

	it("uses no computer at all while the operator's choice can't be read", async () => {
		for (const stored of ["garbage", JSON.stringify({ provider: "cua", space: "o_zyxwvutsrqponmlkjihgfedcba" }), JSON.stringify({ provider: "cua", space: cua.owner, url: "x" }), JSON.stringify({ provider: "sprites", space: cua.owner })]) {
			await cua.within((instance) => {
				instance.store.setMeta(PROVIDER_KEY, stored);
				instance.computer.disconnect("restart");
			});
			expect((await cua.api("/computer")).body, stored).toMatchObject({ state: "offline", provider: "unreadable", computer: null, startable: false });
			expect((await cua.api("/files")).status).toBe(503);
			expect((await cua.post("/computer")).status).toBe(409);
			expect((await cua.api("/computer", { method: "DELETE" })).status).toBe(409);
			expect((await cua.api("/browser")).body.takeOver).toBe(false);
			const live = await opens("/browser/live", cua.token);
			const closed = new Promise<CloseEvent>((resolve) => live.webSocket!.addEventListener("close", resolve));
			live.webSocket!.accept();
			expect((await closed).code).toBe(4005);
		}
		expect(elsewhere).toEqual([]);
		await cua.within((instance) => instance.store.setMeta(PROVIDER_KEY, choice(cua.owner)));
	});

	it("never uses a paired computer or a Sprite on record beside the choice, destroys neither, and the space's own config selects nothing", async () => {
		// The person's own space: the secret names a bridge for it, which chooses nothing, and its paired computer works as before.
		await runInDurableObject(env.Pim.getByName(OWNER), (instance: Pim) => {
			(instance as unknown as { env: Record<string, unknown> }).env.CUA_BRIDGES = bridges({ [OWNER]: bridgeOf(OWNER) });
		});
		const own = await fixtureFor(OWNER);
		expect((await api("/computer")).body).toMatchObject({ state: "none", startable: true });
		const ran: string[] = [];
		const { body } = await post<{ token: string }>("/computer");
		const paired = await connectTestComputer(body.token, `/tmp/cua-paired-${crypto.randomUUID()}`, async (args) => {
			ran.push(args.command);
			return ok(args.command);
		});
		const mine = await inside(OWNER, (await env.Auth.getByName(OWNER).createToken(OWNER, "cua-tests", Date.now())).token);
		expect(await mine.run("echo paired")).toContain("ran echo paired");
		expect(ran).toEqual(["echo paired"]);
		expect(own.calls).not.toHaveBeenCalled();

		// The operator chooses Cua for it, leaving the paired computer's token on record.
		await mine.within((instance) => {
			instance.store.setMeta(PROVIDER_KEY, choice(OWNER));
			instance.control.enable();
			instance.control.apply({ type: "resume", leaseId: "lease-own" });
		});
		expect((await api("/computer")).body).toMatchObject({ state: "offline", provider: "cua", computer: null, startable: false });
		expect(await mine.run("echo where")).toMatch(/still on record/);
		expect((await opens("/computer/connect", body.token)).status).toBe(409);
		expect((await api("/computer", { method: "DELETE" })).status).toBe(409);
		expect(await mine.within((instance) => instance.store.meta("computer_token"))).toEqual(expect.any(String));

		// Once the operator resolves it, the agent's next request goes to the bridge, and never to the paired computer, whose connection is still open.
		await mine.within((instance) => instance.store.deleteMeta("computer_token"));
		expect(paired.socket.readyState).toBe(WebSocket.OPEN);
		expect(await mine.run("echo bridge")).toContain("ran echo bridge");
		expect([ran, own.ran]).toEqual([["echo paired"], ["echo bridge"]]);
		// What the paired computer says isn't taken, and it is let go.
		const closed = new Promise<CloseEvent>((resolve) => paired.socket.addEventListener("close", resolve));
		paired.socket.send(JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/test", hostname: "impostor", platform: "linux", arch: "x64", user: "x", root: "/", browser: null }));
		expect((await closed).code).toBe(4409);
		expect((await api("/computer")).body).toMatchObject({ state: "online", provider: "cua", computer: { hostname: "cua-vm" } });

		// A Sprite on record is never used, nor removed through Pim's routes.
		await mine.within((instance) => {
			instance.store.setMeta("computer_machine", "pim-o-sprite-1");
			instance.computer.disconnect("restart");
		});
		expect(await mine.run("echo sprite")).toMatch(/still on record/);
		expect((await api("/computer", { method: "DELETE" })).status).toBe(409);
		expect((await post("/computer", { managed: true })).status).toBe(409);
		expect(await mine.within((instance) => instance.store.meta("computer_machine"))).toBe("pim-o-sprite-1");
		expect([own.ran, elsewhere]).toEqual([["echo bridge"], []]);
	});

	it("erases a space without touching its operator's computer, or any Sprite on record beside it", async () => {
		const gone = await space("cuagone", (instance, owner) => {
			instance.store.setMeta(PROVIDER_KEY, choice(owner));
			instance.store.setMeta("computer_machine", "pim-o-gone-1");
		});
		await fixtureFor(gone.owner);
		const warned: unknown[][] = [];
		vi.spyOn(console, "warn").mockImplementation((...args) => void warned.push(args));
		await gone.within((instance) => instance.deleteEverything()).catch(() => undefined);
		expect(warned).toContainEqual([JSON.stringify({ event: "cua.erased", owner: gone.owner, sprite: "pim-o-gone-1" })]);
		expect(fixtures.get(gone.owner)!.calls).not.toHaveBeenCalled();
		expect(elsewhere).toEqual([]);
	});
});
