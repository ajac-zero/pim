/**
 * What a model request looked like to the provider's prompt cache, without any of its content. A provider reuses a cached prompt only up to the first byte that differs from an earlier
 * request, and Anthropic writes only where a request puts a cache breakpoint, so "why was the whole history written again" is answered by comparing consecutive requests: which section
 * changed first (tools, system, settings, or which message), and whether the breakpoint an earlier request wrote still lies on the later one.
 *
 * The trace is taken from the request body as the provider's adapter finally built it (`onPayload`), after every Pim transformation. It holds only keyed hashes, counts and role letters:
 *
 * - Every hash is an HMAC-SHA256 under a key derived from the deployment's `PIM_INGRESS_SECRET` and the owner, so a hash cannot be tested against a guessed prompt and two owners' hashes
 *   never match. With no secret the key is random per process: traces from before a restart or from another process are not comparable, and `key` says which key made a trace.
 * - What is hashed is the JSON of each part with every `cache_control` property removed, at any depth: the marker moves from one request to the next on purpose, and the same content with the
 *   marker moved is the same prefix. Key order is the adapter's, which is fixed for one release.
 * - `tools`, `system`, `messages` (the first array among `messages`, `input` and `contents`) and `settings` (every other top-level field except `stream`) are hashed apart. A provider whose system
 *   prompt is a message (OpenAI's chat API) has no `system` hash: its first message is the system prompt. `settingKeys` hashes each setting alone, so the one that changed is named.
 * - `messages` is the list chained: the value after message i is the HMAC of the value after message i - 1 and message i, starting from `head`, the hash of tools and system. `chain` keeps that
 *   value after each message as 4 hex characters (two different prefixes agree at one place with a chance of 1 in 65,536, which a diagnostic accepts), and after every `stride`th message once a
 *   request has more than 1,024 messages, so a trace stays under about 5 KB however long the chat is. Where two requests' chains first differ is where their shared prefix ends, to within `stride`.
 * - `breakpoints` are the cache markers the body carries, in the order the provider reads them (tools, system, messages), each with the hash of everything cached up to and including it.
 * - `tail` is the last four messages hashed one by one, with their roles, to tell a changing end from a changing middle.
 *
 * It costs one more serialization of each message: milliseconds for a context of hundreds of thousands of tokens. It never throws, and nothing in it names content.
 */
import { createHmac, randomBytes } from "node:crypto";

export const CACHE_TRACE_VERSION = 1;
/** Message boundaries kept in `chain` before it is thinned. */
const MAX_BOUNDARIES = 1024;
const MAX_BREAKPOINTS = 8;
const MAX_SETTINGS = 24;
const TAIL = 4;
const CHAIN_HEX = 4;

export type CacheBreakpoint = {
	/** Where the marker sits. */
	in: "tools" | "system" | "messages";
	/** The tool, system block or message it is on (0-based). */
	index: number;
	/** The block of that message it is on. */
	block?: number;
	/** Whether that block ends its message; when it does not, the breakpoint covers only part of the message. */
	last?: boolean;
	/** The hash of everything cached up to and including that block. */
	prefix: string;
};

export type CacheTrace = {
	v: typeof CACHE_TRACE_VERSION;
	/** Which key made the hashes; traces with another key cannot be compared. */
	key: string;
	tools: string | null;
	system: string | null;
	/** Every other field of the body. */
	settings: string;
	settingKeys: Record<string, string>;
	/** Tools and system together: what every message prefix starts from. */
	head: string;
	/** The whole message list, chained. */
	messages: string;
	counts: { tools: number; system: number; messages: number; blocks: number };
	/** The chain is kept after message `stride - 1`, `2 * stride - 1`, and so on. */
	stride: number;
	chain: string;
	breakpoints: CacheBreakpoint[];
	tail: { roles: string; hashes: string[] };
};

const MESSAGE_FIELDS = ["messages", "input", "contents"];
const SYSTEM_FIELDS = ["system", "instructions", "systemInstruction"];

const withoutMarkers = (key: string, value: unknown) => (key === "cache_control" ? undefined : value);
const canonical = (value: unknown) => JSON.stringify(value, withoutMarkers) ?? "";
const marked = (value: unknown): boolean => typeof value === "object" && value !== null && "cache_control" in value;
const roleLetter = (message: unknown) => {
	const role = (message as { role?: unknown } | null)?.role;
	return role === "user" ? "u" : role === "assistant" || role === "model" ? "a" : role === "system" || role === "developer" ? "s" : role === "tool" || role === "toolResult" ? "t" : "o";
};

const EPHEMERAL = randomBytes(32);

/** Makes the trace of one owner's request body; undefined when the body cannot be read. */
export type Fingerprinter = (payload: unknown) => CacheTrace | undefined;

