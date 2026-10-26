/**
 * A client for the native-app tools of a Cua VM, through spacesd's own `/mcp`
 * (docs/cua-native-mcp.md): the cua-driver tool registry spacesd 0.7.0 links,
 * reached at the origin and with the token the operator set, never at an
 * address, header or method a caller chooses. Only the tools in `TOOLS` can be
 * called, each with arguments its curated schema admits, which are a
 * tightened subset of the pinned upstream schema (./native-mcp-upstream.ts).
 *
 * A run is one agent's run in one space: `openRun` sets up its own MCP session
 * (`initialize`, `notifications/initialized`, `tools/list`, whose schemas it
 * checks against the pins) and derives its `X-Cua-Agent-Session`, so the
 * run's calls share one cua-driver session that no other owner, agent or run
 * shares. Each `invoke` sends exactly one `tools/call` and never retries,
 * re-initializes or replays it. What became of it is the typed `NativeOutcome`:
 * refused before anything was sent, known from a valid answer to that call,
 * or unknown once it may have reached spacesd without such an answer. An
 * unknown outcome latches the run: it sends nothing more.
 *
 * Nothing here ends a driver session (`DELETE /mcp`), signals a process, or
 * fences input; closing a run only stops it sending. Nothing routes to it yet.
 *
 * Importing it does nothing; `createNativeMcp(...)` makes a client.
 */

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
	AGENT_SESSION_HEADER,
	JSON_TYPE,
	MCP_PATH,
	MINTED_SESSION,
	PROTOCOL_VERSION,
	SERVER_INFO,
	SESSION_HEADER,
	UPSTREAM_TOOLS,
	deepFreeze,
} from "./native-mcp-upstream.ts";

/** The fetch the client sends with: Node's own in use, a stand-in in tests. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type NativeMcpLimits = {
	/** How long each setup request (and its body) may take. */
	readonly setupMs: number;
	/** How long a `tools/call` may take, from handing it to `fetch` to the end of its answer. */
	readonly callMs: number;
	/** The largest setup answer read; `tools/list` describes the daemon's whole registry. */
	readonly maxSetupBytes: number;
	/** The largest `tools/call` answer read. */
	readonly maxResponseBytes: number;
	/** The UTF-8 bytes of text a result keeps, all text items together. */
	readonly maxTextBytes: number;
	readonly maxImages: number;
	/** Decoded bytes of one image. */
	readonly maxImageBytes: number;
	/** Pixels on either side of one image, and in all. */
	readonly maxImageSide: number;
	readonly maxImagePixels: number;
};

export const DEFAULT_LIMITS: NativeMcpLimits = {
	setupMs: 10_000,
	callMs: 60_000,
	maxSetupBytes: 4 * 1024 * 1024,
	maxResponseBytes: 16 * 1024 * 1024,
	maxTextBytes: 256 * 1024,
	maxImages: 4,
	maxImageBytes: 8 * 1024 * 1024,
	maxImageSide: 4096,
	maxImagePixels: 4096 * 4096,
};

export type NativeMcpOptions = {
	/** spacesd's origin, as the operator set it: `http(s)://host:port`, https unless the host is loopback. */
	readonly origin: string;
	/** spacesd's bearer token. It is sent only to `origin`, and appears in no outcome or error. */
	readonly token: string;
	/** The space whose VM this is; every run must be its. */
	readonly owner: string;
	readonly fetch: Fetch;
	readonly limits?: Partial<NativeMcpLimits>;
};

/** Who a run is, from Pim's own records (the space, the agent, its run), never from a model. */
export type TrustedRun = { readonly owner: string; readonly agentId: string; readonly runId: string };

/** One call: the run's identity again, the call's own ID (unique in the run), and the tool with its arguments. */
export type NativeCall = TrustedRun & { readonly callId: string; readonly tool: string; readonly arguments: unknown };

export type NativeContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly mimeType: "image/png" | "image/jpeg"; readonly data: string; readonly width: number; readonly height: number };

/** Something of a known result the client didn't pass on as it came; the call's outcome stands regardless. */
export type PresentationIssue = {
	readonly kind: "text_truncated" | "image_omitted" | "content_omitted" | "content_malformed" | "is_error_malformed";
	/** The item of `content` it is about, when it is about one. */
	readonly index?: number;
};

