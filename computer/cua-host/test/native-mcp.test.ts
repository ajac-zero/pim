/**
 * The native-app MCP client (../native-mcp.ts) against a stand-in for
 * spacesd's `/mcp`, written here from its source at the pinned commit
 * (`http/mcp.rs` and cua-driver-core's dispatch): bearer auth, minted
 * `Mcp-Session-Id`s, `X-Cua-Agent-Session` as the driver session, `202` for
 * notifications, and `tools/list` and `tools/call` answers. It is a `fetch`
 * in this process that records every request and every tool call it
 * "executes". It shows what the client sends and makes of answers; it proves
 * nothing about the real binary. No server, socket, desktop or app is involved.
 *
 *   node --test test/native-mcp.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	agentSessionOf,
	canonical,
	createNativeDispatcher,
	createNativeMcp,
	DEFAULT_LIMITS,
	dispatchEffect,
	LIMIT_RANGES,
	MAX_RUNS,
	type Fetch,
	type NativeCall,
	NativeMcpSetupError,
	type NativeMcpLimits,
	type NativeOutcome,
	TOOLS,
	type TrustedRun,
} from "../native-mcp.ts";
import { AGENT_SESSION, CUA_COMMIT, UPSTREAM_TOOLS, UPSTREAM_TOOLS_SHA256 } from "../native-mcp-upstream.ts";
import { BRIDGE_MESSAGE_CHARS, isBase64, NATIVE_ARGUMENTS_CHARS, NATIVE_TOOLS, NATIVE_WIRE_LIMITS, readNativeOutcome, readNativeRequest } from "../../native-outcome.ts";
import { MAX_MESSAGE_CHARS } from "../../cua-bridge.ts";

const ORIGIN = "http://127.0.0.1:3211";
const TOKEN = "spacesd-root-token-of-the-stand-in-0123456789";
const OWNER = "space-ada";
const RUN: TrustedRun = { owner: OWNER, agentId: "agent-1", runId: "run-1" };
const LEAK = "upstream-internal-detail /home/desktop/.cua/secret";

// ---------------------------------------------------------------- the stand-in

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown; redirect: string | undefined };
type Executed = { name: string; arguments: Record<string, unknown>; driverSession: string; mcpSession: string };
/** How the stand-in answers one `tools/call` it executed: a JSON-RPC result, or a `Response` of the test's own. */
type Behaviour = (call: Executed, id: unknown, session: string, signal: AbortSignal) => Promise<Response | object> | Response | object;

const json = (value: unknown, session?: string, init: { status?: number; type?: string } = {}) =>
	new Response(JSON.stringify(value), {
		status: init.status ?? 200,
		headers: { "content-type": init.type ?? "application/json", ...(session ? { "mcp-session-id": session } : {}) },
	});

/** Each curated tool as `tools/list` advertises it: the pinned properties with descriptions, the ones the client leaves out, and the typed `target`. */
function advertisedTools(change?: (tools: Record<string, unknown>[]) => void): Record<string, unknown>[] {
	const tools = Object.entries(UPSTREAM_TOOLS).map(([name, pinned]) => {
		const properties: Record<string, unknown> = { session: { type: "string", description: "…" } };
		for (const [property, shape] of Object.entries(pinned.properties)) properties[property] = { ...shape, description: `${property} …` };
		if (name !== "list_apps" && name !== "list_windows" && name !== "bring_to_front") {
			properties.scope = { type: "string", enum: ["window", "desktop"], default: "window" };
			properties.target = { type: "object" };
		}
		return { name, description: "…", inputSchema: { type: "object", required: [...pinned.required], properties, additionalProperties: false } };
	});
	for (const name of ["launch_app", "kill_app", "set_config", "run_steps", "page", "browser_navigate", "start_recording", "end_session"]) {
		tools.push({ name, description: "…", inputSchema: { type: "object", required: [], properties: {}, additionalProperties: false } });
	}
	change?.(tools);
	return tools;
}

class StandIn {
	readonly sent: Sent[] = [];
	readonly executed: Executed[] = [];
	#minted = 0;
	behaviour: Behaviour = () => ({ content: [{ type: "text", text: "done" }] });
	initialize: (session: string) => Response = (session) =>
		json({ jsonrpc: "2.0", id: this.lastId, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: "0.38.0" }, instructions: "…" } }, session);
	tools: () => Record<string, unknown>[] = () => advertisedTools();
	lastId: unknown = null;

	readonly fetch: Fetch = async (url, init) => {
		const headers = Object.fromEntries(new Headers(init.headers).entries());
		const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
		this.sent.push({ url, method: init.method ?? "GET", headers, body, redirect: init.redirect });
		if (url !== `${ORIGIN}/mcp`) return new Response("not found", { status: 404 });
		if (headers.authorization !== `Bearer ${TOKEN}`) return new Response("missing or invalid bearer token", { status: 401 });
		if (init.method !== "POST") return new Response(null, { status: 405 });
		const session = headers["mcp-session-id"] || `mcp-${String(++this.#minted).padStart(16, "x")}`;
		const agent = headers["x-cua-agent-session"]?.trim() ?? "";
		const driverSession = AGENT_SESSION.test(agent) ? `agent-${agent}` : session;
		const request = body as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
		if (Array.isArray(request)) throw new Error("the client never sends a batch");
		if (request.id === undefined) return new Response(null, { status: 202 });
		this.lastId = request.id;
		switch (request.method) {
			case "initialize":
				return this.initialize(session);
			case "tools/list":
				return json({ jsonrpc: "2.0", id: request.id, result: { tools: this.tools(), schema_version: "1" } }, session);
			case "tools/call": {
				const call = { name: request.params?.name ?? "", arguments: { ...request.params?.arguments }, driverSession, mcpSession: session };
				this.executed.push(call);
				const answered = await this.behaviour(call, request.id, session, init.signal as AbortSignal);
				return answered instanceof Response ? answered : json({ jsonrpc: "2.0", id: request.id, result: answered }, session);
			}
			default:
				return json({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } }, session);
		}
	};

	calls(): Sent[] {
		return this.sent.filter((sent) => (sent.body as { method?: string })?.method === "tools/call");
	}
}

function client(standIn: StandIn, limits: Partial<NativeMcpLimits> = {}) {
	return createNativeMcp({ origin: ORIGIN, token: TOKEN, owner: OWNER, fetch: standIn.fetch, limits: { callMs: 1_000, ...limits } });
}

const call = (overrides: Partial<NativeCall> = {}): NativeCall => ({ ...RUN, callId: `call-${Math.random()}`, tool: "list_apps", arguments: {}, ...overrides });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** `outcome` as the space reads it from pim-computer's reply: the same, or null. */
const overTheWire = (outcome: NativeOutcome) => readNativeOutcome(JSON.parse(JSON.stringify(outcome)));

/** A PNG or JPEG of `width` × `height`, as far as its header goes, which is all the client reads. */
function png(width: number, height: number): string {
	const bytes = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "latin1");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes.toString("base64");
}
function jpeg(width: number, height: number): string {
	const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
	const sof0 = [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00];
	return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]).toString("base64");
}

// ---------------------------------------------------------------- the pins

