import * as fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { MAX_CHUNK_BYTES, MAX_MESSAGE_CHARS, type OpenSession, type LogEntry, Lines, REPLACED, Relay, SPACE_HEADER, type Session, type SessionEvents, serveWithWebSocketPair } from "../computer/cua-bridge";
import { type ExecArgs, Link, type Machine } from "../computer/pim-computer";
import { Computer } from "../src/computer";
import { type DispatchTrace, dispatchTrace } from "../src/computer-control-runtime";
import { CONNECT_MS, Cua, type CuaBridge, MAX_MESSAGE_CHARS as PIM_MAX_MESSAGE_CHARS, SPACE_HEADER as PIM_SPACE_HEADER } from "../src/cua";

/**
 * The Cua bridge's relay (computer/cua-bridge.ts), against Pim's own
 * connector (`Cua.connect`). What is real here: the relay, its Workers
 * adapter and the `WebSocketPair` it answers with, Pim's `Cua` and
 * `Computer`, and pim-computer's `Link` over a test folder. What stands in:
 * the `fetch` Pim is given, which calls the adapter in this process; and
 * every session, which a test's `OpenSession` makes from a `Link` (whose
 * commands only record what they were asked) or from nothing at all. The
 * `hello` and replies a session sends are its fixture's, never the relay's.
 * Nothing here starts a process, a browser, or reaches the network.
 */

const SPACE = "o_0123456789abcdefghijklmnop";
const OTHER = "o_zyxwvutsrqponmlkjihgfedcba";
const TOKEN = "cua-bridge-relay-test-token-0123456789abcdef";
const ADDRESS = "https://bridge.cua.test/pim";
const BRIDGE: CuaBridge = { space: SPACE, url: ADDRESS, token: TOKEN };

/** A session as its fixture sees it: what it was handed, and how often it was closed. */
type Recorded = { events: SessionEvents; signal: AbortSignal; received: string[]; closes: number };

/** A folder for pim-computer's files, whose commands record what they were asked and run nothing. */
async function machine(): Promise<Machine & { ran: string[] }> {
	const root = `/tmp/cua-bridge-${crypto.randomUUID()}`;
	await fs.mkdir(root, { recursive: true });
	const ran: string[] = [];
	return {
		root: await fs.realpath(root),
		ran,
		exec: async (args: ExecArgs) => {
			ran.push(args.command);
			return { exitCode: 0, signal: null, stdout: `ran ${args.command}\n`, stderr: "", timedOut: false, truncated: false };
		},
	};
}

const hello = (root: string) => JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/test", hostname: "cua-vm", platform: "linux", arch: "x64", user: "desktop", root, browser: null });

/**
 * A relay whose sessions are pim-computer's `Link` on `computer`, answering
 * unless `answer` is false, each saying hello first as pim-computer does.
 * `fetch` is what Pim is given: it hands the request to the relay's Workers
 * adapter, and keeps each answer.
 */
async function bridge(options: { answer?: boolean; open?: OpenSession; maxOpeningChars?: number } = {}) {
	const computer = await machine();
	const sessions: Recorded[] = [];
	const logged: LogEntry[] = [];
	const open = vi.fn(
		options.open ??
			(async (events: SessionEvents, signal: AbortSignal): Promise<Session> => {
				const recorded: Recorded = { events, signal, received: [], closes: 0 };
				sessions.push(recorded);
				const link = new Link(computer, (message) => events.message(message));
				events.message(hello(computer.root));
				return {
					send(message) {
						recorded.received.push(message);
						if (options.answer !== false) link.receive(message);
					},
					close() {
						recorded.closes++;
						link.close();
					},
				};
			}),
	);
	const relay = new Relay({ space: SPACE, token: TOKEN, path: "/pim", open, log: (entry) => logged.push(entry), ...(options.maxOpeningChars ? { maxOpeningChars: options.maxOpeningChars } : {}) });
	const answers: Response[] = [];
	const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await serveWithWebSocketPair(relay, new Request(input, init));
		answers.push(response);
		return response;
	});
	return { relay, computer, sessions, logged, open, answers, fetch: fetcher as unknown as typeof fetch, fetches: fetcher };
}

