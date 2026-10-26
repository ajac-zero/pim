import * as fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { type ExecArgs, Link, type Machine } from "../computer/pim-computer";
import { Computer, IDLE_MS } from "../src/computer";
import { type DispatchTrace, dispatchTrace } from "../src/computer-control-runtime";
import { CONNECT_MS, Cua, type CuaBridge, MAX_MESSAGE_CHARS, SPACE_HEADER } from "../src/cua";

/**
 * The Cua bridge's link, which nothing in Pim uses yet (src/cua.ts). These
 * tests give it their own `fetch`: what answers is a bridge in this process,
 * a WebSocketPair with pim-computer's real `Link` over a test folder behind
 * it. Nothing here reaches the network.
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
async function bridge(options: { relay?: boolean } = {}) {
	const root = `/tmp/cua-${crypto.randomUUID()}`;
	await fs.mkdir(root, { recursive: true });
	const machine: Machine = {
		root: await fs.realpath(root),
		exec: async (args: ExecArgs) => ({ exitCode: 0, signal: null, stdout: `ran ${args.command}\n`, stderr: "", timedOut: false, truncated: false }),
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
		server.send(JSON.stringify({ type: "hello", version: 1, agent: "pim-computer/test", hostname: "cua-vm", platform: "linux", arch: "x64", user: "desktop", root: machine.root, browser: null }));
		return new Response(null, { status: 101, webSocket: client, headers: { [SPACE_HEADER]: SPACE } });
	});
	return { root: machine.root, seen, connections, fetch: fetcher as unknown as typeof fetch, calls: fetcher };
}

/** A Computer as a space makes one, for a computer Pim started, which wakes through `cua`. */
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