describe("pins", () => {
	it("pins the upstream schemas by hash, and every curated field tightens its upstream field", () => {
		assert.equal(CUA_COMMIT, "fca21937bc4e1420a23d544d11dbdf987f0266e6");
		assert.equal(createHash("sha256").update(canonical(UPSTREAM_TOOLS)).digest("hex"), UPSTREAM_TOOLS_SHA256);
		assert.deepEqual(Object.keys(TOOLS).sort(), Object.keys(UPSTREAM_TOOLS).sort());
		for (const [name, tool] of Object.entries(TOOLS)) {
			const upstream = UPSTREAM_TOOLS[name];
			assert.ok(upstream, name);
			for (const required of upstream.required) assert.ok(tool.required.includes(required), `${name} requires ${required}`);
			assert.deepEqual(Object.keys(tool.properties).sort(), Object.keys(upstream.properties).sort(), name);
			for (const [property, field] of Object.entries(tool.properties)) {
				const pinned = upstream.properties[property] as { type: string; enum?: string[]; minimum?: number; maximum?: number; minItems?: number; pattern?: string };
				assert.equal(field.type, pinned.type, `${name}.${property}`);
				if (field.type === "integer" || field.type === "number") {
					assert.ok(field.minimum >= (pinned.minimum ?? Number.NEGATIVE_INFINITY) && field.maximum <= (pinned.maximum ?? Number.POSITIVE_INFINITY), `${name}.${property}`);
				}
				if (field.type === "string" && pinned.enum) assert.ok(field.enum?.every((value) => pinned.enum?.includes(value)), `${name}.${property}`);
				if (field.type === "string" && pinned.pattern) assert.ok(field.pattern, `${name}.${property} keeps a pattern`);
				if (field.type === "array") assert.ok(field.minItems >= (pinned.minItems ?? 0), `${name}.${property}`);
			}
		}
	});

	it("refuses origins and tokens the operator can't have meant", () => {
		for (const origin of ["http://10.0.0.5:3211", "http://127.0.0.1:3211/mcp", "https://u:p@spacesd.test", "http://127.0.0.1:3211?x=1", "ftp://127.0.0.1", "not a url"]) {
			assert.throws(() => createNativeMcp({ origin, token: TOKEN, owner: OWNER, fetch: new StandIn().fetch }), origin);
		}
		assert.throws(() => createNativeMcp({ origin: ORIGIN, token: "a b", owner: OWNER, fetch: new StandIn().fetch }));
		assert.doesNotThrow(() => createNativeMcp({ origin: "https://spacesd.test:8443", token: TOKEN, owner: OWNER, fetch: new StandIn().fetch }));
	});

	it("refuses limits that would switch a bound off, or aren't limits", () => {
		const make = (limits: unknown) => () => createNativeMcp({ origin: ORIGIN, token: TOKEN, owner: OWNER, fetch: new StandIn().fetch, limits: limits as Partial<NativeMcpLimits> });
		for (const [key, [low, high]] of Object.entries(LIMIT_RANGES)) {
			for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, low - 1, high + 1, low + 0.5, undefined, null, String(high), 10n]) {
				assert.throws(make({ [key]: value }), Error, `${key}: ${String(value)}`);
			}
			assert.doesNotThrow(make({ [key]: key === "maxOutputBytes" ? high : low === 0 ? 0 : high }), key);
		}
		assert.throws(make({ maxFoo: 1 }));
		assert.throws(make(5));
		assert.throws(make({ maxContentItems: 1024, maxOutputBytes: 1024 }), /maxOutputBytes/);
		assert.doesNotThrow(make({}));
	});
});

// ---------------------------------------------------------------- setup and identity