export type RejectReason =
	/** The caller's signal was aborted before sending. */
	| "aborted"
	/** The run was closed. */
	| "closed"
	/** An earlier call of the run has an unknown outcome. */
	| "uncertain"
	/** Another call of the run is in flight. */
	| "busy"
	/** The call's owner, agent or run isn't the run's. */
	| "identity"
	/** The call ID was used before in this run. */
	| "call_reused"
	/** The tool isn't curated. */
	| "unknown_tool"
	/** The arguments aren't admitted by the tool's curated schema. */
	| "invalid_arguments";

export type UnknownReason =
	| "timeout"
	| "aborted"
	/** `fetch` threw, or the answer's body failed while it was read. */
	| "transport"
	| "http_status"
	| "content_type"
	/** The answer named another MCP session. */
	| "session_mismatch"
	| "oversized"
	/** The body wasn't one JSON-RPC response object. */
	| "malformed"
	/** The response answered another request ID. */
	| "id_mismatch";

export type NativeOutcome =
	/** Nothing was sent. */
	| { readonly status: "rejected"; readonly reason: RejectReason }
	/**
	 * spacesd answered this call with a result. `isError` is the tool's own
	 * error or refusal (`code` is its `structuredContent.code`, when it has a
	 * plain one), which is final and not an invitation to retry.
	 */
	| {
			readonly status: "completed";
			readonly isError: boolean;
			readonly code: string | null;
			readonly content: readonly NativeContent[];
			readonly presentation: readonly PresentationIssue[];
	  }
	/** spacesd answered this call with a JSON-RPC error; at the pinned commit it answers `tools/call` so only before the tool runs. */
	| { readonly status: "rpc_error"; readonly code: number }
	/** The call may have reached spacesd and run; nothing says whether it did. */
	| { readonly status: "unknown"; readonly reason: UnknownReason };

/**
 * What an outcome means for `DispatchTrace` (src/computer-control-runtime.ts)
 * once a later change carries it through `Computer.call`: whether something
 * was sent, and whether it may have run without an answer saying so.
 */
export function dispatchEffect(outcome: NativeOutcome): { readonly sent: boolean; readonly uncertain: boolean } {
	return { sent: outcome.status !== "rejected", uncertain: outcome.status === "unknown" };
}

/** Why a run couldn't be set up. Nothing was called; only setup requests may have been sent. */
export class NativeMcpSetupError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`The Cua VM's native-app tools could not be set up (${reason}).`);
		this.reason = reason;
	}
}

function fail(reason: string): never {
	throw new NativeMcpSetupError(reason);
}

export type RunState = "ready" | "busy" | "uncertain" | "closed";

export interface NativeRun {
	readonly run: TrustedRun;
	/** The `X-Cua-Agent-Session` its calls carry. */
	readonly agentSession: string;
	readonly state: RunState;
	invoke(call: NativeCall, signal?: AbortSignal): Promise<NativeOutcome>;
	/** Sends nothing: the run stops sending, and a call in flight goes on to its outcome. */
	close(): void;
}

export interface NativeMcp {
	/** Sets up a run's MCP session. A run that was set up is never set up again by this client. */
	openRun(run: TrustedRun, signal?: AbortSignal): Promise<NativeRun>;
}

// ---------------------------------------------------------------- the curated tools

type Text = { readonly maxLength: number; readonly pattern?: RegExp; readonly enum?: readonly string[] };
type Field =
	| { readonly type: "integer" | "number"; readonly minimum: number; readonly maximum: number }
	| { readonly type: "boolean" }
	| ({ readonly type: "string" } & Text)
	| { readonly type: "array"; readonly items: Text; readonly minItems: number; readonly maxItems: number };
type Tool = { readonly required: readonly string[]; readonly properties: Readonly<Record<string, Field>> };

/** Linux's highest possible PID (`PID_MAX_LIMIT`), and an X11 window ID's range. */
const pid: Field = { type: "integer", minimum: 1, maximum: 4_194_304 };
const windowId: Field = { type: "integer", minimum: 0, maximum: 0xffff_ffff };
const pixel: Field = { type: "number", minimum: 0, maximum: 16_384 };
const printable = /^[\x20-\x7e]+$/;
const elementToken: Field = { type: "string", maxLength: 32, pattern: /^s[0-9a-f]{8}:[0-9]{1,6}$/ };
const deliveryMode: Field = { type: "string", maxLength: 16, enum: ["background", "foreground"] };
const keyName: Text = { maxLength: 32, pattern: printable };
/** Where a pointer or key action goes: a window of a process, by pixel or by element. */
const target = { pid, window_id: windowId, element_token: elementToken, x: pixel, y: pixel, delivery_mode: deliveryMode } as const;

