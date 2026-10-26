/**
 * What became of one native-app call, as it crosses from the Cua VM to the
 * space: the one `NativeOutcome` type, which ./cua-host/native-mcp.ts makes,
 * and `readNativeOutcome`, which the Worker (src/computer.ts) uses to check a
 * reply before trusting it. Both sides import this file and nothing else of
 * each other's, so it imports nothing, and uses nothing but the language
 * itself: it runs in Node and in workerd alike (docs/cua-native-mcp.md).
 *
 * Nothing routes native-app calls yet: `NATIVE_TOOL_OP` names the call they
 * will be, so the space can treat its reply as an outcome, not as an
 * ordinary result.
 */

/**
 * The pim-computer call op reserved for one native-app call. A reply to it is
 * read as a `NativeOutcome` (`Computer.call`); no other op's reply ever is.
 */
export const NATIVE_TOOL_OP = "native_tool";

/** Why a call was refused before anything was sent to spacesd. */
export const REJECT_REASONS = Object.freeze([
	/** The caller's signal was aborted before sending. */
	"aborted",
	/** The run was closed. */
	"closed",
	/** An earlier call of the run has an unknown outcome. */
	"uncertain",
	/** Another call of the run is in flight. */
	"busy",
	/** The call's owner, agent or run isn't the run's. */
	"identity",
	/** The call ID was used before in this run. */
	"call_reused",
	/** The tool isn't curated. */
	"unknown_tool",
	/** The arguments aren't admitted by the tool's curated schema, or couldn't be read. */
	"invalid_arguments",
	/** The caller's signal couldn't be read or listened to. */
	"invalid_signal",
] as const);
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Why a call that may have reached spacesd has no answer saying what became of it. */
export const UNKNOWN_REASONS = Object.freeze([
	"timeout",
	"aborted",
	/** `fetch` threw, or the answer's body failed while it was read. */
	"transport",
	"http_status",
	"content_type",
	/** The answer named another MCP session. */
	"session_mismatch",
	"oversized",
	/** The body wasn't one JSON-RPC response object. */
	"malformed",
	/** The response answered another request ID. */
	"id_mismatch",
] as const);
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

export type NativeContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly mimeType: "image/png" | "image/jpeg"; readonly data: string; readonly width: number; readonly height: number };

/** Kinds of `PresentationIssue` about one item of `content`, which carry its `index`. */
const ITEM_ISSUES = Object.freeze(["text_truncated", "image_omitted", "content_omitted"] as const);
/** Kinds about the result as a whole, which carry nothing else. */
const RESULT_ISSUES = Object.freeze(["content_malformed", "is_error_malformed"] as const);

/**
 * Something of a known result the client didn't pass on as it came; the
 * call's outcome stands regardless. There is at most one per item read, and
 * `items_unread` counts, once, the items past `maxContentItems`.
 */
export type PresentationIssue = {
	readonly kind: (typeof ITEM_ISSUES)[number] | (typeof RESULT_ISSUES)[number] | "items_unread";
	/** The item of `content` it is about, when it is about one. */
	readonly index?: number;
	/** For `items_unread`, how many. */
	readonly count?: number;
};

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
 * What an outcome says of the native call itself: whether it was sent to
 * spacesd, and whether it may have run without an answer saying so. This is
 * not `DispatchTrace` (src/computer-control-runtime.ts), whose `sent` means a
 * message left the space for the computer: the space raises the trace's
 * `uncertain` from it, and lowers nothing (`Computer.call`).
 */
export function dispatchEffect(outcome: NativeOutcome): { readonly sent: boolean; readonly uncertain: boolean } {
	return { sent: outcome.status !== "rejected", uncertain: outcome.status === "unknown" };
}

/** The most characters one message carries through a Cua bridge (`MAX_MESSAGE_CHARS` in ./cua-bridge.ts and src/cua.ts; the tests check they agree). */
export const BRIDGE_MESSAGE_CHARS = 16 * 1024 * 1024;

/**
 * What a reply's envelope may take beside its outcome: pim-computer answers
 * `{"type":"reply","id":"<the space's UUID>","result":<outcome>}`, about 60
 * characters around it. The rest of the reserve is margin.
 */
export const REPLY_RESERVE_CHARS = 4096;

/**
 * The most an outcome may hold on the wire: as many items, images and text
 * as the client's limits may ever keep, and at most `maxOutcomeChars` as
 * JSON, so its reply fits one bridge message whole. `LIMIT_RANGES` in
 * ./cua-host/native-mcp.ts uses these as its ceilings, `maxOutputBytes`
 * included (a UTF-8 byte is at least one UTF-16 character). Past them it isn't
 * read as an outcome.
 */
export const NATIVE_WIRE_LIMITS = Object.freeze({
	maxContentItems: 1024,
	/** One per item read, `items_unread`, and the two about the result as a whole, with one to spare. */
	maxPresentation: 1024 + 4,
	maxImages: 16,
	maxImageSide: 16_384,
	/** UTF-8 bytes of text, all text items together. */
	maxTextBytes: 4 * 1024 * 1024,
	maxOutcomeChars: BRIDGE_MESSAGE_CHARS - REPLY_RESERVE_CHARS,
});

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Whether `text` is strict base64: whole groups of four characters of the
 * standard alphabet, padded with `=` only at the end. It is checked one
 * character at a time, so a long text costs time in proportion, never stack
 * (a regular expression repeating a group can overflow it on a few megabytes).
 * The empty text is base64.
 */