export function createFingerprinter(env: NodeJS.ProcessEnv, ownerId: string): Fingerprinter {
	const secret = env.PIM_INGRESS_SECRET?.trim() ? env.PIM_INGRESS_SECRET : EPHEMERAL;
	const key = createHmac("sha256", secret).update(`pim.cache-trace:${ownerId}`).digest();
	const mac = (data: string) => createHmac("sha256", key).update(data).digest("hex");
	const hash = (data: string) => mac(data).slice(0, 16);
	const keyId = mac("key").slice(0, 8);
	return (payload) => {
		try {
			return trace(payload, hash, keyId);
		} catch {
			return undefined;
		}
	};
}

function trace(payload: unknown, hash: (data: string) => string, key: string): CacheTrace | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const body = payload as Record<string, unknown>;
	const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
	const systemField = SYSTEM_FIELDS.find((field) => body[field] !== undefined);
	const systemValue = systemField ? body[systemField] : undefined;
	const systemBlocks = Array.isArray(systemValue) ? systemValue : systemValue === undefined ? [] : [systemValue];
	const messages = (MESSAGE_FIELDS.map((field) => body[field]).find(Array.isArray) as unknown[] | undefined) ?? [];

	const chainOf = (seed: string, parts: unknown[]) => {
		let value = seed;
		return parts.map((part) => (value = hash(value + hash(canonical(part)))));
	};
	const toolChain = chainOf("tools", tools);
	const toolsHash = toolChain.length > 0 ? toolChain[toolChain.length - 1]! : null;
	const systemChain = chainOf(toolsHash ?? "no tools", systemBlocks);
	const systemHash = hash(canonical(systemValue ?? null));
	const head = hash(`${toolsHash}|${systemBlocks.length > 0 ? systemHash : null}`);

	const full: string[] = [];
	const leaves: string[] = [];
	let value = head;
	let blocks = 0;
	for (const message of messages) {
		const leaf = hash(canonical(message));
		leaves.push(leaf);
		full.push((value = hash(value + leaf)));
		const content = (message as { content?: unknown } | null)?.content;
		blocks += Array.isArray(content) ? content.length : 1;
	}
	let stride = 1;
	while (Math.ceil(messages.length / stride) > MAX_BOUNDARIES) stride *= 2;
	let chain = "";
	for (let i = stride - 1; i < full.length; i += stride) chain += full[i]!.slice(0, CHAIN_HEX);

	const breakpoints: CacheBreakpoint[] = [];
	const add = (point: CacheBreakpoint) => {
		if (breakpoints.length < MAX_BREAKPOINTS) breakpoints.push(point);
	};
	tools.forEach((tool, index) => marked(tool) && add({ in: "tools", index, prefix: toolChain[index]! }));
	systemBlocks.forEach((block, index) => marked(block) && add({ in: "system", index, prefix: systemChain[index]! }));
	messages.forEach((message, index) => {
		const content = (message as { content?: unknown } | null)?.content;
		if (!Array.isArray(content)) return;
		content.forEach((block, at) => {
			if (!marked(block)) return;
			const cut = { ...(message as object), content: content.slice(0, at + 1) };
			add({ in: "messages", index, block: at, last: at === content.length - 1, prefix: hash((index === 0 ? head : full[index - 1]!) + hash(canonical(cut))) });
		});
	});

	const settings = Object.entries(body).filter(([name]) => name !== "stream" && name !== "tools" && !SYSTEM_FIELDS.includes(name) && !MESSAGE_FIELDS.includes(name));
	const settingKeys: Record<string, string> = {};
	for (const [name, setting] of settings.slice(0, MAX_SETTINGS)) settingKeys[name.slice(0, 40)] = hash(canonical(setting)).slice(0, 8);

	return {
		v: CACHE_TRACE_VERSION,
		key,
		tools: toolsHash,
		system: systemBlocks.length > 0 ? systemHash : null,
		settings: hash(settings.map(([name, setting]) => `${name}=${canonical(setting)}`).join("\n")),
		settingKeys,
		head,
		messages: full.length > 0 ? full[full.length - 1]! : head,
		counts: { tools: tools.length, system: systemBlocks.length, messages: messages.length, blocks },
		stride,
		chain,
		breakpoints,
		tail: { roles: messages.slice(-TAIL).map(roleLetter).join(""), hashes: leaves.slice(-TAIL).map((leaf) => leaf.slice(0, 8)) },
	};
}