/**
 * The tools a caller may name, with the arguments each admits. Every field is
 * one of the pinned upstream schema, typed alike and bounded more tightly;
 * whatever isn't here (`session`, `scope`, `cursor_id`, `screenshot_out_file`
 * and the rest, docs/cua-native-mcp.md) is refused. Pointer and key actions
 * need a `pid`, so they go to a window, never to the desktop at large.
 */
export const TOOLS: Readonly<Record<string, Tool>> = deepFreeze({
	list_apps: { required: [], properties: {} },
	list_windows: {
		required: [],
		properties: { pid, app: { type: "string", maxLength: 256 }, on_screen_only: { type: "boolean" } },
	},
	get_window_state: {
		required: ["pid"],
		properties: {
			pid,
			window_id: windowId,
			include_accessibility_tree: { type: "boolean" },
			include_screenshot: { type: "boolean" },
			query: { type: "string", maxLength: 256 },
			max_elements: { type: "integer", minimum: 1, maximum: 5000 },
			max_depth: { type: "integer", minimum: 1, maximum: 256 },
			timeout_ms: { type: "integer", minimum: 100, maximum: 30_000 },
			tree_format: { type: "string", maxLength: 16, enum: ["markdown", "elements", "both"] },
			since: { type: "string", maxLength: 16, pattern: /^(latest|s[0-9a-f]{8})$/ },
		},
	},
	bring_to_front: { required: ["pid"], properties: { pid, window_id: windowId } },
	click: {
		required: ["pid"],
		properties: {
			...target,
			button: { type: "string", maxLength: 8, enum: ["left", "right", "middle"] },
			count: { type: "integer", minimum: 1, maximum: 3 },
		},
	},
	type_text: { required: ["pid", "text"], properties: { ...target, text: { type: "string", maxLength: 4096 } } },
	press_key: {
		required: ["pid", "key"],
		properties: {
			...target,
			key: { type: "string", ...keyName },
			modifiers: { type: "array", items: { maxLength: 8, enum: ["ctrl", "shift", "alt", "super"] }, minItems: 0, maxItems: 4 },
		},
	},
	hotkey: { required: ["pid", "keys"], properties: { ...target, keys: { type: "array", items: keyName, minItems: 2, maxItems: 5 } } },
	scroll: {
		required: ["pid", "direction"],
		properties: {
			...target,
			direction: { type: "string", maxLength: 8, enum: ["up", "down", "left", "right"] },
			by: { type: "string", maxLength: 8, enum: ["line", "page"] },
			amount: { type: "integer", minimum: 1, maximum: 50 },
		},
	},
});

const MAX_KEYS = 16;
const MAX_ITEMS = 16;

/**
 * A copy of `value` made of plain JSON data, each property read once and none
 * through a getter, or undefined when it holds anything else or nests deeper
 * than `depth`. What is validated and sent is this copy, so the caller's
 * object changing afterwards changes nothing.
 */
function plainCopy(value: unknown, depth: number): unknown {
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "object" || value === null || depth === 0) return undefined;
	if (Array.isArray(value)) {
		if (value.length > MAX_ITEMS) return undefined;
		const items: unknown[] = [];
		for (let i = 0; i < value.length; i++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, i);
			const item = descriptor && "value" in descriptor ? plainCopy(descriptor.value, depth - 1) : undefined;
			if (item === undefined) return undefined;
			items.push(item);
		}
		return items;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return undefined;
	if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Object.keys(descriptors);
	if (keys.length > MAX_KEYS) return undefined;
	const copy: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
		const item = plainCopy(descriptor.value, depth - 1);
		if (item === undefined) return undefined;
		Object.defineProperty(copy, key, { value: item, enumerable: true, writable: false });
	}
	return copy;
}

function admitsText(rule: Text, value: unknown): boolean {
	return (
		typeof value === "string" &&
		value.length <= rule.maxLength &&
		(rule.enum === undefined || rule.enum.includes(value)) &&
		(rule.pattern === undefined || rule.pattern.test(value))
	);
}