export function isBase64(text: string): boolean {
	const { length } = text;
	if (length % 4 !== 0) return false;
	const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
	for (let i = 0; i < length - padding; i++) {
		const c = text.charCodeAt(i);
		if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f)) return false;
	}
	return true;
}

type Plain = Record<string, unknown>;

/** A plain object whose own keys are exactly `keys`, or null. */
function exactly(value: unknown, keys: readonly string[]): Plain | null {
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
	const own = Object.keys(value);
	if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return null;
	return value as Plain;
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
const count = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** UTF-8 bytes of `text`, as Node's `Buffer.byteLength` counts them: a lone surrogate is the 3 bytes of its replacement. */
function utf8Bytes(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 0x80) bytes += 1;
		else if (unit < 0x800) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			bytes += 4;
			i += 1;
		} else bytes += 3;
	}
	return bytes;
}

function content(value: unknown): NativeContent | null {
	const text = exactly(value, ["type", "text"]);
	if (text) return text.type === "text" && typeof text.text === "string" ? { type: "text", text: text.text } : null;
	const image = exactly(value, ["type", "mimeType", "data", "width", "height"]);
	if (!image || image.type !== "image" || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg")) return null;
	const { data, width, height } = image;
	if (typeof data !== "string" || data.length === 0 || data.length > NATIVE_WIRE_LIMITS.maxOutcomeChars || !isBase64(data)) return null;
	if (!count(width, 1, NATIVE_WIRE_LIMITS.maxImageSide) || !count(height, 1, NATIVE_WIRE_LIMITS.maxImageSide)) return null;
	return { type: "image", mimeType: image.mimeType, data, width, height };
}

function issue(value: unknown): PresentationIssue | null {
	const kind = typeof value === "object" && value !== null ? (value as Plain).kind : undefined;
	if (oneOf(ITEM_ISSUES, kind)) {
		const item = exactly(value, ["kind", "index"]);
		return item && count(item.index, 0, NATIVE_WIRE_LIMITS.maxContentItems - 1) ? { kind, index: item.index } : null;
	}
	if (oneOf(RESULT_ISSUES, kind)) return exactly(value, ["kind"]) ? { kind } : null;
	if (kind === "items_unread") {
		const unread = exactly(value, ["kind", "count"]);
		return unread && count(unread.count, 1, Number.MAX_SAFE_INTEGER) ? { kind, count: unread.count } : null;
	}
	return null;
}

function completed(value: unknown): NativeOutcome | null {
	const result = exactly(value, ["status", "isError", "code", "content", "presentation"]);
	if (!result || typeof result.isError !== "boolean") return null;
	// Only a tool's error has a code.
	if (result.code !== null && !(result.isError && typeof result.code === "string" && CODE.test(result.code))) return null;
	const { content: items, presentation: issues } = result;
	if (!Array.isArray(items) || items.length > NATIVE_WIRE_LIMITS.maxContentItems) return null;
	if (!Array.isArray(issues) || issues.length > NATIVE_WIRE_LIMITS.maxPresentation) return null;
	const kept: NativeContent[] = [];
	let textBytes = 0;
	let images = 0;
	let chars = 0;
	for (const raw of items as unknown[]) {
		const item = content(raw);
		if (!item) return null;
		if (item.type === "text") {
			// A UTF-8 byte is at least one UTF-16 unit, so the length rules out a text too long to count first.
			if (item.text.length > NATIVE_WIRE_LIMITS.maxTextBytes - textBytes) return null;
			textBytes += utf8Bytes(item.text);
			if (textBytes > NATIVE_WIRE_LIMITS.maxTextBytes) return null;
			chars += item.text.length;
		} else {
			if (++images > NATIVE_WIRE_LIMITS.maxImages) return null;
			chars += item.data.length;
		}
		if (chars > NATIVE_WIRE_LIMITS.maxOutcomeChars) return null;
		kept.push(item);
	}
	const listed: PresentationIssue[] = [];
	for (const raw of issues as unknown[]) {
		const each = issue(raw);
		if (!each) return null;
		listed.push(each);
	}
	const outcome: NativeOutcome = { status: "completed", isError: result.isError, code: result.code as string | null, content: kept, presentation: listed };
	return JSON.stringify(outcome).length <= NATIVE_WIRE_LIMITS.maxOutcomeChars ? outcome : null;
}

/**
 * `value`, as parsed from the wire, when it is exactly an outcome the client
 * could have made: one of the four kinds with exactly its fields, each of a
 * known value and within `NATIVE_WIRE_LIMITS`. Null otherwise, never a guess:
 * an extra, missing or unknown field, status or reason is not an outcome.
 * What it returns is a new object of its own, holding only those fields. Its
 * work is bounded by the limits, whatever `value` holds.
 */
export function readNativeOutcome(value: unknown): NativeOutcome | null {
	const status = typeof value === "object" && value !== null ? (value as Plain).status : undefined;
	switch (status) {
		case "rejected": {
			const rejected = exactly(value, ["status", "reason"]);
			return rejected && oneOf(REJECT_REASONS, rejected.reason) ? { status, reason: rejected.reason } : null;
		}
		case "unknown": {
			const unknown = exactly(value, ["status", "reason"]);
			return unknown && oneOf(UNKNOWN_REASONS, unknown.reason) ? { status, reason: unknown.reason } : null;
		}
		case "rpc_error": {
			const error = exactly(value, ["status", "code"]);
			return error && Number.isSafeInteger(error.code) ? { status, code: error.code as number } : null;
		}
		case "completed":
			return completed(value);
		default:
			return null;
	}
}