/** How a later request relates to an earlier one. */
export type CacheComparison =
	| { comparable: false; why: string }
	| {
			comparable: true;
			/**
			 * The first section that differs, in the order a provider reads them. "none": the later request begins with everything the earlier one had, verified. "truncated": it has fewer messages than
			 * the earlier one and agrees with it as far as it goes. "unknown": nothing differs where the traces can tell, but the traces do not reach every message (a long chat's chain is thinned to
			 * every `window`th message, so a change among the last messages may be unseen).
			 */
			firstChange: "tools" | "system" | "messages" | "truncated" | "none" | "unknown";
			/** The settings that differ, by name. */
			settings: string[];
			/** Messages the two requests verifiably share from the start, rounded down to a multiple of `window` (exact when `window` is 1). */
			sharedMessages: number;
			window: number;
			/** How many more messages the later request has. */
			addedMessages: number;
			/**
			 * For each breakpoint of the earlier request: whether the content that led up to it still leads the later request. true: the same tools, system and messages up to it. false: something
			 * before it changed or was removed. null: the traces cannot tell (the checkpoint falls between thinned ones, or the breakpoint is inside a message that the traces hold only whole).
			 * This is about content, not about a cache hit, which also needs the later request to have a breakpoint within 20 blocks after it, the same settings and a cache entry that has not expired.
			 */
			breakpoints: { in: CacheBreakpoint["in"]; index: number; stillThere: boolean | null }[];
	  };

/** The chain value after message `index` (-1: before any message), when the trace kept it. */
const boundary = (trace: CacheTrace, index: number): string | null => {
	if (index < 0) return trace.head;
	if ((index + 1) % trace.stride !== 0) return null;
	const at = (index + 1) / trace.stride - 1;
	return trace.chain.slice(at * CHAIN_HEX, (at + 1) * CHAIN_HEX) || null;
};

/** Whether messages 0..index are the same in both (true), differ or are missing from the later one (false), or the traces cannot say (null). Tools and system are the same. */
function sameThrough(earlier: CacheTrace, later: CacheTrace, index: number): boolean | null {
	if (index >= later.counts.messages || index >= earlier.counts.messages) return false;
	const mine = boundary(earlier, index);
	const theirs = boundary(later, index);
	if (mine === null || theirs === null) return null;
	return index < 0 ? mine === theirs : mine.length === CHAIN_HEX && mine === theirs;
}

export function compareTraces(earlier: CacheTrace, later: CacheTrace): CacheComparison {
	if (earlier.v !== later.v) return { comparable: false, why: "different trace versions" };
	if (earlier.key !== later.key) return { comparable: false, why: "hashed with different keys (no PIM_INGRESS_SECRET is set, so a restart or another process changes the key)" };
	const names = new Set([...Object.keys(earlier.settingKeys), ...Object.keys(later.settingKeys)]);
	const settings = [...names].filter((name) => earlier.settingKeys[name] !== later.settingKeys[name]);
	const window = Math.max(earlier.stride, later.stride);
	const limit = Math.min(earlier.counts.messages, later.counts.messages);
	const sameHead = earlier.head === later.head;
	let shared = 0;
	let diverged = false;
	if (sameHead) {
		for (let end = window; end <= limit; end += window) {
			if (boundary(earlier, end - 1) !== boundary(later, end - 1)) {
				diverged = true;
				break;
			}
			shared = end;
		}
		// Messages of the same count with a different whole differ somewhere, even among the last few.
		if (!diverged && earlier.counts.messages === later.counts.messages && earlier.messages !== later.messages) diverged = true;
		else if (!diverged && earlier.counts.messages === later.counts.messages) shared = limit;
		else if (!diverged && window === 1) shared = limit;
	}
	const firstChange =
		earlier.tools !== later.tools ? "tools"
		: earlier.system !== later.system ? "system"
		: diverged ? "messages"
		: later.counts.messages < earlier.counts.messages ? "truncated"
		: shared === earlier.counts.messages ? "none"
		: "unknown";
	return {
		comparable: true,
		firstChange,
		settings,
		sharedMessages: shared,
		window,
		addedMessages: Math.max(0, later.counts.messages - earlier.counts.messages),
		breakpoints: earlier.breakpoints.map((point) => {
			const gone = (stillThere: boolean | null) => ({ in: point.in, index: point.index, stillThere });
			if (point.in === "tools") return gone(earlier.tools === later.tools);
			if (point.in === "system") return gone(sameHead);
			if (!sameHead) return gone(false);
			// A breakpoint on the last block of a message needs that whole message and all before it; one inside a message needs the messages before it, and the whole message too to be sure of its blocks.
			if (point.last === true) return gone(sameThrough(earlier, later, point.index));
			const before = sameThrough(earlier, later, point.index - 1);
			if (before === false || point.index >= later.counts.messages) return gone(false);
			return gone(sameThrough(earlier, later, point.index) === true ? true : null);
		}),
	};
}