function admits(field: Field, value: unknown): boolean {
	switch (field.type) {
		case "integer":
			return Number.isSafeInteger(value) && (value as number) >= field.minimum && (value as number) <= field.maximum;
		case "number":
			return typeof value === "number" && value >= field.minimum && value <= field.maximum;
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return admitsText(field, value);
		case "array":
			return Array.isArray(value) && value.length >= field.minItems && value.length <= field.maxItems && value.every((item) => admitsText(field.items, item));
	}
}

/** The call's arguments as they will be sent, or undefined when the tool's curated schema doesn't admit them. */
function curatedArguments(tool: Tool, raw: unknown): Record<string, unknown> | undefined {
	const copy = plainCopy(raw, 3);
	if (typeof copy !== "object" || copy === null || Array.isArray(copy)) return undefined;
	const args = copy as Record<string, unknown>;
	for (const [name, value] of Object.entries(args)) {
		const field = Object.hasOwn(tool.properties, name) ? tool.properties[name] : undefined;
		if (!field || !admits(field, value)) return undefined;
	}
	return tool.required.every((name) => Object.hasOwn(args, name)) ? args : undefined;
}

// ---------------------------------------------------------------- identity

const IDENTITY = /^[\x21-\x7e]{1,256}$/;

function validRun(run: TrustedRun): boolean {
	return [run.owner, run.agentId, run.runId].every((part) => typeof part === "string" && IDENTITY.test(part));
}

/**
 * The run's `X-Cua-Agent-Session`: derived from its owner, agent and run (each
 * length-prefixed, so no two triples share an encoding), 44 characters that
 * spacesd accepts as an agent session. Stable for a run, and different for
 * every other run, agent or owner unless SHA-256 collides in 160 bits.
 */
export function agentSessionOf(run: TrustedRun): string {
	const hash = createHash("sha256");
	for (const part of ["pim-cua-native-mcp/1", run.owner, run.agentId, run.runId]) hash.update(`${Buffer.byteLength(part)}:${part}`);
	return `pim-${hash.digest("hex").slice(0, 40)}`;
}

// ---------------------------------------------------------------- the transport

type Exchange =
	| { readonly ok: true; readonly status: number; readonly type: string | null; readonly session: string | null; readonly body: Uint8Array }
	| { readonly ok: false; readonly reason: UnknownReason };

/** Reads a body up to `max` bytes; past it, or on the signal, it cancels the body. */
async function readBounded(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array | "oversized" | "transport" | "aborted"> {
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const cancel = () => void reader.cancel().catch(() => {});
	signal.addEventListener("abort", cancel, { once: true });
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			if (signal.aborted) return "aborted";
			let next: ReadableStreamReadResult<Uint8Array>;
			try {
				next = await reader.read();
			} catch {
				return signal.aborted ? "aborted" : "transport";
			}
			// A read the signal cancelled ends like a body that ended; it isn't one.
			if (signal.aborted) return "aborted";
			if (next.done) break;
			size += next.value.byteLength;
			if (size > max) {
				cancel();
				return "oversized";
			}
			parts.push(next.value);
		}
	} finally {
		signal.removeEventListener("abort", cancel);
	}
	return Buffer.concat(parts);
}

type Envelope = { readonly result: Record<string, unknown> } | { readonly error: number } | "malformed" | "id_mismatch";

/** One JSON-RPC response object answering request `id`, as spacesd's `Response` serializes one. */
function envelope(body: Uint8Array, id: string): Envelope {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		return "malformed";
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "malformed";
	const response = value as Record<string, unknown>;
	if (!Object.keys(response).every((key) => ["jsonrpc", "id", "result", "error"].includes(key))) return "malformed";
	if (response.jsonrpc !== "2.0" || ("result" in response) === ("error" in response)) return "malformed";
	if (response.id !== id) return typeof response.id === "string" || typeof response.id === "number" || response.id === null ? "id_mismatch" : "malformed";
	if ("error" in response) {
		const error = response.error as { code?: unknown; message?: unknown } | null;
		if (typeof error !== "object" || error === null || !Number.isSafeInteger(error.code) || typeof error.message !== "string") return "malformed";
		return { error: error.code as number };
	}
	const result = response.result;
	if (typeof result !== "object" || result === null || Array.isArray(result)) return "malformed";
	return { result: result as Record<string, unknown> };
}