describe("setting a run up", () => {
	it("initializes its own session, with the token only to the origin, and calls nothing", async () => {
		const standIn = new StandIn();
		const run = await client(standIn).openRun(RUN);
		assert.deepEqual(
			standIn.sent.map((sent) => (sent.body as { method: string }).method),
			["initialize", "notifications/initialized", "tools/list"],
		);
		assert.equal(standIn.executed.length, 0);
		assert.equal(run.agentSession, agentSessionOf(RUN));
		assert.ok(AGENT_SESSION.test(run.agentSession) && run.agentSession.length <= 64);
		for (const sent of standIn.sent) {
			assert.equal(sent.url, `${ORIGIN}/mcp`);
			assert.equal(sent.method, "POST");
			assert.equal(sent.redirect, "manual");
			assert.equal(sent.headers.authorization, `Bearer ${TOKEN}`);
			assert.equal(sent.headers["x-cua-agent-session"], run.agentSession);
		}
		const [initialize, notified, listed] = standIn.sent;
		assert.equal(initialize?.headers["mcp-session-id"], undefined);
		assert.deepEqual((initialize?.body as { params: unknown }).params, { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pim-cua-host", version: "0.1.0" } });
		assert.equal(notified?.headers["mcp-session-id"], "mcp-xxxxxxxxxxxxxxx1");
		assert.equal(listed?.headers["mcp-session-id"], "mcp-xxxxxxxxxxxxxxx1");

		await run.invoke(call());
		const [sent] = standIn.calls();
		assert.equal(sent?.headers["mcp-session-id"], "mcp-xxxxxxxxxxxxxxx1");
		assert.equal(standIn.executed[0]?.driverSession, `agent-${run.agentSession}`);
	});

	it("gives each owner, agent and run its own stable driver session", () => {
		const runs: TrustedRun[] = [
			RUN,
			{ ...RUN, owner: "space-bob" },
			{ ...RUN, agentId: "agent-2" },
			{ ...RUN, runId: "run-2" },
			{ owner: "a", agentId: "bc", runId: "d" },
			{ owner: "ab", agentId: "c", runId: "d" },
		];
		const sessions = runs.map(agentSessionOf);
		assert.equal(new Set(sessions).size, runs.length);
		assert.equal(agentSessionOf({ ...RUN }), sessions[0]);
		for (const session of sessions) assert.ok(AGENT_SESSION.test(session));
	});

	it("refuses another owner, an unusable identity and a run opened before, sending nothing for them", async () => {
		const standIn = new StandIn();
		const mcp = client(standIn);
		await mcp.openRun(RUN);
		const before = standIn.sent.length;
		for (const run of [{ ...RUN, owner: "space-bob" }, { ...RUN, runId: "" }, { ...RUN, agentId: "a b" }, { ...RUN, runId: "x".repeat(257) }, RUN]) {
			await assert.rejects(mcp.openRun(run), NativeMcpSetupError);
		}
		assert.equal(standIn.sent.length, before);
	});

	it("lets a run whose setup failed, which called nothing, be set up again, and stops setting up when aborted", async () => {
		const standIn = new StandIn();
		standIn.tools = () => advertisedTools((tools) => tools.splice(0, 1));
		const mcp = client(standIn);
		await assert.rejects(mcp.openRun(RUN), NativeMcpSetupError);
		standIn.tools = () => advertisedTools();
		assert.equal((await mcp.openRun(RUN)).state, "ready");

		const aborting = new StandIn();
		const controller = new AbortController();
		const initialize = aborting.initialize;
		aborting.initialize = (session) => {
			controller.abort();
			return initialize(session);
		};
		await assert.rejects(client(aborting).openRun(RUN, controller.signal), NativeMcpSetupError);
		assert.deepEqual(
			aborting.sent.map((sent) => (sent.body as { method: string }).method),
			["initialize"],
		);
		assert.equal(standIn.calls().length + aborting.calls().length, 0);
	});

	it("turns any setup failure, malformed schemas and unreadable callers included, into a plain NativeMcpSetupError", async () => {
		const retyped = (change: (schema: Record<string, unknown>) => void) => (s: StandIn) =>
			(s.tools = () =>
				advertisedTools((tools) => {
					change((tools.find((tool) => tool.name === "click") as { inputSchema: Record<string, unknown> }).inputSchema);
				}));
		const cases: [string, (standIn: StandIn) => void, string][] = [
			["required not an array", retyped((schema) => (schema.required = "pid")), "tools/list: click"],
			["required of numbers", retyped((schema) => (schema.required = [1])), "tools/list: click"],
			["required not iterable", retyped((schema) => (schema.required = 5)), "tools/list: click"],
			["properties null", retyped((schema) => (schema.properties = null)), "tools/list: click"],
			["tools not an array", (s) => (s.tools = () => ({ length: 3 }) as unknown as Record<string, unknown>[]), "tools/list: tools"],
			[
				"a response whose headers throw",
				(s) => {
					const fetch = s.fetch;
					Object.defineProperty(s, "fetch", {
						value: async (url: string, init: RequestInit) => {
							await fetch(url, init);
							return { status: 200, body: null, headers: { get: () => { throw new Error(LEAK); } } } as unknown as Response;
						},
					});
				},
				"internal",
			],
		];
		for (const [what, change, reason] of cases) {
			const standIn = new StandIn();
			change(standIn);
			const error = await client(standIn).openRun(RUN).then(() => assert.fail(what), (error: unknown) => error);
			assert.ok(error instanceof NativeMcpSetupError, what);
			assert.equal(error.reason, reason, what);
			assert.ok(!error.message.includes(LEAK), what);
			assert.equal(standIn.calls().length, 0, what);
		}

		const standIn = new StandIn();
		const mcp = client(standIn);
		const trap = () => {
			throw new Error(LEAK);
		};
		await assert.rejects(mcp.openRun(new Proxy(RUN, { get: trap })), (error: unknown) => error instanceof NativeMcpSetupError && error.reason === "identity");
		await assert.rejects(mcp.openRun(null as unknown as TrustedRun), (error: unknown) => error instanceof NativeMcpSetupError && error.reason === "identity");
		await assert.rejects(mcp.openRun(RUN, new Proxy(new AbortController().signal, { get: trap })), (error: unknown) => error instanceof NativeMcpSetupError && error.reason === "signal");
		assert.equal(standIn.sent.length, 0);
		assert.equal((await mcp.openRun(RUN)).state, "ready");
	});

	it("refuses a daemon that isn't the pinned one, or whose schemas drifted, before any call", async () => {
		const cases: [string, (standIn: StandIn) => void][] = [
			["version", (s) => (s.initialize = (session) => json({ jsonrpc: "2.0", id: s.lastId, result: { protocolVersion: "2025-06-18", serverInfo: { name: "cua-driver", version: "0.39.0" } } }, session))],
			["protocol", (s) => (s.initialize = (session) => json({ jsonrpc: "2.0", id: s.lastId, result: { protocolVersion: "2026-07-28", serverInfo: { name: "cua-driver", version: "0.38.0" } } }, session))],
			["no session", (s) => (s.initialize = () => json({ jsonrpc: "2.0", id: s.lastId, result: { protocolVersion: "2025-06-18", serverInfo: { name: "cua-driver", version: "0.38.0" } } }))],
			["missing tool", (s) => (s.tools = () => advertisedTools((tools) => tools.splice(tools.findIndex((tool) => tool.name === "click"), 1)))],
			[
				"retyped field",
				(s) =>
					(s.tools = () =>
						advertisedTools((tools) => {
							const click = tools.find((tool) => tool.name === "click") as { inputSchema: { properties: Record<string, unknown> } };
							click.inputSchema.properties.pid = { type: "string" };
						})),
			],
			[
				"opened schema",
				(s) =>
					(s.tools = () =>
						advertisedTools((tools) => {
							(tools.find((tool) => tool.name === "type_text") as { inputSchema: Record<string, unknown> }).inputSchema.additionalProperties = true;
						})),
			],
			["unauthorized", (s) => (s.initialize = () => new Response(`missing or invalid bearer token ${LEAK}`, { status: 401 }))],
		];
		for (const [what, change] of cases) {
			const standIn = new StandIn();
			change(standIn);
			const error = await client(standIn)
				.openRun(RUN)
				.then(
					() => assert.fail(what),
					(error: unknown) => error,
				);
			assert.ok(error instanceof NativeMcpSetupError, what);
			assert.ok(!error.message.includes(TOKEN) && !error.message.includes(LEAK), what);
			assert.equal(standIn.calls().length, 0, what);
		}
	});
});

// ---------------------------------------------------------------- what a caller can name

describe("curation", () => {
	it("refuses raw methods, lifecycle, config and every uncurated tool with no tools/call", async () => {
		const standIn = new StandIn();
		const run = await client(standIn).openRun(RUN);
		const names = [
			"initialize",
			"tools/list",
			"tools/call",
			"server/discover",
			"notifications/initialized",
			"cua/driver/v1/open",
			"launch_app",
			"kill_app",
			"run_steps",
			"run_actions",
			"run_script",
			"set_config",
			"get_config",
			"set_value",
			"drag",
			"page",
			"browser_navigate",
			"start_recording",
			"end_session",
			"set_agent_cursor_enabled",
			"__proto__",
			"constructor",
			"toString",
			"",
		];
		for (const tool of names) assert.deepEqual(await run.invoke(call({ tool })), { status: "rejected", reason: "unknown_tool" }, tool);
		assert.deepEqual(await run.invoke(call({ tool: ["list_apps"] as unknown as string })), { status: "rejected", reason: "unknown_tool" });
		assert.equal(standIn.calls().length, 0);
		assert.equal(run.state, "ready");
	});

	it("refuses arguments the curated schema doesn't admit, transport fields among them, with no tools/call", async () => {
		const standIn = new StandIn();
		const run = await client(standIn).openRun(RUN);
		class Point {
			x = 1;
		}
		const clickAt = { pid: 42, window_id: 7, x: 10, y: 20 };
		const refused: [string, unknown][] = [
			["click", { ...clickAt, session: "someone-else" }],
			["click", { ...clickAt, _session_id: "agent-x" }],
			["click", { ...clickAt, _transport_session_id: "x" }],
			["click", { ...clickAt, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }],
			["click", { ...clickAt, scope: "desktop" }],
			["click", { ...clickAt, cursor_id: "other" }],
			["click", { ...clickAt, count: 4 }],
			["click", { ...clickAt, x: Number.NaN }],
			["click", { ...clickAt, x: -1 }],
			["click", { window_id: 7, x: 10, y: 20 }],
			["click", { ...clickAt, element_token: "s0000002a:11; rm -rf" }],
			["get_window_state", { pid: 42, screenshot_out_file: "/tmp/x.png" }],
			["get_window_state", { pid: 42, max_image_dimension: 0 }],
			["get_window_state", { pid: 42, timeout_ms: 120_000 }],
			["type_text", { pid: 42, text: "x".repeat(4097) }],
			["type_text", { pid: 42, text: "hi", method: "tools/call", params: {} }],
			["press_key", { pid: 42, key: "a", modifiers: ["ctrl", "hyper"] }],
			["hotkey", { pid: 42, keys: ["ctrl"] }],
			["scroll", { pid: 42, direction: "up", amount: 51 }],
			["list_apps", { jsonrpc: "2.0" }],
			["list_apps", [{ jsonrpc: "2.0", method: "tools/call" }]],
			["list_apps", null],
			["list_apps", "{}"],
			["list_windows", { app: { nested: { deeper: { deepest: 1 } } } }],
			["list_windows", Object.defineProperty({}, "pid", { get: () => 42, enumerable: true })],
			["list_windows", new Point()],
			["list_windows", new Map([["pid", 42]])],
			["list_windows", { [Symbol("pid")]: 42 }],
		];
		for (const [tool, args] of refused) {
			assert.deepEqual(await run.invoke(call({ tool, arguments: args })), { status: "rejected", reason: "invalid_arguments" }, `${tool} ${JSON.stringify(args)}`);
		}
		assert.equal(standIn.calls().length, 0);
	});

	it("can't be widened by whoever imports it", () => {
		assert.throws(() => Object.assign(TOOLS, { launch_app: { required: [], properties: {} } }), TypeError);
		assert.throws(() => Object.assign(TOOLS.click?.properties ?? {}, { session: { type: "string", maxLength: 64 } }), TypeError);
		assert.throws(() => Object.assign(UPSTREAM_TOOLS.click?.properties ?? {}, { session: { type: "string" } }), TypeError);
	});

	it("refuses unsent, never throwing, a call or signal that throws when read, and stays usable", async () => {
		const standIn = new StandIn();
		const run = await client(standIn).openRun(RUN);
		const trap = () => {
			throw new Error(LEAK);
		};
		const throwing = (key: string) => Object.defineProperty({ ...call({ tool: "list_windows", arguments: { pid: 42 } }) }, key, { get: trap, enumerable: true });
		const cases: [string, () => Promise<NativeOutcome>, NativeOutcome][] = [
			["arguments whose prototype trap throws", () => run.invoke(call({ arguments: new Proxy({}, { getPrototypeOf: trap }) })), { status: "rejected", reason: "invalid_arguments" }],
			["arguments whose ownKeys trap throws", () => run.invoke(call({ arguments: new Proxy({}, { ownKeys: trap }) })), { status: "rejected", reason: "invalid_arguments" }],
			["arguments whose descriptor trap throws", () => run.invoke(call({ tool: "list_windows", arguments: new Proxy({ pid: 42 }, { getOwnPropertyDescriptor: trap }) })), { status: "rejected", reason: "invalid_arguments" }],
			["an argument getter that throws", () => run.invoke(call({ tool: "list_windows", arguments: Object.defineProperty({}, "pid", { get: trap, enumerable: true }) })), { status: "rejected", reason: "invalid_arguments" }],
			["a nested array whose trap throws", () => run.invoke(call({ tool: "press_key", arguments: { pid: 42, key: "a", modifiers: new Proxy(["ctrl"], { getOwnPropertyDescriptor: trap }) } })), { status: "rejected", reason: "invalid_arguments" }],
			["a call whose get trap throws", () => run.invoke(new Proxy(call(), { get: trap })), { status: "rejected", reason: "identity" }],
			["a call whose owner getter throws", () => run.invoke(throwing("owner") as NativeCall), { status: "rejected", reason: "identity" }],
			["a call whose callId getter throws", () => run.invoke(throwing("callId") as NativeCall), { status: "rejected", reason: "identity" }],
			["a call whose arguments getter throws", () => run.invoke(throwing("arguments") as NativeCall), { status: "rejected", reason: "invalid_arguments" }],
			["no call at all", () => run.invoke(null as unknown as NativeCall), { status: "rejected", reason: "identity" }],
			["a signal whose trap throws", () => run.invoke(call(), new Proxy(new AbortController().signal, { get: trap })), { status: "rejected", reason: "invalid_signal" }],
			["a signal that isn't one", () => run.invoke(call(), { aborted: false } as AbortSignal), { status: "rejected", reason: "invalid_signal" }],
		];
		for (const [what, invoke, expected] of cases) {
			let outcome: NativeOutcome | undefined;
			await assert.doesNotReject(async () => {
				outcome = await invoke();
			}, what);
			assert.deepEqual(outcome, expected, what);
			assert.ok(!JSON.stringify(outcome).includes(LEAK), what);
			assert.equal(run.state, "ready", what);
		}
		assert.equal(standIn.calls().length, 0);
		assert.equal((await run.invoke(call())).status, "completed");
		assert.equal(standIn.calls().length, 1);
	});

	it("sends exactly what was admitted, however the caller's object changes afterwards", async () => {
		const standIn = new StandIn();
		const run = await client(standIn).openRun(RUN);
		const args = { pid: 42, text: "hello", element_token: "s0000002a:11" };
		const pending = run.invoke(call({ tool: "type_text", arguments: args }));
		(args as Record<string, unknown>).text = "rm -rf ~";
		(args as Record<string, unknown>).session = "someone-else";
		await pending;
		assert.deepEqual(standIn.executed[0]?.arguments, { pid: 42, text: "hello", element_token: "s0000002a:11" });
		assert.equal(standIn.executed[0]?.name, "type_text");
		assert.deepEqual((standIn.calls()[0]?.body as { params: unknown }).params, { name: "type_text", arguments: { pid: 42, text: "hello", element_token: "s0000002a:11" } });
	});

	it("keeps a call in its own run: another owner, agent or run, or a reused call ID, is refused unsent", async () => {
		const standIn = new StandIn();
		const run = await client(standIn).openRun(RUN);
		for (const other of [{ owner: "space-bob" }, { agentId: "agent-2" }, { runId: "run-2" }]) {
			assert.deepEqual(await run.invoke(call(other)), { status: "rejected", reason: "identity" });
		}
		assert.equal((await run.invoke(call({ callId: "c-1" }))).status, "completed");
		assert.deepEqual(await run.invoke(call({ callId: "c-1" })), { status: "rejected", reason: "call_reused" });
		assert.equal(standIn.calls().length, 1);
	});
});

// ---------------------------------------------------------------- exactly one tools/call

describe("one tools/call per invoke", () => {
	const stream = (chunks: Uint8Array[], end: "close" | "error" | "hang", session: string) =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					if (end === "close") controller.close();
					if (end === "error") controller.error(new Error(LEAK));
				},
			}),
			{ headers: { "content-type": "application/json", "mcp-session-id": session } },
		);
	const never = (signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));

	const cases: { what: string; behaviour: Behaviour; abortAfterMs?: number; limits?: Partial<NativeMcpLimits>; expect: Partial<NativeOutcome> }[] = [
		{ what: "a result", behaviour: () => ({ content: [{ type: "text", text: "ok" }] }), expect: { status: "completed", isError: false } },
		{
			what: "the tool's error",
			behaviour: () => ({ content: [{ type: "text", text: "point_outside_window" }], isError: true, structuredContent: { code: "point_outside_window" } }),
			expect: { status: "completed", isError: true, code: "point_outside_window" },
		},
		{
			what: "an authorization refusal",
			behaviour: () => ({ content: [{ type: "text", text: "denied" }], isError: true, structuredContent: { code: "permission_denied", detail: LEAK } }),
			expect: { status: "completed", isError: true, code: "permission_denied" },
		},
		{ what: "a JSON-RPC error", behaviour: (_, id, session) => json({ jsonrpc: "2.0", id, error: { code: -32602, message: `Invalid params: ${LEAK}` } }, session), expect: { status: "rpc_error", code: -32602 } },
		{ what: "no answer in time", behaviour: (_, __, ___, signal) => never(signal), limits: { callMs: 20 }, expect: { status: "unknown", reason: "timeout" } },
		{ what: "the caller giving up after sending", behaviour: (_, __, ___, signal) => never(signal), abortAfterMs: 10, expect: { status: "unknown", reason: "aborted" } },
		{
			what: "fetch throwing after spacesd executed it",
			behaviour: () => {
				throw new TypeError(`fetch failed ${LEAK}`);
			},
			expect: { status: "unknown", reason: "transport" },
		},
		{ what: "HTTP 500", behaviour: (_, __, session) => json({ error: LEAK }, session, { status: 500 }), expect: { status: "unknown", reason: "http_status" } },
		{ what: "a redirect", behaviour: () => new Response(null, { status: 307, headers: { location: "http://evil.test/mcp" } }), expect: { status: "unknown", reason: "http_status" } },
		{ what: "an event stream", behaviour: (_, id, session) => json({ jsonrpc: "2.0", id, result: { content: [] } }, session, { type: "text/event-stream" }), expect: { status: "unknown", reason: "content_type" } },
		{ what: "another session's answer", behaviour: (_, id) => json({ jsonrpc: "2.0", id, result: { content: [] } }, "mcp-someone-else-0001"), expect: { status: "unknown", reason: "session_mismatch" } },
		{ what: "a malformed body", behaviour: (_, __, session) => stream([new TextEncoder().encode("{\"jsonrpc\":\"2.0\",")], "close", session), expect: { status: "unknown", reason: "malformed" } },
		{ what: "a batch answer", behaviour: (_, id, session) => json([{ jsonrpc: "2.0", id, result: { content: [] } }], session), expect: { status: "unknown", reason: "malformed" } },
		{ what: "both result and error", behaviour: (_, id, session) => json({ jsonrpc: "2.0", id, result: {}, error: { code: 1, message: "" } }, session), expect: { status: "unknown", reason: "malformed" } },
		{ what: "another request's answer", behaviour: (_, __, session) => json({ jsonrpc: "2.0", id: "pim-other", result: { content: [] } }, session), expect: { status: "unknown", reason: "id_mismatch" } },
		{ what: "a parse error's null id", behaviour: (_, __, session) => json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, session), expect: { status: "unknown", reason: "id_mismatch" } },
		{ what: "a body cut off", behaviour: (_, __, session) => stream([new TextEncoder().encode("{\"jsonrpc\":\"2.0\",\"id\"")], "error", session), expect: { status: "unknown", reason: "transport" } },
		{
			what: "an oversized body",
			behaviour: (_, id, session) => json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "x".repeat(4096) }] } }, session),
			limits: { maxResponseBytes: 1024 },
			expect: { status: "unknown", reason: "oversized" },
		},
		{
			what: "a body that stops mid-way",
			behaviour: (_, __, session) => stream([new TextEncoder().encode("{\"jsonrpc\":")], "hang", session),
			limits: { callMs: 30 },
			expect: { status: "unknown", reason: "timeout" },
		},
	];

	for (const { what, behaviour, abortAfterMs, limits, expect } of cases) {
		it(`sends one tools/call and never retries: ${what}`, async () => {
			const standIn = new StandIn();
			standIn.behaviour = behaviour;
			const run = await client(standIn, limits).openRun(RUN);
			const before = standIn.sent.length;
			const controller = new AbortController();
			if (abortAfterMs !== undefined) setTimeout(() => controller.abort(), abortAfterMs);
			const outcome = await run.invoke(call({ tool: "click", arguments: { pid: 42, window_id: 7, x: 1, y: 2 } }), controller.signal);
			for (const [key, value] of Object.entries(expect)) assert.deepEqual((outcome as Record<string, unknown>)[key], value, `${what}: ${key}`);
			assert.ok(!JSON.stringify(outcome).includes(LEAK) && !JSON.stringify(outcome).includes(TOKEN), what);
			assert.deepEqual(overTheWire(outcome), outcome, what);
			await settle();
			assert.equal(standIn.executed.length, 1, what);
			assert.equal(standIn.sent.length, before + 1, what);
			if (outcome.status === "unknown") {
				// Latched: nothing more is sent for this run, and nothing clears it.
				assert.equal(run.state, "uncertain");
				const refused = await run.invoke(call());
				assert.deepEqual(refused, { status: "rejected", reason: "uncertain" });
				assert.deepEqual(overTheWire(refused), refused);
				run.close();
				assert.deepEqual(await run.invoke(call()), { status: "rejected", reason: "uncertain" });
				assert.equal(standIn.sent.length, before + 1, what);
			} else assert.equal(run.state, "ready");
		});
	}

	it("keeps an unexpected error after the handoff unknown, not refused", async () => {
		const standIn = new StandIn();
		// A response that passes for one until its headers are read, after spacesd executed the call.
		standIn.behaviour = () => Object.setPrototypeOf({ status: 200, body: null, headers: { get: () => { throw new Error(LEAK); } } }, Response.prototype);
		const run = await client(standIn).openRun(RUN);
		assert.deepEqual(await run.invoke(call()), { status: "unknown", reason: "transport" });
		assert.equal(standIn.executed.length, 1);
		assert.equal(run.state, "uncertain");
	});

	it("ignores an answer that comes after the call was given up, and replays nothing", async () => {
		const standIn = new StandIn();
		let release: (() => void) | undefined;
		// A fetch that doesn't heed the signal: its answer arrives after the bound.
		standIn.behaviour = (_, id, session) =>
			new Promise<Response>((resolve) => {
				release = () => resolve(json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "late" }] } }, session));
			});
		const run = await client(standIn, { callMs: 20 }).openRun(RUN);
		const before = standIn.sent.length;
		assert.deepEqual(await run.invoke(call({ tool: "list_apps" })), { status: "unknown", reason: "timeout" });
		release?.();
		await settle();
		assert.equal(run.state, "uncertain");
		assert.equal(standIn.executed.length, 1);
		assert.equal(standIn.sent.length, before + 1);
	});

	it("refuses unsent a call aborted before sending, and one made while another is in flight", async () => {
		const standIn = new StandIn();
		let release: (() => void) | undefined;
		standIn.behaviour = (_, id, session) => new Promise((resolve) => (release = () => resolve(json({ jsonrpc: "2.0", id, result: { content: [] } }, session))));
		const run = await client(standIn).openRun(RUN);
		const controller = new AbortController();
		controller.abort();
		assert.deepEqual(await run.invoke(call(), controller.signal), { status: "rejected", reason: "aborted" });
		const first = run.invoke(call());
		await settle();
		assert.equal(run.state, "busy");
		assert.deepEqual(await run.invoke(call()), { status: "rejected", reason: "busy" });
		release?.();
		assert.equal((await first).status, "completed");
		assert.equal(standIn.calls().length, 1);
	});

	it("closes without sending anything, and refuses unsent after", async () => {
		const standIn = new StandIn();
		const run = await client(standIn).openRun(RUN);
		const before = standIn.sent.length;
		run.close();
		assert.equal(standIn.sent.length, before);
		assert.deepEqual(await run.invoke(call()), { status: "rejected", reason: "closed" });
		assert.equal(standIn.sent.length, before);
		assert.ok(!standIn.sent.some((sent) => sent.method === "DELETE"));
	});

	it("returns an unknown outcome as a value whose dispatch effect is uncertain, never as an answered error", async () => {
		const standIn = new StandIn();
		standIn.behaviour = () => {
			throw new TypeError("socket hang up");
		};
		const run = await client(standIn).openRun(RUN);
		const outcome = await run.invoke(call());
		assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: "unknown", reason: "transport" });
		assert.deepEqual(dispatchEffect(outcome), { sent: true, uncertain: true });
		assert.deepEqual(dispatchEffect({ status: "rejected", reason: "busy" }), { sent: false, uncertain: false });
		assert.deepEqual(dispatchEffect({ status: "rpc_error", code: -32602 }), { sent: true, uncertain: false });
		assert.deepEqual(dispatchEffect({ status: "completed", isError: true, code: null, content: [], presentation: [] }), { sent: true, uncertain: false });
	});
});