/** A Computer that wakes through `cua`, as a space's does. */
function computerOn(cua: Cua) {
	const meta = new Map<string, string>();
	const computer: Computer = new Computer({
		meta: { meta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value), deleteMeta: (key) => meta.delete(key) },
		sockets: () => [],
		wake: () =>
			cua.connect(
				SPACE,
				(message) => computer.receive(message),
				() => computer.disconnected(),
			),
		inUse: () => false,
	});
	computer.started("cua-bridge-test", Date.now());
	return computer;
}

/** A request as Pim's `Cua.connect` makes it, with `changes` to it. */
function request(changes: { url?: string; method?: string; headers?: [string, string][]; signal?: AbortSignal } = {}) {
	const headers = new Headers(changes.headers ?? [
		["Authorization", `Bearer ${TOKEN}`],
		["Upgrade", "websocket"],
		[SPACE_HEADER, SPACE],
	]);
	return new Request(changes.url ?? ADDRESS, { method: changes.method ?? "GET", headers, redirect: "manual", ...(changes.signal ? { signal: changes.signal } : {}) });
}

/** Pim's end of a socket the relay answered `101` with, taken as a raw socket: what arrives, and how it closed. */
function pimEnd(response: Response) {
	const socket = response.webSocket!;
	const seen = { messages: [] as unknown[], closed: null as CloseEvent | null };
	socket.addEventListener("message", (event) => {
		seen.messages.push(event.data);
	});
	socket.addEventListener("close", (event) => {
		seen.closed = event;
	});
	socket.accept();
	return { socket, seen };
}