// ---------------------------------------------------------------- results

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An image's size from its own header: PNG's `IHDR`, or JPEG's first start-of-frame. */
function imageSize(bytes: Buffer, mimeType: "image/png" | "image/jpeg"): { width: number; height: number } | null {
	if (mimeType === "image/png") {
		if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let at = 2;
	while (at + 4 <= bytes.length) {
		if (bytes[at] !== 0xff) return null;
		const marker = bytes[at + 1] as number;
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return null;
		const length = bytes.readUInt16BE(at + 2);
		if (length < 2) return null;
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (at + 9 > bytes.length) return null;
			return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
		}
		at += 2 + length;
	}
	return null;
}

function image(item: Record<string, unknown>, limits: NativeMcpLimits): NativeContent | null {
	const { mimeType, data } = item;
	if (mimeType !== "image/png" && mimeType !== "image/jpeg") return null;
	if (typeof data !== "string" || data.length === 0 || data.length > Math.ceil(limits.maxImageBytes / 3) * 4 || !BASE64.test(data)) return null;
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > limits.maxImageBytes) return null;
	const size = imageSize(bytes, mimeType);
	if (!size || size.width < 1 || size.height < 1) return null;
	if (size.width > limits.maxImageSide || size.height > limits.maxImageSide || size.width * size.height > limits.maxImagePixels) return null;
	return { type: "image", mimeType, data, ...size };
}

/** The UTF-8 prefix of `text` of at most `bytes` bytes, cut between characters. */
function utf8Prefix(text: string, bytes: number): string {
	let used = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char);
		if (used + size > bytes) break;
		used += size;
		end += char.length;
	}
	return text.slice(0, end);
}

/** A result as the caller gets it: what a known outcome carries, with what was left out of it said, not hidden. */
function present(result: Record<string, unknown>, limits: NativeMcpLimits): NativeOutcome {
	const presentation: PresentationIssue[] = [];
	let isError = false;
	if (result.isError !== undefined) {
		if (typeof result.isError === "boolean") isError = result.isError;
		else {
			// Neither success nor error is said plainly, so it isn't taken as success.
			isError = true;
			presentation.push({ kind: "is_error_malformed" });
		}
	}
	const structured = result.structuredContent as { code?: unknown } | null | undefined;
	const code = isError && typeof structured === "object" && structured !== null && typeof structured.code === "string" && CODE.test(structured.code) ? structured.code : null;
	const content: NativeContent[] = [];
	const items = Array.isArray(result.content) ? result.content : [];
	if (!Array.isArray(result.content)) presentation.push({ kind: "content_malformed" });
	let textLeft = limits.maxTextBytes;
	let images = 0;
	items.forEach((raw: unknown, index) => {
		const item = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
		if (item.type === "text" && typeof item.text === "string") {
			const text = utf8Prefix(item.text, textLeft);
			textLeft -= Buffer.byteLength(text);
			if (text.length < item.text.length) presentation.push({ kind: "text_truncated", index });
			if (text.length > 0) content.push({ type: "text", text });
		} else if (item.type === "image") {
			const checked = images < limits.maxImages ? image(item, limits) : null;
			if (checked) {
				images += 1;
				content.push(checked);
			} else presentation.push({ kind: "image_omitted", index });
		} else presentation.push({ kind: "content_omitted", index });
	});
	return { status: "completed", isError, code, content, presentation };
}

// ---------------------------------------------------------------- the client

function checkedOrigin(origin: string): string {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error("The spacesd origin is not a URL.");
	}
	const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.origin !== origin) {
		throw new Error("The spacesd origin must be exactly https://host[:port], or http:// on a loopback host.");
	}
	return origin;
}

/** Canonical JSON (keys sorted), for comparing schemas and hashing the pins. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Whether `tools/list` advertises every curated tool with the pinned schema; returns the first mismatch's name. */
function mismatchedTool(result: Record<string, unknown>): string | null {
	const tools = Array.isArray(result.tools) ? (result.tools as unknown[]) : [];
	for (const [name, pinned] of Object.entries(UPSTREAM_TOOLS)) {
		const found = tools.filter((tool) => typeof tool === "object" && tool !== null && (tool as { name?: unknown }).name === name);
		const schema = found.length === 1 ? (found[0] as { inputSchema?: unknown }).inputSchema : undefined;
		if (typeof schema !== "object" || schema === null) return name;
		const { type, required = [], properties, additionalProperties } = schema as Record<string, unknown>;
		if (type !== "object" || additionalProperties !== false || typeof properties !== "object" || properties === null) return name;
		if (canonical([...(required as string[])].sort()) !== canonical([...pinned.required].sort())) return name;
		for (const [property, shape] of Object.entries(pinned.properties)) {
			const advertised = (properties as Record<string, unknown>)[property];
			if (typeof advertised !== "object" || advertised === null) return name;
			const { description: _, ...rest } = advertised as Record<string, unknown>;
			if (canonical(rest) !== canonical(shape)) return name;
		}
	}
	return null;
}