// ---------------------------------------------------------------- results

describe("results", () => {
	async function result(value: Record<string, unknown>, limits: Partial<NativeMcpLimits> = {}) {
		const standIn = new StandIn();
		standIn.behaviour = () => value;
		const run = await client(standIn, limits).openRun(RUN);
		const outcome = await run.invoke(call({ tool: "get_window_state", arguments: { pid: 42 } }));
		assert.equal(outcome.status, "completed");
		assert.deepEqual(overTheWire(outcome), outcome);
		return { outcome: outcome as Extract<NativeOutcome, { status: "completed" }>, standIn };
	}

	it("passes on bounded text and checked images, and says what it left out", async () => {
		const { outcome, standIn } = await result({
			content: [
				{ type: "text", text: "[1] button \"OK\"" },
				{ type: "image", mimeType: "image/png", data: png(1280, 800) },
				{ type: "image", mimeType: "image/jpeg", data: jpeg(640, 480) },
				{ type: "image", mimeType: "image/png", data: png(5000, 10) },
				{ type: "image", mimeType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") },
				{ type: "image", mimeType: "image/jpeg", data: png(10, 10) },
				{ type: "image", mimeType: "image/png", data: "not base64!" },
				{ type: "image", mimeType: "image/png", data: Buffer.concat([Buffer.from("GIF89a\0\0"), Buffer.from(png(8, 8), "base64").subarray(8)]).toString("base64") },
				{ type: "resource_link", uri: "http://evil.test/payload", name: "x" },
				{ type: "resource", resource: { uri: "file:///etc/shadow", text: "x" } },
			],
			structuredContent: { secret: TOKEN },
		});
		assert.deepEqual(
			outcome.content.map((item) => (item.type === "text" ? item.text : `${item.mimeType} ${item.width}x${item.height}`)),
			["[1] button \"OK\"", "image/png 1280x800", "image/jpeg 640x480"],
		);
		assert.deepEqual(outcome.presentation, [
			{ kind: "image_omitted", index: 3 },
			{ kind: "image_omitted", index: 4 },
			{ kind: "image_omitted", index: 5 },
			{ kind: "image_omitted", index: 6 },
			{ kind: "image_omitted", index: 7 },
			{ kind: "content_omitted", index: 8 },
			{ kind: "content_omitted", index: 9 },
		]);
		assert.ok(!JSON.stringify(outcome).includes(TOKEN));
		assert.ok(standIn.sent.every((sent) => sent.url === `${ORIGIN}/mcp`));
	});

	it("truncates text and drops images past their bounds without changing the outcome", async () => {
		const { outcome } = await result(
			{ content: [{ type: "text", text: "ééééé" }, { type: "text", text: "more" }, ...Array.from({ length: 3 }, () => ({ type: "image", mimeType: "image/png", data: png(8, 8) }))] },
			{ maxTextBytes: 5, maxImages: 2 },
		);
		assert.deepEqual(outcome.content.slice(0, 1), [{ type: "text", text: "éé" }]);
		assert.equal(outcome.content.filter((item) => item.type === "image").length, 2);
		assert.deepEqual(outcome.presentation, [
			{ kind: "text_truncated", index: 0 },
			{ kind: "text_truncated", index: 1 },
			{ kind: "image_omitted", index: 4 },
		]);
		assert.equal(outcome.isError, false);
	});

	it("bounds what it reads, keeps and reports however many items a result has, and the outcome stays known", async () => {
		const many = 10_000;
		const inputs: [string, unknown[]][] = [
			["nulls", Array(many).fill(null)],
			["tiny texts", Array.from({ length: many }, () => ({ type: "text", text: "a" }))],
			["empty texts", Array.from({ length: many }, () => ({ type: "text", text: "" }))],
			["valid images", Array.from({ length: many }, () => ({ type: "image", mimeType: "image/png", data: png(8, 8) }))],
			["bad images", Array.from({ length: many }, () => ({ type: "image", mimeType: "image/gif", data: "R0lGODlh" }))],
			["resource links", Array.from({ length: many }, (_, i) => ({ type: "resource_link", uri: `http://evil.test/${i}` }))],
			["a mix", Array.from({ length: many }, (_, i) => [null, 7, { type: "text", text: "é" }, { type: "audio" }][i % 4])],
		];
		for (const [what, content] of inputs) {
			const { outcome, standIn } = await result({ content, isError: "maybe" });
			const bytes = Buffer.byteLength(JSON.stringify(outcome));
			assert.ok(outcome.content.length <= DEFAULT_LIMITS.maxContentItems, what);
			assert.ok(outcome.presentation.length <= DEFAULT_LIMITS.maxContentItems + 2, what);
			assert.deepEqual(outcome.presentation.at(-1), { kind: "items_unread", count: many - DEFAULT_LIMITS.maxContentItems }, what);
			assert.equal(outcome.presentation.filter((issue) => issue.kind === "items_unread").length, 1, what);
			assert.ok(bytes <= 64 * 1024, `${what}: ${bytes} bytes`);
			assert.equal(outcome.isError, true, what);
			assert.equal(standIn.executed.length, 1, what);
		}
	});

	it("keeps an outcome within maxOutputBytes, cutting text whose JSON grows and leaving out images that don't fit", async () => {
		const limits = { maxOutputBytes: 16 * 1024, maxContentItems: 8, maxTextBytes: 64 * 1024 };
		const big = Buffer.concat([Buffer.from(png(8, 8), "base64"), Buffer.alloc(20_000)]).toString("base64");
		const { outcome } = await result(
			{
				content: [
					{ type: "image", mimeType: "image/png", data: big },
					{ type: "text", text: "\u0001".repeat(100_000) },
					{ type: "text", text: "\u0001".repeat(100_000) },
					{ type: "image", mimeType: "image/png", data: png(8, 8) },
					...Array(20).fill(null),
				],
			},
			limits,
		);
		assert.ok(Buffer.byteLength(JSON.stringify(outcome)) <= limits.maxOutputBytes);
		assert.deepEqual(outcome.presentation.slice(0, 4), [
			{ kind: "image_omitted", index: 0 },
			{ kind: "text_truncated", index: 1 },
			{ kind: "text_truncated", index: 2 },
			{ kind: "image_omitted", index: 3 },
		]);
		assert.equal(outcome.content.length, 1);
		assert.ok(outcome.content[0]?.type === "text" && outcome.content[0].text.length > 2000);
		assert.deepEqual(outcome.presentation.at(-1), { kind: "items_unread", count: 24 - 8 });
		assert.equal(outcome.status, "completed");
	});

	it("doesn't take a malformed error flag as success", async () => {
		const { outcome } = await result({ content: "nope", isError: "false" });
		assert.equal(outcome.isError, true);
		assert.deepEqual(outcome.presentation, [{ kind: "is_error_malformed" }, { kind: "content_malformed" }]);
	});

	it("is read on the wire as kept at the client's highest limits, and not past the wire's own bounds", async () => {
		const highest = {
			maxContentItems: LIMIT_RANGES.maxContentItems[1],
			maxImages: LIMIT_RANGES.maxImages[1],
			maxTextBytes: LIMIT_RANGES.maxTextBytes[1],
			maxOutputBytes: LIMIT_RANGES.maxOutputBytes[1],
		};
		assert.deepEqual(highest, {
			maxContentItems: NATIVE_WIRE_LIMITS.maxContentItems,
			maxImages: NATIVE_WIRE_LIMITS.maxImages,
			maxTextBytes: NATIVE_WIRE_LIMITS.maxTextBytes,
			maxOutputBytes: NATIVE_WIRE_LIMITS.maxOutcomeChars,
		});
		const many = [
			{ type: "text", text: "é".repeat(2 * 1024 * 1024 + 10) },
			...Array.from({ length: 20 }, () => ({ type: "image", mimeType: "image/png", data: png(8, 8) })),
			...Array.from({ length: 2000 }, (_, i) => [null, { type: "text", text: "a" }, { type: "audio" }][i % 3]),
		];
		const { outcome } = await result({ content: many, isError: true, structuredContent: { code: "permission_denied" } }, highest);
		// Kept to the full, as `result` reads it on the wire.
		assert.equal(outcome.content.filter((item) => item.type === "image").length, NATIVE_WIRE_LIMITS.maxImages);
		assert.ok(outcome.content.length > 300 && outcome.presentation.length > 600 && outcome.code === "permission_denied");

		// One past each bound, and each bound itself.
		const base = { status: "completed", isError: false, code: null, content: [], presentation: [] };
		const text = (value: string) => ({ type: "text", text: value });
		const image = { type: "image", mimeType: "image/png", data: png(8, 8), width: 8, height: 8 };
		const cases: [string, unknown, boolean][] = [
			["items at the bound", { ...base, content: Array(1024).fill(text("")) }, true],
			["items past it", { ...base, content: Array(1025).fill(text("")) }, false],
			["images at the bound", { ...base, content: Array(16).fill(image) }, true],
			["images past it", { ...base, content: Array(17).fill(image) }, false],
			["text at the bound", { ...base, content: [text("é".repeat(2 * 1024 * 1024))] }, true],
			["text past it, in bytes", { ...base, content: [text("é".repeat(2 * 1024 * 1024)), text("a")] }, false],
			["an image wider than any", { ...base, content: [{ ...image, width: 16_385 }] }, false],
			["JSON past the wire's budget, from escapes", { ...base, content: [text("\u0001".repeat(3 * 1024 * 1024))] }, false],
			["images past the wire's budget", { ...base, content: Array(16).fill({ ...image, data: "A".repeat(1024 * 1024 + 4) }) }, false],
			["issues at the bound", { ...base, presentation: Array(1028).fill({ kind: "content_omitted", index: 1023 }) }, true],
			["issues past it", { ...base, presentation: Array(1029).fill({ kind: "content_omitted", index: 0 }) }, false],
			["an index past the items", { ...base, presentation: [{ kind: "image_omitted", index: 1024 }] }, false],
			["no items unread", { ...base, presentation: [{ kind: "items_unread", count: 0 }] }, false],
			["an index on the result", { ...base, presentation: [{ kind: "content_malformed", index: 0 }] }, false],
			["an inherited-looking key", JSON.parse('{"status":"rejected","reason":"busy","__proto__":{"x":1}}'), false],
		];
		for (const [what, value, read] of cases) assert.equal(readNativeOutcome(value) !== null, read, what);
	});

	it("keeps an outcome and its reply within one bridge message, and reads one exactly at the budget", () => {
		assert.equal(BRIDGE_MESSAGE_CHARS, MAX_MESSAGE_CHARS);
		assert.equal(DEFAULT_LIMITS.maxOutputBytes, NATIVE_WIRE_LIMITS.maxOutcomeChars);
		assert.ok(NATIVE_WIRE_LIMITS.maxOutcomeChars < MAX_MESSAGE_CHARS);
		const sized = (chars: number) => {
			const empty = { status: "completed", isError: false, code: null, content: [{ type: "image", mimeType: "image/png", data: "", width: 8, height: 8 }], presentation: [] };
			const data = "A".repeat(Math.floor((chars - JSON.stringify(empty).length) / 4) * 4);
			return { ...empty, content: [{ ...empty.content[0], data }] };
		};
		const atBudget = sized(NATIVE_WIRE_LIMITS.maxOutcomeChars);
		const length = JSON.stringify(atBudget).length;
		assert.ok(length <= NATIVE_WIRE_LIMITS.maxOutcomeChars && length > NATIVE_WIRE_LIMITS.maxOutcomeChars - 4);
		assert.notEqual(readNativeOutcome(atBudget), null);
		assert.equal(readNativeOutcome(sized(NATIVE_WIRE_LIMITS.maxOutcomeChars + 4)), null);
		// pim-computer's reply to the space around it, with the space's call ID, still fits one message.
		assert.ok(JSON.stringify({ type: "reply", id: crypto.randomUUID(), result: atBudget }).length <= MAX_MESSAGE_CHARS);
	});

	it("checks base64 a character at a time: as strictly as the pattern did, and multi-megabyte texts without overflowing", () => {
		// The pattern the client used, which overflows the stack on a few megabytes, as the reference for short texts.
		const pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
		const alphabet = ["A", "z", "0", "+", "/", "=", "!", "-", "\u00e9"];
		let texts = [""];
		for (let length = 1; length <= 5; length++) {
			texts = texts.flatMap((text) => (text.length === length - 1 ? alphabet.map((char) => text + char) : []));
			for (const text of texts) assert.equal(isBase64(text), pattern.test(text), JSON.stringify(text));
		}
		assert.throws(() => pattern.test("A".repeat(8_000_000)), RangeError);
		assert.equal(isBase64("A".repeat(8_000_000)), true);
		assert.equal(isBase64(`${"A".repeat(7_999_998)}==`), true);
		assert.equal(isBase64(`${"A".repeat(7_999_999)}!`), false);
		assert.equal(isBase64(`${"A".repeat(4_000_000)}=${"A".repeat(3_999_999)}`), false);
		assert.equal(isBase64("A".repeat(8_000_001)), false);
	});

	it("keeps a multi-megabyte screenshot, which the pattern couldn't check, as a known result", async () => {
		const data = Buffer.concat([Buffer.from(png(1568, 733), "base64"), Buffer.alloc(6 * 1024 * 1024)]).toString("base64");
		assert.ok(data.length > 8_000_000);
		const { outcome, standIn } = await result({ content: [{ type: "image", mimeType: "image/png", data }] });
		assert.deepEqual(outcome.content.map((item) => item.type === "image" && [item.width, item.height, item.data === data]), [[1568, 733, true]]);
		assert.deepEqual(outcome.presentation, []);
		assert.equal(standIn.executed.length, 1);
	});

	it("keeps limits that bound a screenshot of the pinned default size", () => {
		// get_window_state delivers at most 1.15 megapixels, its long edge at most 1568 by default.
		assert.ok(DEFAULT_LIMITS.maxImageSide >= 1568 && DEFAULT_LIMITS.maxImagePixels >= 1_150_000);
	});
});

describe("the space's calls, through createNativeDispatcher", () => {
	const dispatcher = (standIn: StandIn) => createNativeDispatcher({ origin: ORIGIN, token: TOKEN, owner: OWNER, fetch: standIn.fetch, limits: { callMs: 1_000 } });
	/** A call's args as the space sends them (`Computer.native`), off the wire. */
	const wire = (overrides: Record<string, unknown> = {}): unknown =>
		JSON.parse(JSON.stringify({ owner: OWNER, agentId: "agent-1", runId: "run-1", callId: `request-${Math.random()}`, tool: "click", arguments: { pid: 42 }, ...overrides }));
	const methods = (standIn: StandIn) => standIn.sent.map((sent) => (sent.body as { method: string }).method);
	const DONE: NativeOutcome = { status: "completed", isError: false, code: null, content: [{ type: "text", text: "done" }], presentation: [] };

	it("names exactly the curated tools on both sides", () => {
		assert.deepEqual([...NATIVE_TOOLS].sort(), Object.keys(TOOLS).sort());
	});

	it("calls each request's tool once, in its run's own driver session, setting each run up once", async () => {
		const standIn = new StandIn();
		const native = dispatcher(standIn);
		assert.deepEqual(await native.dispatch(wire({ callId: "r1" })), DONE);
		assert.deepEqual(await native.dispatch(wire({ callId: "r2", tool: "list_apps", arguments: {} })), DONE);
		assert.deepEqual(await native.dispatch(wire({ callId: "r3", agentId: "agent-2", runId: "run-2", tool: "list_apps", arguments: {} })), DONE);
		const session = (agentId: string, runId: string) => `agent-${agentSessionOf({ owner: OWNER, agentId, runId })}`;
		assert.deepEqual(
			standIn.executed.map((each) => [each.name, each.arguments, each.driverSession]),
			[
				["click", { pid: 42 }, session("agent-1", "run-1")],
				["list_apps", {}, session("agent-1", "run-1")],
				["list_apps", {}, session("agent-2", "run-2")],
			],
		);
		assert.equal(methods(standIn).filter((method) => method === "initialize").length, 2);
		// The run's call ID is the request's, so the same request sent again is refused unsent.
		assert.deepEqual(await native.dispatch(wire({ callId: "r1", tool: "list_apps", arguments: {} })), { status: "rejected", reason: "call_reused" });
		assert.equal(standIn.calls().length, 3);
	});

	it("refuses unsent, with no setup, anything but a request of its own space for a curated tool with admitted arguments", async () => {
		const standIn = new StandIn();
		const native = dispatcher(standIn);
		const valid = wire() as Record<string, unknown>;
		const without = (key: string) => Object.fromEntries(Object.entries(valid).filter(([each]) => each !== key));
		const cases: [string, unknown, string][] = [
			["another space", wire({ owner: "space-bob" }), "identity"],
			["no owner", without("owner"), "identity"],
			["no run", without("runId"), "identity"],
			["no call ID", without("callId"), "identity"],
			["a session beside the call", wire({ session: "agent-x" }), "identity"],
			["an endpoint beside the call", wire({ origin: "https://evil.test", token: LEAK }), "identity"],
			["an agent session beside the call", wire({ agentSession: "pim-0000" }), "identity"],
			["a numeric agent", wire({ agentId: 7 }), "identity"],
			["an agent with a space", wire({ agentId: "agent 1" }), "identity"],
			["a run with a newline", wire({ runId: "run-1\n" }), "identity"],
			["a call ID of 257 characters", wire({ callId: "c".repeat(257) }), "identity"],
			["arguments that are a list", wire({ arguments: [42] }), "identity"],
			["arguments that are null", wire({ arguments: null }), "identity"],
			["a list", [valid], "identity"],
			["null", null, "identity"],
			["a string", JSON.stringify(valid), "identity"],
			["launch_app", wire({ tool: "launch_app", arguments: { name: "xterm" } }), "unknown_tool"],
			["run_steps", wire({ tool: "run_steps" }), "unknown_tool"],
			["a raw method", wire({ tool: "tools/call" }), "unknown_tool"],
			["__proto__", wire({ tool: "__proto__" }), "unknown_tool"],
			["a session argument", wire({ arguments: { pid: 42, session: "other" } }), "invalid_arguments"],
			["an owner argument", wire({ arguments: { pid: 42, owner: "space-bob" } }), "invalid_arguments"],
			["a _meta argument", wire({ arguments: { pid: 42, _meta: {} } }), "invalid_arguments"],
			["the desktop at large", wire({ arguments: { pid: 42, scope: "desktop" } }), "invalid_arguments"],
			["a file written", wire({ tool: "get_window_state", arguments: { pid: 42, screenshot_out_file: "/tmp/x.png" } }), "invalid_arguments"],
			["no pid", wire({ arguments: { x: 1, y: 1 } }), "invalid_arguments"],
		];
		for (const [what, args, reason] of cases) {
			const outcome = await native.dispatch(args);
			assert.deepEqual(outcome, { status: "rejected", reason }, what);
			assert.deepEqual(overTheWire(outcome), outcome, what);
		}
		assert.deepEqual(standIn.sent, []);
	});

	it("calls only the arguments it checked when the caller changes its object while the run is set up", async () => {
		const standIn = new StandIn();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const native = createNativeDispatcher({
			origin: ORIGIN,
			token: TOKEN,
			owner: OWNER,
			fetch: async (url, init) => {
				await held;
				return standIn.fetch(url, init);
			},
			limits: { callMs: 1_000 },
		});
		// The caller's own object, not a parsed copy of it.
		const args = { owner: OWNER, agentId: "agent-1", runId: "run-1", callId: "r1", tool: "click", arguments: { pid: 42, x: 10, y: 20 } as Record<string, unknown> };
		const answer = native.dispatch(args);
		await settle();
		// Setup is pending: the call was checked, and nothing has reached the stand-in.
		assert.equal(standIn.sent.length, 0);
		args.arguments.pid = 7;
		args.arguments.session = "agent-someone-else";
		args.arguments.scope = "desktop";
		args.tool = "type_text";
		args.arguments.text = "rm -rf ~";
		args.runId = "run-2";
		args.callId = "r2";
		release();
		assert.deepEqual(await answer, DONE);
		assert.deepEqual(
			standIn.executed.map((each) => [each.name, each.arguments, each.driverSession]),
			[["click", { pid: 42, x: 10, y: 20 }, `agent-${agentSessionOf({ owner: OWNER, agentId: "agent-1", runId: "run-1" })}`]],
		);
	});

	it("never throws, and sends nothing, for getters, proxies, toJSON and values JSON would convert", async () => {
		const standIn = new StandIn();
		const native = dispatcher(standIn);
		const valid = () => wire() as Record<string, unknown>;
		const trapped = (target: object) =>
			new Proxy(target, {
				getPrototypeOf: () => {
					throw new Error(LEAK);
				},
				ownKeys: () => {
					throw new Error(LEAK);
				},
				getOwnPropertyDescriptor: () => {
					throw new Error(LEAK);
				},
				get: () => {
					throw new Error(LEAK);
				},
			});
		/** A proxy that answers its descriptors once with what passes, then with something else. */
		const shifting = () => {
			let reads = 0;
			return new Proxy({ pid: 42 } as Record<string, unknown>, {
				getOwnPropertyDescriptor: (target, key) => ({ ...Reflect.getOwnPropertyDescriptor(target, key), value: reads++ === 0 ? 42 : "rm -rf ~" }),
			});
		};
		const cases: [string, unknown][] = [
			["a getter for the owner", Object.defineProperty(valid(), "owner", { enumerable: true, get: () => OWNER })],
			["a getter for the tool that throws", Object.defineProperty(valid(), "tool", { enumerable: true, get: () => { throw new Error(LEAK); } })],
			["a getter in the arguments", { ...valid(), arguments: Object.defineProperty({}, "pid", { enumerable: true, get: () => 42 }) }],
			["a getter in the arguments that throws", { ...valid(), arguments: Object.defineProperty({}, "pid", { enumerable: true, get: () => { throw new Error(LEAK); } }) }],
			["toJSON in the arguments", { ...valid(), arguments: { pid: 42, toJSON: () => ({ pid: 42 }) } }],
			["toJSON on a value", { ...valid(), arguments: { pid: { toJSON: () => 42 } } }],
			["toJSON as data", { ...valid(), arguments: { pid: 42, toJSON: "x" } }],
			["a date", { ...valid(), tool: "get_window_state", arguments: { pid: 42, since: new Date(0) } }],
			["arguments that are a date", { ...valid(), arguments: new Date(0) }],
			["a map", { ...valid(), arguments: new Map([["pid", 42]]) }],
			["a bigint", { ...valid(), arguments: { pid: 42n } }],
			["undefined", { ...valid(), arguments: { pid: 42, x: undefined } }],
			["a function", { ...valid(), arguments: { pid: 42, x: () => 1 } }],
			["infinity", { ...valid(), arguments: { pid: 42, x: Number.POSITIVE_INFINITY } }],
			["a symbol key", { ...valid(), arguments: { pid: 42, [Symbol("x")]: 1 } }],
			["a hidden property", { ...valid(), arguments: Object.defineProperty({ pid: 42 }, "x", { value: 1, enumerable: false }) }],
			["an array with a hole", { ...valid(), tool: "hotkey", arguments: { pid: 42, keys: [, "a"] } }],
			["an array with a named property", { ...valid(), tool: "hotkey", arguments: { pid: 42, keys: Object.assign(["ctrl", "a"], { extra: 1 }) } }],
			["an array of another prototype", { ...valid(), tool: "hotkey", arguments: { pid: 42, keys: Object.setPrototypeOf(["ctrl", "a"], null) } }],
			["a cycle", { ...valid(), arguments: (() => { const cycle: Record<string, unknown> = { pid: 42 }; cycle.self = cycle; return cycle; })() }],
			["too deep", { ...valid(), arguments: { pid: 42, a: { b: { c: { d: {} } } } } }],
			["past the bound", { ...valid(), tool: "type_text", arguments: { pid: 42, text: "x".repeat(NATIVE_ARGUMENTS_CHARS) } }],
			["a proxy whose traps throw", trapped(valid())],
			["arguments behind a proxy whose traps throw", { ...valid(), arguments: trapped({ pid: 42 }) }],
			["keys behind a proxy whose traps throw", { ...valid(), tool: "hotkey", arguments: { pid: 42, keys: trapped(["ctrl", "a"]) } }],
		];
		for (const [what, args] of cases) {
			const outcome = await native.dispatch(args);
			assert.equal(outcome.status, "rejected", what);
			assert.ok(!JSON.stringify(outcome).includes(LEAK), what);
		}
		// A proxy that changes its answer after the first read: only the first is copied, and checked.
		const changing = { ...valid(), arguments: shifting() };
		assert.deepEqual(await native.dispatch(changing), DONE);
		assert.deepEqual(standIn.executed.map((each) => each.arguments), [{ pid: 42 }]);
		assert.equal(standIn.calls().length, 1);
	});

	it("reads a request into a frozen copy that shares nothing with what it read", () => {
		const nested = { pid: 42, keys: ["ctrl", "a"] };
		const args = { owner: OWNER, agentId: "agent-1", runId: "run-1", callId: "r1", tool: "hotkey", arguments: nested };
		const read = readNativeRequest(args);
		assert.deepEqual(read, args);
		assert.notEqual(read?.arguments, nested);
		assert.notEqual(read?.arguments.keys, nested.keys);
		assert.ok(Object.isFrozen(read) && Object.isFrozen(read?.arguments) && Object.isFrozen(read?.arguments.keys));
		nested.pid = 7;
		nested.keys.push("x");
		assert.deepEqual(read?.arguments, { pid: 42, keys: ["ctrl", "a"] });
		// JSON's own values only, up to the bound and four levels deep; `__proto__` is never a key.
		assert.ok(readNativeRequest({ ...args, arguments: { pid: 42, a: { b: [null, true, 1.5, "s"] } } }));
		assert.equal(readNativeRequest({ ...args, arguments: JSON.parse('{"pid":42,"__proto__":{"x":1}}') }), null);
		assert.ok(readNativeRequest({ ...args, arguments: { text: "x".repeat(NATIVE_ARGUMENTS_CHARS - 11) } }));
		assert.equal(readNativeRequest({ ...args, arguments: { text: "x".repeat(NATIVE_ARGUMENTS_CHARS - 10) } }), null);
	});

	it("never opens a run twice: after an unknown outcome every call of the run is refused unsent, whatever its call ID", async () => {
		const standIn = new StandIn();
		standIn.behaviour = (_, __, session) => json({ error: LEAK }, session, { status: 500 });
		const native = dispatcher(standIn);
		assert.deepEqual(await native.dispatch(wire({ callId: "r1" })), { status: "unknown", reason: "http_status" });
		standIn.behaviour = () => ({ content: [{ type: "text", text: "done" }] });
		for (const callId of ["r1", "r2", "r3"]) {
			assert.deepEqual(await native.dispatch(wire({ callId, tool: "list_apps", arguments: {} })), { status: "rejected", reason: "uncertain" }, callId);
		}
		assert.deepEqual(methods(standIn), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
		// Another run is the space's to admit, or not; here it is a run of its own.
		assert.deepEqual(await native.dispatch(wire({ callId: "r4", runId: "run-2", tool: "list_apps", arguments: {} })), DONE);
		assert.equal(standIn.calls().length, 2);
	});

	it("refuses a run it can't set up as unavailable, with no tool called, and may set it up on a later call", async () => {
		const standIn = new StandIn();
		standIn.tools = () => advertisedTools((tools) => void tools.splice(0, tools.length));
		const native = dispatcher(standIn);
		const outcome = await native.dispatch(wire({ callId: "r1" }));
		assert.deepEqual(outcome, { status: "rejected", reason: "unavailable" });
		assert.deepEqual(overTheWire(outcome), outcome);
		assert.equal(standIn.executed.length, 0);
		standIn.tools = () => advertisedTools();
		assert.deepEqual(await native.dispatch(wire({ callId: "r2" })), DONE);
		assert.equal(standIn.executed.length, 1);
	});

	it("keeps at most MAX_RUNS runs, refusing a new one past them unsent", async () => {
		const standIn = new StandIn();
		const native = dispatcher(standIn);
		for (let run = 0; run < MAX_RUNS; run++) await native.dispatch(wire({ runId: `run-${run}`, tool: "list_apps", arguments: {} }));
		const sent = standIn.sent.length;
		assert.deepEqual(await native.dispatch(wire({ runId: "one-more", tool: "list_apps", arguments: {} })), { status: "rejected", reason: "unavailable" });
		assert.equal(standIn.sent.length, sent);
		// A run it holds goes on.
		assert.deepEqual(await native.dispatch(wire({ runId: "run-0", tool: "list_apps", arguments: {} })), DONE);
	});
});