/** A promise and the means to settle it. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const trace = (): DispatchTrace => ({ sent: false, uncertain: false, awaiting: new Set(), settled: false });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a Cua bridge's relay", () => {
	it("carries pim-computer's protocol between Pim's connector and a session, and names the space back", async () => {
		// The relay and Pim agree on the header and the largest message.
		expect([SPACE_HEADER, MAX_MESSAGE_CHARS]).toEqual([PIM_SPACE_HEADER, PIM_MAX_MESSAGE_CHARS]);

		const test = await bridge();
		const computer = computerOn(new Cua(BRIDGE, test.fetch));

		await computer.fs.writeFile("/workspace/notes.md", "Through the relay");
		expect(await fs.readFile(`${test.computer.root}/notes.md`, "utf8")).toBe("Through the relay");
		expect(await new Response(await computer.fs.readFile("/workspace/notes.md")).text()).toBe("Through the relay");
		expect(await computer.exec("uname")).toMatchObject({ exitCode: 0, stdout: "ran uname\n" });
		expect(test.computer.ran).toEqual(["uname"]);
		// The hello Pim read is the session's own, sent through the relay.
		expect(computer.status()).toMatchObject({ state: "online", computer: { hostname: "cua-vm", user: "desktop" } });

		// One request, answered 101 naming exactly this space; one session, given nothing of the request.
		expect(test.answers.map((answer) => [answer.status, answer.headers.get(SPACE_HEADER)])).toEqual([[101, SPACE]]);
		expect(test.open).toHaveBeenCalledTimes(1);
		const [events, signal] = test.open.mock.calls[0]!;
		expect(Object.keys(events).sort()).toEqual(["closed", "message"]);
		expect(signal).toBeInstanceOf(AbortSignal);
		// Pim's calls reached the session unchanged, and nothing of the token did; nor did it reach the log.
		expect(test.sessions[0]!.received.map((message) => JSON.parse(message).op)).toEqual(expect.arrayContaining(["write", "read", "exec"]));
		expect(test.sessions[0]!.received.join("\n")).not.toContain(TOKEN);
		expect(test.logged).toEqual([{ event: "bridge.opened" }]);

		// Pim letting go closes the session, once.
		computer.letGoIfIdle(Date.now() + 10 * 60_000);
		await vi.waitFor(() => expect(test.sessions[0]!.closes).toBe(1));
		expect(test.logged.at(-1)).toEqual({ event: "bridge.ended", reason: "client-closed" });
	});

	it("refuses what isn't Pim's request for its space, at its address, before opening anything or saying anything of the token", async () => {
		const test = await bridge();
		const base: [string, string][] = [
			["Upgrade", "websocket"],
			[SPACE_HEADER, SPACE],
		];
		const cases: [string, Request, number][] = [
			["another path", request({ url: "https://bridge.cua.test/other" }), 404],
			["a trailing slash", request({ url: `${ADDRESS}/` }), 404],
			["another case", request({ url: "https://bridge.cua.test/PIM" }), 404],
			["the token in a query", request({ url: `${ADDRESS}?token=${TOKEN}` }), 404],
			["an empty query", request({ url: `${ADDRESS}?` }), 404],
			["POST", request({ method: "POST" }), 405],
			["no upgrade", request({ headers: [["Authorization", `Bearer ${TOKEN}`], [SPACE_HEADER, SPACE]] }), 426],
			["another upgrade", request({ headers: [["Authorization", `Bearer ${TOKEN}`], ["Upgrade", "h2c"], [SPACE_HEADER, SPACE]] }), 426],
			["no token", request({ headers: base }), 401],
			["the token only in a cookie", request({ headers: [...base, ["Cookie", `token=${TOKEN}`]] }), 401],
			["Basic", request({ headers: [...base, ["Authorization", `Basic ${btoa(`pim:${TOKEN}`)}`]] }), 401],
			["another scheme's case", request({ headers: [...base, ["Authorization", `bearer ${TOKEN}`]] }), 401],
			["a wrong token of the same length", request({ headers: [...base, ["Authorization", `Bearer ${TOKEN.slice(0, -1)}x`]] }), 401],
			["a prefix of the token", request({ headers: [...base, ["Authorization", `Bearer ${TOKEN.slice(0, -1)}`]] }), 401],
			["the token and more", request({ headers: [...base, ["Authorization", `Bearer ${TOKEN}x`]] }), 401],
			["the token and a space", request({ headers: [...base, ["Authorization", `Bearer ${TOKEN} x`]] }), 401],
			["the token twice", request({ headers: [...base, ["Authorization", `Bearer ${TOKEN}`], ["Authorization", `Bearer ${TOKEN}`]] }), 401],
			["an oversized header", request({ headers: [...base, ["Authorization", `Bearer ${"a".repeat(64 * 1024)}`]] }), 401],
			["a short token", request({ headers: [...base, ["Authorization", "Bearer short"]] }), 401],
			["no space", request({ headers: [["Authorization", `Bearer ${TOKEN}`], ["Upgrade", "websocket"]] }), 403],
			["another space", request({ headers: [["Authorization", `Bearer ${TOKEN}`], ["Upgrade", "websocket"], [SPACE_HEADER, OTHER]] }), 403],
			["the space in capitals", request({ headers: [["Authorization", `Bearer ${TOKEN}`], ["Upgrade", "websocket"], [SPACE_HEADER, SPACE.toUpperCase()]] }), 403],
			["the space twice", request({ headers: [["Authorization", `Bearer ${TOKEN}`], ["Upgrade", "websocket"], [SPACE_HEADER, SPACE], [SPACE_HEADER, SPACE]] }), 403],
		];
		for (const [name, refused, status] of cases) {
			const answer = await serveWithWebSocketPair(test.relay, refused);
			expect([name, answer.status], name).toEqual([name, status]);
			expect(answer.webSocket, name).toBeNull();
			expect(answer.headers.get("location"), name).toBeNull();
			expect(answer.headers.get(SPACE_HEADER), name).toBeNull();
			const text = `${await answer.text()} ${JSON.stringify([...answer.headers])}`;
			expect(text, name).not.toContain(TOKEN);
		}
		expect(test.open).not.toHaveBeenCalled();
		expect(test.logged.every((entry) => entry.event === "bridge.refused" && Object.keys(entry).sort().join() === "event,reason,status")).toBe(true);
		expect(JSON.stringify(test.logged)).not.toContain(TOKEN);

		// Through Pim's connector: a wrong token, or a bridge Pim was told is another space's, is refused, and nothing opens.
		const wrongToken = await new Cua({ ...BRIDGE, token: `${TOKEN.slice(0, -1)}x` }, test.fetch).connect(SPACE, () => undefined, () => undefined).catch((error: Error) => error);
		expect((wrongToken as Error).message).toMatch(/refused the connection \(401\)/);
		const other = await bridge();
		const wrongSpace = await new Cua({ ...BRIDGE, space: OTHER }, other.fetch).connect(OTHER, () => undefined, () => undefined).catch((error: Error) => error);
		expect((wrongSpace as Error).message).toMatch(/refused the connection \(403\)/);
		expect(test.open).not.toHaveBeenCalled();
		expect(other.open).not.toHaveBeenCalled();
	});

	it("is made for one space, a well-formed token and a canonical path, and says nothing of the token when it isn't", () => {
		const open: OpenSession = async () => ({ send() {}, close() {} });
		const bad = [
			{ space: "", token: TOKEN, path: "/pim" },
			{ space: SPACE.toUpperCase(), token: TOKEN, path: "/pim" },
			{ space: SPACE, token: "short", path: "/pim" },
			{ space: SPACE, token: `${TOKEN} x`, path: "/pim" },
			{ space: SPACE, token: TOKEN, path: "pim" },
			{ space: SPACE, token: TOKEN, path: "/pim?x" },
			{ space: SPACE, token: TOKEN, path: "/a/../pim" },
			{ space: SPACE, token: TOKEN, path: "/pim", maxOpeningChars: 0 },
		];
		for (const options of bad) {
			let error: unknown;
			try {
				new Relay({ ...options, open });
			} catch (caught) {
				error = caught;
			}
			expect(error, JSON.stringify({ ...options, token: options.token.length })).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain(TOKEN);
		}
		expect(new Relay({ space: SPACE, token: TOKEN, path: "/pim", open }).space).toBe(SPACE);
	});

	it("replaces the connection before, ending it and its session before the next session opens, and carries nothing across", async () => {
		const test = await bridge();
		const order: string[] = [];
		const first = await serveWithWebSocketPair(test.relay, request());
		expect(first.status).toBe(101);
		const a = pimEnd(first);
		await vi.waitFor(() => expect(a.seen.messages).toHaveLength(1));
		const sessionA = test.sessions[0]!;
		const eventsA = sessionA.events;
		test.open.mockImplementationOnce(async () => {
			order.push(`open with first closed ${sessionA.closes}`);
			return { send: (message) => void order.push(`second got ${message}`), close: () => void order.push("second closed") };
		});

		const second = await serveWithWebSocketPair(test.relay, request());
		expect(second.status).toBe(101);
		expect(order).toEqual(["open with first closed 1"]);
		await vi.waitFor(() => expect(a.seen.closed?.code).toBe(REPLACED));

		// What the first session says after, and what Pim sends on the first socket, go nowhere.
		const b = pimEnd(second);
		eventsA.message(JSON.stringify({ type: "reply", id: "late", result: {} }));
		eventsA.closed();
		try {
			a.socket.send('{"type":"call","id":"1","op":"stat","args":{"path":"/workspace"}}');
		} catch {
			// Already closed, as it should be.
		}
		b.socket.send('{"type":"call","id":"2","op":"stat","args":{"path":"/workspace"}}');
		await vi.waitFor(() => expect(order).toContain('second got {"type":"call","id":"2","op":"stat","args":{"path":"/workspace"}}'));
		await tick();
		expect(b.seen.messages).toEqual([]);
		expect(sessionA.received).toEqual([]);
		expect(sessionA.closes).toBe(1);
		expect(order).toEqual(["open with first closed 1", 'second got {"type":"call","id":"2","op":"stat","args":{"path":"/workspace"}}']);
		b.socket.close(1000);
		await vi.waitFor(() => expect(order.at(-1)).toBe("second closed"));
	});

	it("answers a connection replaced or given up while its session opens at once, and closes that session once, unused, if it ever comes", async () => {
		const pending: { opened: ReturnType<typeof deferred<Session>>; signal: AbortSignal }[] = [];
		const test = await bridge({
			open: (_events, signal) => {
				const opened = deferred<Session>();
				pending.push({ opened, signal });
				return opened.promise;
			},
		});
		const session = () => {
			const made = { sent: [] as string[], closes: 0 };
			return { made, session: { send: (message: string) => void made.sent.push(message), close: () => void made.closes++ } };
		};

		// Replaced while opening: the first is answered 502 with its session still opening, and its signal aborts.
		const first = serveWithWebSocketPair(test.relay, request());
		await vi.waitFor(() => expect(pending).toHaveLength(1));
		const second = serveWithWebSocketPair(test.relay, request());
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		expect(pending[0]!.signal.aborted).toBe(true);
		const firstAnswer = await first;
		expect([firstAnswer.status, firstAnswer.webSocket]).toEqual([502, null]);
		// The first's session comes later: it is closed once, and sent nothing.
		const late = session();
		pending[0]!.opened.resolve(late.session);
		await vi.waitFor(() => expect(late.made.closes).toBe(1));
		const current = session();
		pending[1]!.opened.resolve(current.session);
		expect((await second).status).toBe(101);
		await tick();
		expect(late.made).toEqual({ sent: [], closes: 1 });
		expect(current.made.closes).toBe(0);

		// Given up by Pim while opening (its request's signal aborts): answered at once, and its session, when it comes, closed once.
		const giveUp = new AbortController();
		const third = serveWithWebSocketPair(test.relay, request({ signal: giveUp.signal }));
		await vi.waitFor(() => expect(pending).toHaveLength(3));
		giveUp.abort();
		expect(pending[2]!.signal.aborted).toBe(true);
		expect((await third).status).toBe(502);
		const abandoned = session();
		pending[2]!.opened.resolve(abandoned.session);
		await vi.waitFor(() => expect(abandoned.made.closes).toBe(1));
		expect(test.logged.filter((entry) => entry.event === "bridge.ended").map((entry) => entry.reason)).toEqual(["replaced", "replaced", "abandoned"]);

		// With no runtime between (a synthetic client socket): what Pim sends before the session is open isn't kept for it, and ends the connection; ready settles before the session comes.
		const client = { sent: [] as string[], closed: [] as number[] };
		const early = test.relay.open({ send: (message) => void client.sent.push(message), close: (code) => void client.closed.push(code) });
		await vi.waitFor(() => expect(pending).toHaveLength(4));
		early.receive('{"type":"call","id":"1","op":"stat","args":{}}');
		expect([early.ended, client.closed]).toEqual([true, [1008]]);
		expect(await early.ready).toBe(false);
		const unused = session();
		pending[3]!.opened.resolve(unused.session);
		await vi.waitFor(() => expect(unused.made.closes).toBe(1));
		await tick();
		expect(unused.made).toEqual({ sent: [], closes: 1 });

		// A session that never comes leaves nothing waiting: its connection is answered when replaced.
		const never = serveWithWebSocketPair(test.relay, request());
		await vi.waitFor(() => expect(pending).toHaveLength(5));
		const after = serveWithWebSocketPair(test.relay, request());
		expect((await never).status).toBe(502);
		await vi.waitFor(() => expect(pending).toHaveLength(6));
		pending[5]!.opened.resolve(session().session);
		expect((await after).status).toBe(101);

		// A request already given up opens nothing.
		const before = pending.length;
		const gone = new AbortController();
		gone.abort();
		expect((await serveWithWebSocketPair(test.relay, request({ signal: gone.signal }))).status).toBe(502);
		expect(pending).toHaveLength(before);
	});

	it("passes Pim's own timeout on to a session still opening, through the request's signal, and answers then", async () => {
		vi.useFakeTimers();
		try {
			const opened = deferred<Session>();
			let given: AbortSignal | undefined;
			const test = await bridge({
				open: (_events, signal) => {
					given = signal;
					return opened.promise;
				},
			});
			const connecting = new Cua(BRIDGE, test.fetch).connect(SPACE, () => undefined, () => undefined).catch((error: Error) => error);
			await vi.advanceTimersByTimeAsync(CONNECT_MS);
			expect(given?.aborted).toBe(true);
			// The relay has answered with the session still opening; Pim had given up on it.
			expect(((await connecting) as Error).message).toMatch(/didn't answer within 30 seconds/);
			expect(test.answers.map((answer) => answer.status)).toEqual([502]);
			let closes = 0;
			opened.resolve({ send() {}, close: () => void closes++ });
			await vi.advanceTimersByTimeAsync(1);
			expect(closes).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("holds what pim-computer says while its session opens, in order and bounded, and drops it when the session doesn't open", async () => {
		const opening = async (limit: number) => {
			let events!: SessionEvents;
			let signal!: AbortSignal;
			const opened = deferred<Session>();
			const test = await bridge({
				maxOpeningChars: limit,
				open: (given, aborted) => {
					events = given;
					signal = aborted;
					return opened.promise;
				},
			});
			const answer = serveWithWebSocketPair(test.relay, request());
			await vi.waitFor(() => expect(events).toBeDefined());
			return { test, events, signal: () => signal, opened, answer };
		};
		const helloMessage = '{"type":"hello","version":1}';

		// Within the limit (29 + 8 + 8 of 100): all of it reaches Pim once the session is open, the hello first.
		const within = await opening(100);
		within.events.message(helloMessage);
		within.events.message('{"n":1}');
		within.events.message('{"n":2}');
		within.opened.resolve({ send() {}, close() {} });
		const open = await within.answer;
		expect(open.status).toBe(101);
		const pim = pimEnd(open);
		await vi.waitFor(() => expect(pim.seen.messages).toEqual([helloMessage, '{"n":1}', '{"n":2}']));
		pim.socket.close(1000);

		// Past it, with every message valid on its own and the session still opening: answered 502 at once, and what was held is dropped.
		const past = await opening(100);
		past.events.message(helloMessage);
		for (let index = 0; index < 3; index++) past.events.message(JSON.stringify({ n: "x".repeat(20) }));
		const refused = await past.answer;
		expect([refused.status, refused.webSocket]).toEqual([502, null]);
		expect(past.signal().aborted).toBe(true);
		expect(past.test.logged.at(-1)).toEqual({ event: "bridge.ended", reason: "opening-overflow" });
		past.events.message('{"n":"after"}');
		let closes = 0;
		past.opened.resolve({ send() {}, close: () => void closes++ });
		await vi.waitFor(() => expect(closes).toBe(1));
	});

	it("ends the connection, and its session once, on a binary, oversized or line-broken message either way", async () => {
		for (const [bad, code] of [
			[new Uint8Array([1, 2, 3]), 1003],
			["x".repeat(MAX_MESSAGE_CHARS + 1), 1009],
			['{"type":"call",\n"id":"1"}', 1007],
			['{"type":"call",\r"id":"1"}', 1007],
		] as const) {
			const test = await bridge({ answer: false });
			const pim = pimEnd(await serveWithWebSocketPair(test.relay, request()));
			// Text that isn't JSON is the session's to ignore, and is passed on unchanged.
			pim.socket.send("not json");
			await vi.waitFor(() => expect(test.sessions[0]!.received).toEqual(["not json"]));
			pim.socket.send(bad);
			pim.socket.send('{"type":"call","id":"after","op":"stat","args":{}}');
			await vi.waitFor(() => expect(pim.seen.closed?.code).toBe(code));
			await tick();
			expect(test.sessions[0]!.received).toEqual(["not json"]);
			expect(test.sessions[0]!.closes).toBe(1);
		}

		// From the session: anything but a message of text, short enough and on one line, ends it, and nothing after reaches Pim.
		for (const bad of [new Uint8Array([1]) as unknown as string, "y".repeat(MAX_MESSAGE_CHARS + 1), '{"type":"reply",\n"id":"1"}']) {
			const test = await bridge({ answer: false });
			const pim = pimEnd(await serveWithWebSocketPair(test.relay, request()));
			const { events } = test.sessions[0]!;
			events.message(bad);
			events.message('{"type":"reply","id":"after","result":null}');
			await vi.waitFor(() => expect(pim.seen.closed?.code).toBe(1011));
			expect(pim.seen.messages).toHaveLength(1);
			expect(JSON.parse(pim.seen.messages[0] as string)).toMatchObject({ type: "hello" });
			expect(test.sessions[0]!.closes).toBe(1);
			expect(test.logged.at(-1)).toEqual({ event: "bridge.ended", reason: "session-protocol" });
		}
	});

	it("ends everything once however many ends race, and tries nothing again when a session can't take a message", async () => {
		const test = await bridge({ answer: false });
		const pim = pimEnd(await serveWithWebSocketPair(test.relay, request()));
		const recorded = test.sessions[0]!;
		// The session's end, Pim's close and a replacement, together.
		recorded.events.closed();
		pim.socket.close(1000);
		recorded.events.closed();
		const next = await serveWithWebSocketPair(test.relay, request());
		await tick();
		expect(recorded.closes).toBe(1);
		expect(test.logged.filter((entry) => entry.event === "bridge.ended")).toEqual([{ event: "bridge.ended", reason: "session-closed" }]);
		expect(pim.seen.closed?.code).toBe(1000);
		pimEnd(next).socket.close(1000);

		// A session whose send throws: the message may or may not have arrived, so it isn't sent again, and the connection ends.
		let sends = 0;
		let closes = 0;
		const failing = await bridge({
			open: async () => ({
				send() {
					sends++;
					throw new Error(`write failed ${TOKEN}`);
				},
				close: () => void closes++,
			}),
		});
		const throwing = pimEnd(await serveWithWebSocketPair(failing.relay, request()));
		throwing.socket.send('{"type":"call","id":"1","op":"exec","args":{"command":"make deploy"}}');
		throwing.socket.send('{"type":"call","id":"2","op":"stat","args":{}}');
		await vi.waitFor(() => expect(throwing.seen.closed?.code).toBe(1011));
		await tick();
		expect([sends, closes]).toEqual([1, 1]);
		expect(JSON.stringify(failing.logged)).not.toContain(TOKEN);
	});

	it("answers no 101 when the session can't open, and logs nothing of what failed", async () => {
		for (const open of [
			async (): Promise<Session> => {
				throw new Error(`spawn failed with ${TOKEN}`);
			},
			(): Promise<Session> => {
				throw new Error(`thrown at once with ${TOKEN}`);
			},
		]) {
			const test = await bridge({ open });
			const closed = vi.fn();
			const error = await new Cua(BRIDGE, test.fetch).connect(SPACE, () => undefined, closed).catch((caught: Error) => caught);
			expect((error as Error).message).toMatch(/refused the connection \(502\)/);
			expect(closed).not.toHaveBeenCalled();
			expect(test.answers.map((answer) => answer.status)).toEqual([502]);
			expect(test.logged).toEqual([{ event: "bridge.ended", reason: "session-failed" }]);
		}

		// A session that ends while it opens isn't ready, says nothing to Pim, and is closed once when it comes.
		let closes = 0;
		const test = await bridge({
			open: async (events) => {
				events.message('{"type":"hello","version":1}');
				events.closed();
				return { send() {}, close: () => void closes++ };
			},
		});
		const answer = await serveWithWebSocketPair(test.relay, request());
		expect(answer.status).toBe(502);
		expect(answer.webSocket).toBeNull();
		expect(closes).toBe(1);
		expect(test.logged).toEqual([{ event: "bridge.ended", reason: "session-closed" }]);
	});

	it("leaves a call a session took and ended without answering unknown, and sends it on no later connection", async () => {
		const test = await bridge({ answer: false });
		const computer = computerOn(new Cua(BRIDGE, test.fetch));
		const first = trace();
		const answer = dispatchTrace.run(first, () => computer.exec("make deploy")).catch((error: Error) => error);
		await vi.waitFor(() => expect(test.sessions[0]?.received).toHaveLength(1));
		const call = JSON.parse(test.sessions[0]!.received[0]!) as { id: string; op: string };
		expect(call.op).toBe("exec");

		// The session's transport ends: the call may or may not have run.
		test.sessions[0]!.events.closed();
		expect(((await answer) as Error).message).toMatch(/disconnected before it answered/);
		expect(first).toMatchObject({ sent: true, uncertain: true });

		// The next call opens a new session, which gets only that call; the old session's late reply reaches nobody.
		const next = computer.exec("date").catch((error: Error) => error);
		await vi.waitFor(() => expect(test.sessions[1]?.received).toHaveLength(1));
		test.sessions[0]!.events.message(JSON.stringify({ type: "reply", id: call.id, result: { exitCode: 0, stdout: "deployed" } }));
		expect(JSON.parse(test.sessions[1]!.received[0]!)).toMatchObject({ op: "exec", args: { command: "date" } });
		expect(test.sessions.map((session) => session.received.join("\n").includes("make deploy"))).toEqual([true, false]);
		test.sessions[1]!.events.message(JSON.stringify({ type: "reply", id: JSON.parse(test.sessions[1]!.received[0]!).id, result: { exitCode: 0, signal: null, stdout: "today\n", stderr: "", timedOut: false, truncated: false } }));
		expect(await next).toMatchObject({ stdout: "today\n" });
		expect(test.open).toHaveBeenCalledTimes(2);
		expect(test.sessions[0]!.received).toHaveLength(1);
	});

	it("frames a byte stream as lines, a message each, bounded and strictly UTF-8", async () => {
		// pim-computer's `--stdio` framing, end to end: each message a line of bytes, cut into chunks that split characters.
		const computer = await machine();
		const chunked = (bytes: Uint8Array) => Array.from({ length: Math.ceil(bytes.length / 3) }, (_, index) => bytes.subarray(index * 3, index * 3 + 3));
		const encoder = new TextEncoder();
		const test = await bridge({
			open: async (events) => {
				const fromComputer = new Lines();
				const toComputer = new Lines();
				const write = (message: string) => {
					for (const chunk of chunked(encoder.encode(`${message}\n`))) for (const line of fromComputer.push(chunk)) events.message(line);
				};
				const link = new Link(computer, write);
				write(hello(computer.root));
				return {
					send(message) {
						for (const chunk of chunked(encoder.encode(`${message}\n`))) for (const line of toComputer.push(chunk)) link.receive(line);
					},
					close: () => link.close(),
				};
			},
		});
		const pim = computerOn(new Cua(BRIDGE, test.fetch));
		await pim.fs.writeFile("/workspace/naïve ✓ 𝄞.md", "Ünïcode ✓ 𝄞");
		expect(await fs.readFile(`${computer.root}/naïve ✓ 𝄞.md`, "utf8")).toBe("Ünïcode ✓ 𝄞");
		expect(await new Response(await pim.fs.readFile("/workspace/naïve ✓ 𝄞.md")).text()).toBe("Ünïcode ✓ 𝄞");

		// Each push takes at most a chunk's worth, refused whole before it is decoded, with a fixed error: a giant unended line, or many short ones.
		const giant = new Lines(MAX_MESSAGE_CHARS, 1024);
		expect(() => giant.push(new Uint8Array(1025).fill(0x61))).toThrow("pim-computer's output was handed over in a part larger than a line reader takes.");
		// After any error, the reader stays broken, and the embedder ends the session.
		expect(() => giant.push(encoder.encode("{}\n"))).toThrow(RangeError);
		expect(() => new Lines(MAX_MESSAGE_CHARS, 1024).push(encoder.encode("{}\n".repeat(400)))).toThrow(RangeError);
		expect(new Lines(MAX_MESSAGE_CHARS, 1024).push(encoder.encode("{}\n".repeat(341)))).toHaveLength(341);
		expect(() => new Lines().push(new Uint8Array(MAX_CHUNK_BYTES + 1))).toThrow(RangeError);

		// A line past the limit throws, whether it ends or not; so do bytes that aren't UTF-8; an unended line is no message.
		const lines = new Lines(8);
		expect(lines.push(encoder.encode("12345678\n1234"))).toEqual(["12345678"]);
		expect(() => lines.push(encoder.encode("56789"))).toThrow("pim-computer wrote a line longer than a message may be.");
		expect(() => lines.push(encoder.encode("\n"))).toThrow(RangeError);
		expect(() => new Lines(8).push(encoder.encode("123456789\n"))).toThrow(RangeError);
		expect(() => new Lines().push(new Uint8Array([0x7b, 0xff, 0x0a]))).toThrow("pim-computer wrote bytes that aren't UTF-8.");
		const split = new Lines();
		expect(split.push(new Uint8Array([0xe2, 0x9c]))).toEqual([]);
		expect(split.push(new Uint8Array([0x93, 0x0a, 0x7b]))).toEqual(["✓"]);

		// A long line arrives in many full chunks, and comes out whole.
		const long = new Lines();
		const chunk = new Uint8Array(MAX_CHUNK_BYTES).fill(0x61);
		for (let index = 0; index < 64; index++) expect(long.push(chunk)).toEqual([]);
		const [whole] = long.push(encoder.encode("\n"));
		expect(whole).toHaveLength(64 * MAX_CHUNK_BYTES);
	});
});