export function createNativeMcp(options: NativeMcpOptions): NativeMcp {
	const url = `${checkedOrigin(options.origin)}${MCP_PATH}`;
	if (typeof options.token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(options.token)) throw new Error("The spacesd token is not a usable bearer token.");
	if (typeof options.owner !== "string" || !IDENTITY.test(options.owner)) throw new Error("The owner is not a usable identity.");
	const { token, owner, fetch } = options;
	const limits: NativeMcpLimits = { ...DEFAULT_LIMITS, ...options.limits };
	/** Every run ever opened here, so none is set up twice. */
	const opened = new Set<string>();

	/**
	 * One POST to `/mcp`, bounded by `ms` and the caller's signal. Calling
	 * `fetch` is the commit point: from then on the request may have reached
	 * spacesd, and even run there, whatever `fetch` does next, so every failure
	 * after it is an unknown reason, never a refusal. When the bound or the
	 * signal ends the wait first, the client stops waiting at once, and an
	 * answer that comes later is discarded unread.
	 */
	async function post(body: string, headers: Record<string, string>, ms: number, max: number, signal: AbortSignal | undefined): Promise<Exchange> {
		// Only setup can get here aborted (between its requests); `invoke` checks right before, with nothing awaited between.
		if (signal?.aborted) return { ok: false, reason: "aborted" };
		const controller = new AbortController();
		let reason: "timeout" | "aborted" | null = null;
		const stop = (why: "timeout" | "aborted") => {
			reason ??= why;
			controller.abort();
		};
		const stopped = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
		const timer = setTimeout(() => stop("timeout"), ms);
		const onAbort = () => stop("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			let pending: Promise<Response>;
			try {
				pending = fetch(url, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": JSON_TYPE, accept: JSON_TYPE, ...headers },
					body,
					redirect: "manual",
					signal: controller.signal,
				});
			} catch {
				return { ok: false, reason: "transport" };
			}
			let response: Response | null;
			try {
				response = await Promise.race([pending, stopped]);
			} catch {
				return { ok: false, reason: reason ?? "transport" };
			}
			if (!response || reason) {
				pending.then((late) => void late.body?.cancel().catch(() => {}), () => {});
				return { ok: false, reason: reason ?? "aborted" };
			}
			const read = await readBounded(response, max, controller.signal);
			if (typeof read === "string") return { ok: false, reason: read === "aborted" ? (reason ?? "aborted") : read };
			return { ok: true, status: response.status, type: response.headers.get("content-type"), session: response.headers.get(SESSION_HEADER), body: read };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** A JSON-RPC request's answer: status 200, JSON, the session expected (when one is), and one response to `id`. */
	function answer(exchange: Exchange, id: string, session: string | null): Envelope | UnknownReason {
		if (!exchange.ok) return exchange.reason;
		if (exchange.status !== 200) return "http_status";
		if (exchange.type !== JSON_TYPE) return "content_type";
		if (session !== null && exchange.session !== session) return "session_mismatch";
		return envelope(exchange.body, id);
	}

	/** The run's MCP session: `initialize`, `notifications/initialized` and `tools/list`, and nothing else. */
	async function setUp(agentSession: string, signal: AbortSignal | undefined): Promise<string> {
		const request = async (method: string, params: unknown, session: string | null) => {
			const id = `pim-${randomUUID()}`;
			const headers: Record<string, string> = { [AGENT_SESSION_HEADER]: agentSession };
			if (session) Object.assign(headers, { [SESSION_HEADER]: session, "mcp-protocol-version": PROTOCOL_VERSION });
			const exchange = await post(JSON.stringify({ jsonrpc: "2.0", id, method, params }), headers, limits.setupMs, limits.maxSetupBytes, signal);
			const answered = answer(exchange, id, session);
			if (typeof answered === "string") return fail(`${method}: ${answered}`);
			if (!("result" in answered)) return fail(`${method}: rpc_error`);
			return { result: answered.result, session: exchange.ok ? exchange.session : null };
		};

		if (signal?.aborted) fail("aborted");
		const init = await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pim-cua-host", version: "0.1.0" } }, null);
		const session = init.session;
		if (!session || !MINTED_SESSION.test(session)) return fail("initialize: session");
		const info = init.result.serverInfo as Record<string, unknown> | undefined;
		if (init.result.protocolVersion !== PROTOCOL_VERSION || info?.name !== SERVER_INFO.name || info?.version !== SERVER_INFO.version) fail("initialize: version");

		// A notification gets no response: spacesd answers `202` with no body.
		const notified = await post(
			JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			{ [AGENT_SESSION_HEADER]: agentSession, [SESSION_HEADER]: session, "mcp-protocol-version": PROTOCOL_VERSION },
			limits.setupMs,
			1024,
			signal,
		);
		if (!notified.ok) fail(`notifications/initialized: ${notified.reason}`);
		if (notified.status !== 202 || notified.body.byteLength > 0) fail("notifications/initialized: http_status");

		const listed = await request("tools/list", {}, session);
		const mismatch = mismatchedTool(listed.result);
		if (mismatch) fail(`tools/list: ${mismatch}`);
		return session;
	}

	return {
		async openRun(run, signal) {
			if (!validRun(run)) throw new NativeMcpSetupError("identity");
			if (run.owner !== owner) throw new NativeMcpSetupError("owner");
			const frozen: TrustedRun = Object.freeze({ owner: run.owner, agentId: run.agentId, runId: run.runId });
			const agentSession = agentSessionOf(frozen);
			if (opened.has(agentSession)) throw new NativeMcpSetupError("reopened");
			opened.add(agentSession);
			try {
				return openedRun(frozen, agentSession, await setUp(agentSession, signal));
			} catch (error) {
				// Setup calls no tool, so a run whose setup failed may be set up again.
				opened.delete(agentSession);
				throw error;
			}
		},
	};

	function openedRun(run: TrustedRun, agentSession: string, session: string): NativeRun {
		let state: RunState = "ready";
		const calls = new Set<string>();
		const headers = { [AGENT_SESSION_HEADER]: agentSession, [SESSION_HEADER]: session, "mcp-protocol-version": PROTOCOL_VERSION };

		async function invoke(call: NativeCall, signal?: AbortSignal): Promise<NativeOutcome> {
			const rejected = (reason: RejectReason): NativeOutcome => ({ status: "rejected", reason });
			if (state === "closed") return rejected("closed");
			if (state === "uncertain") return rejected("uncertain");
			if (typeof call !== "object" || call === null) return rejected("identity");
			const { owner: callOwner, agentId, runId, callId, tool: name } = call;
			if (callOwner !== run.owner || agentId !== run.agentId || runId !== run.runId) return rejected("identity");
			if (typeof callId !== "string" || !IDENTITY.test(callId)) return rejected("identity");
			if (calls.has(callId)) return rejected("call_reused");
			calls.add(callId);
			if (state === "busy") return rejected("busy");
			const tool = typeof name === "string" && Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
			if (!tool) return rejected("unknown_tool");
			const args = curatedArguments(tool, call.arguments);
			if (!args) return rejected("invalid_arguments");
			if (signal?.aborted) return rejected("aborted");
			const id = `pim-${randomUUID()}`;
			// Serialized now, before anything is awaited: this is exactly what is sent.
			const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

			state = "busy";
			let outcome: NativeOutcome;
			try {
				const answered = answer(await post(body, headers, limits.callMs, limits.maxResponseBytes, signal), id, session);
				if (typeof answered === "string") outcome = { status: "unknown", reason: answered };
				else if ("error" in answered) outcome = { status: "rpc_error", code: answered.error };
				else outcome = present(answered.result, limits);
			} catch {
				// Nothing above is meant to throw; if something does, the call may still have been sent.
				outcome = { status: "unknown", reason: "transport" };
			}
			if (outcome.status === "unknown") state = "uncertain";
			else if (state === "busy") state = "ready";
			return outcome;
		}

		return {
			run,
			agentSession,
			get state() {
				return state;
			},
			invoke,
			close() {
				if (state !== "uncertain") state = "closed";
			},
		};
	}
}
