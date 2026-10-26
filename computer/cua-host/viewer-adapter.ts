/**
 * The adapter between a browser running Cua's own HTML5 viewer (spacesd
 * 0.7.0, pinned in ./viewer-upstream.ts) and the spacesd that shows one
 * display (docs/cua-viewer-adapter.md). The browser never reaches spacesd:
 * it reaches only this adapter, which serves the viewer's pinned files and
 * answers the few calls that viewer makes to watch one display, view only.
 *
 * For each call the adapter decodes the browser's request strictly, builds
 * a new request of its own for spacesd from only what it allows, and builds
 * a new answer from only what the viewer reads. `OpenMedia` always asks for
 * the configured display, `SESSION_POLICY_VIEW_ONLY` and
 * `GEOMETRY_CONTROL_OBSERVE_ONLY`, with no microphone, QUIC or other channel,
 * whatever the browser asked; a window target or bidirectional geometry is
 * refused before anything is sent. Media sockets are relayed only for this
 * launch's own sessions, and only keyframe requests and frame acks go up
 * them. Presence joins without cursor shapes, which spacesd may compute by
 * moving the real pointer.
 *
 * Each launch is one `ViewerLaunch` (./viewer-lifetime.ts): its own
 * credential, its own spacesd viewer ticket (minted view-only, with no
 * clipboard, files or microphone), and its own deadline, which reconnects
 * and new media tickets never move. Every media relay half and presence
 * stream is handed to the launch, which ends them all at its deadline.
 *
 * Importing it does nothing. `createViewerAdapter(...)` returns handlers
 * the Node host can route to; the host doesn't yet, so no route exists.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { create, type DescMessage, fromBinary, ScalarType, toBinary } from "@bufbuild/protobuf";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { type MonotonicClock, startViewerLaunch, type Timers, type TransportKind, type ViewerLaunch } from "./viewer-lifetime.ts";
import { type Asset, type AssetName, AudioCodec, GeometryControl, loadViewerAssets, MediaCodec, message, SessionPolicy, VIEWER_ASSETS } from "./viewer-upstream.ts";

/** The most bytes of a browser's request body, frame included. The viewer's are well under 200. */
export const MAX_REQUEST_BYTES = 4 * 1024;
/** The most bytes of one answer from spacesd to a unary call. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** The most bytes of one presence event from spacesd. */
export const MAX_PRESENCE_MESSAGE_BYTES = 64 * 1024;
/** The most bytes of one text message on a media socket from spacesd, and of one from the browser. */
export const MAX_MEDIA_CONTROL_BYTES = 64 * 1024;
export const MAX_BROWSER_CONTROL_BYTES = 1024;
/** The most bytes of one video or audio packet from spacesd. */
export const MAX_MEDIA_PACKET_BYTES = 16 * 1024 * 1024;
/** The most bytes a browser's media socket may have queued before the relay ends. */
export const MAX_BROWSER_BUFFERED_BYTES = 32 * 1024 * 1024;
/** Bounds on what the adapter asks of spacesd's encoder. */
export const MAX_FPS = 60;
export const MAX_DIMENSION = 3840;
export const MIN_DIMENSION = 64;
export const MAX_BITRATE_KBPS = 20_000;
/** The longest a media ticket may let new sockets attach, as spacesd allows. */
export const MAX_MEDIA_TICKET_SECONDS = 600;
/** Media sessions one launch may open in all, and presence streams it may hold at once. */
export const MAX_MEDIA_OPENS = 32;
export const MAX_PRESENCE_STREAMS = 2;

/** The one wire subprotocol a media socket speaks. */
export const MEDIA_PROTOCOL = "rcdp.v2";

const GRPC_WEB = "application/grpc-web+proto";
const ENV_AUTHORIZATION = "x-cua-env-authorization";
const ROSTER_SECONDS = 5n;

const Code = {
	InvalidArgument: 3,
	NotFound: 5,
	PermissionDenied: 7,
	ResourceExhausted: 8,
	FailedPrecondition: 9,
	Internal: 13,
	Unavailable: 14,
	Unauthenticated: 16,
} as const;

/** What the adapter says for each gRPC code it answers, whatever spacesd said: no upstream text reaches the browser. */
const CODE_TEXT: Record<number, string> = {
	1: "The call was cancelled.",
	2: "The desktop could not answer.",
	3: "The viewer asked for something this viewer can't show.",
	4: "The desktop took too long to answer.",
	5: "There is no such stream.",
	6: "That already exists.",
	7: "This viewer may only watch the display.",
	8: "This viewer has opened too much.",
	9: "This viewer launch has ended.",
	10: "The call was aborted.",
	11: "The viewer asked for something out of range.",
	12: "The desktop doesn't offer that.",
	13: "The desktop answered in a way this viewer doesn't accept.",
	14: "The desktop can't be reached.",
	15: "The desktop's answer was lost.",
	16: "This viewer link has expired or is not valid.",
};

/** One half of a media relay, as the host's WebSocket gives it. */
export type MediaSocket = {
	readonly send: (data: string | Uint8Array) => void;
	/** Closes the socket with a WebSocket close code. */
	readonly close: (code: number) => void;
	/** Ends the socket at once as a network transport (such as `ws.terminate()`), and nothing else. */
	readonly terminate: () => void;
	/** Bytes queued and not yet sent. */
	readonly bufferedAmount: () => number;
};

/** What the owner of a media socket reports to the adapter: each message, and that the socket has closed (once, with its code if it had one). */
export type MediaEvents = {
	readonly message: (data: string | Uint8Array) => void;
	readonly closed: (code?: number) => void;
};

export type UpstreamOptions = {
	/** Where spacesd's gRPC-Web and `/media` are served, such as `http://127.0.0.1:3211`: an origin, with no path. */
	readonly origin: string;
	/** Sends one request to spacesd. Its `redirect` is `manual`, and a redirect is refused. */
	readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
	/**
	 * Opens a media socket to spacesd at `url`, offering `protocol`, and
	 * resolves once it is open, or rejects (with a `status` property when
	 * the upgrade was answered, such as 401 or 410). `events` receive its
	 * messages and its closure, which must be reported even when it closes
	 * before this resolves.
	 */
	readonly openMedia: (request: { url: string; protocol: string; signal: AbortSignal; events: MediaEvents }) => Promise<MediaSocket>;
};

export type ViewerAdapterOptions = {
	readonly upstream: UpstreamOptions;
	/** The one display every launch shows: a display id, or `primary`. */
	readonly displayId: string;
	readonly clock?: MonotonicClock;
	readonly timers?: Timers;
	/** The wall clock media tickets' expiries are read against; `Date.now` by default. */
	readonly wallClock?: () => number;
};

export type LaunchRequest = {
	/** Whole milliseconds, as for `startViewerLaunch`. */
	readonly lifetimeMs: number;
	/** spacesd's root token, used for this launch's one viewer ticket and not kept. */
	readonly rootToken: string;
	/** The name other presence participants see. */
	readonly displayName?: string;
};

export type LaunchCleanup = {
	/** `CloseMedia` calls the adapter made itself, for sessions it superseded or that its launch left. */
	readonly requested: number;
	/** Those spacesd answered with success: what it said, not that any socket was seen to close. */
	readonly answered: number;
	readonly failed: number;
};

export type LaunchHandle = {
	readonly id: string;
	/** The page to open, with the launch's credential in its fragment. */
	readonly viewerPath: string;
	readonly end: () => void;
	readonly status: () => ReturnType<ViewerLaunch["status"]> & {
		readonly sessions: number;
		/** Presence streams whose closure was asked for and that spacesd's side didn't confirm (their cancel failed); they still count as open. */
		readonly unconfirmed: number;
		readonly cleanup: LaunchCleanup;
	};
};

/** Whether a media upgrade may go ahead, and if so how to finish it. */
export type MediaUpgrade =
	| { readonly status: 400 | 401 | 404 }
	| {
			readonly status: 101;
			readonly protocol: typeof MEDIA_PROTOCOL;
			/**
			 * Finishes the upgrade, once. Everything `media` checked is checked
			 * again first; if it no longer holds, `open` is never called and the
			 * refusal's status is answered, for the host to send instead of
			 * completing the upgrade. Otherwise `open` completes it, wires
			 * `events` to the socket and answers it, and this answers 101.
			 */
			readonly attach: (open: (events: MediaEvents) => MediaSocket) => 101 | 401 | 404;
	  };

export type ViewerAdapter = {
	/** Starts a launch: mints its view-only viewer ticket and answers its page. */
	readonly startLaunch: (request: LaunchRequest) => Promise<LaunchHandle>;
	/** Answers an HTTP request whose target the host has checked is canonical. */
	readonly fetch: (request: Request) => Promise<Response>;
	/** Checks a media upgrade's target and offered subprotocols. */
	readonly media: (target: string, protocols: readonly string[]) => MediaUpgrade;
};

// ------------------------------------------------------------------ schema

type Duration = { seconds: bigint; nanos: number };
type Principal = { id: string; displayName: string; color: string; kind: number };
type AudioEncoding = { codecs: number[]; sampleRateHz: number; channels: number; bitrateKbps: number; fec?: boolean; dtx?: boolean; frameMs: number; expectedLossPercent: number };
type OpenMediaRequest = {
	target?: { target: { case: "displayId"; value: string } | { case: "window" | undefined; value?: unknown } };
	codecs: number[];
	maxFps: number;
	maxDimension: number;
	bitrateKbps: number;
	policy: number;
	geometryControl: number;
	ticketTtl?: Duration;
	preferQuic: boolean;
	audio?: { enabled: boolean; sourceIds: string[]; encoding?: AudioEncoding; uplink?: unknown };
	disableVideo: boolean;
	presenceParticipantId: string;
};
type NegotiatedAudioEncoding = { codec: number; sampleRateHz: number; channels: number; bitrateKbps: number; fec: boolean; dtx: boolean; frameMs: number };
type OpenMediaResponse = {
	mediaSessionId: string;
	ticket: string;
	ticketExpiresAt?: Duration;
	wsPath: string;
	quic?: unknown;
	codec: number;
	maxFps: number;
	maxDimension: number;
	bitrateKbps: number;
	policy: number;
	geometryControl: number;
	geometry?: { frameSize?: { width: number; height: number }; scale: number; logicalBounds?: { x: number; y: number; width: number; height: number }; geometryEpoch: bigint };
	wireVersion: number;
	audio?: { tracks: { trackId: number; source?: { sourceId: string; kind: number; name: string } }[]; encoding?: NegotiatedAudioEncoding; uplink?: { granted: boolean } };
};
type Display = { id: string; name: string; primary: boolean; bounds?: unknown; nativeSize?: unknown; scaleFactor: number; refreshRateHz: number; rotationDegrees: number };
type StreamTarget = { target: { case: "display"; value: Display } | { case: "window" | undefined; value?: unknown }; available: boolean; limitation: string };
type CursorPosition = { displayId: string; window?: unknown; position?: { x: number; y: number }; visible: boolean; shape: number; shapeSource: number };
type Participant = { participantId: string; principal?: Principal; joinedAt?: Duration };
type CursorMoved = { participantId: string; cursor?: CursorPosition; at?: Duration };
type JoinEvent =
	| { case: "joined"; value: { participant?: Participant; roster: { participant?: Participant; cursor?: CursorPosition }[] } }
	| { case: "participantJoined"; value: Participant }
	| { case: "participantLeft"; value: { participantId: string; reason: number } }
	| { case: "cursorMoved"; value: CursorMoved }
	| { case: "cursorBatch"; value: { moves: CursorMoved[]; tick: bigint; at?: Duration } }
	| { case: "cursorShapeChanged"; value: { participantId: string; shape: number; source: number } }
	| { case: "rosterHeartbeat"; value: { participantIds: string[]; at?: Duration } }
	| { case: "keepalive"; value: unknown }
	| { case: undefined; value?: undefined };

const schema = {
	capabilitiesRequest: message("cua.env.v1.GetCapabilitiesRequest"),
	capabilitiesResponse: message("cua.env.v1.GetCapabilitiesResponse"),
	ticketRequest: message("cua.env.v1.CreateViewerTicketRequest"),
	ticketResponse: message("cua.env.v1.CreateViewerTicketResponse"),
	targetsRequest: message("cua.env.v1.ListTargetsRequest"),
	targetsResponse: message("cua.env.v1.ListTargetsResponse"),
	openRequest: message("cua.env.v1.OpenMediaRequest"),
	openResponse: message("cua.env.v1.OpenMediaResponse"),
	preferencesRequest: message("cua.env.v1.SetPreferencesRequest"),
	preferencesResponse: message("cua.env.v1.SetPreferencesResponse"),
	keyframeRequest: message("cua.env.v1.RequestKeyframeRequest"),
	keyframeResponse: message("cua.env.v1.RequestKeyframeResponse"),
	closeRequest: message("cua.env.v1.CloseMediaRequest"),
	closeResponse: message("cua.env.v1.CloseMediaResponse"),
	joinRequest: message("cua.env.v1.JoinRequest"),
	joinResponse: message("cua.env.v1.JoinResponse"),
};

/** The calls a browser may make, by path. Every other path is refused before anything reaches spacesd. */
const METHODS = {
	"/cua.env.v1.SystemService/GetCapabilities": schema.capabilitiesRequest,
	"/cua.env.v1.StreamService/ListTargets": schema.targetsRequest,
	"/cua.env.v1.StreamService/OpenMedia": schema.openRequest,
	"/cua.env.v1.StreamService/SetPreferences": schema.preferencesRequest,
	"/cua.env.v1.StreamService/RequestKeyframe": schema.keyframeRequest,
	"/cua.env.v1.StreamService/CloseMedia": schema.closeRequest,
	"/cua.env.v1.PresenceService/Join": schema.joinRequest,
} as const;
type Method = keyof typeof METHODS;

/** The wire type a singular field of this kind is written with. */
function wireTypeOf(scalar: ScalarType | undefined): WireType {
	switch (scalar) {
		case ScalarType.DOUBLE:
		case ScalarType.FIXED64:
		case ScalarType.SFIXED64:
			return WireType.Bit64;
		case ScalarType.FLOAT:
		case ScalarType.FIXED32:
		case ScalarType.SFIXED32:
			return WireType.Bit32;
		case ScalarType.STRING:
		case ScalarType.BYTES:
			return WireType.LengthDelimited;
		default:
			// Varints, and enums (which have no scalar type).
			return WireType.Varint;
	}
}

/**
 * Whether `bytes` encode `desc` with nothing ambiguous: every field known
 * to the pinned schema and written with its own wire type, every singular
 * field at most once, at most one member of each oneof, and the same of
 * every nested message. Protobuf itself would take the last of repeated
 * fields and members, and keep unknown ones; the adapter refuses them.
 */
function unambiguous(desc: DescMessage, bytes: Uint8Array, depth = 0): boolean {
	if (depth > 8) return false;
	try {
		const reader = new BinaryReader(bytes);
		const seen = new Set<number>();
		const members = new Map<string, number>();
		while (reader.pos < reader.len) {
			const [number, wireType] = reader.tag();
			const field = desc.fields.find((f) => f.number === number);
			if (!field || field.fieldKind === "map") return false;
			if (field.fieldKind !== "list") {
				if (seen.has(number)) return false;
				seen.add(number);
			}
			if (field.oneof) {
				const member = members.get(field.oneof.name);
				if (member !== undefined && member !== number) return false;
				members.set(field.oneof.name, number);
			}
			const nested = field.fieldKind === "message" || (field.fieldKind === "list" && field.listKind === "message") ? field.message : undefined;
			if (nested) {
				if (wireType !== WireType.LengthDelimited || !unambiguous(nested, reader.bytes(), depth + 1)) return false;
				continue;
			}
			const expected = wireTypeOf(field.fieldKind === "scalar" || (field.fieldKind === "list" && field.listKind === "scalar") ? field.scalar : undefined);
			const packed = field.fieldKind === "list" && wireType === WireType.LengthDelimited && expected !== WireType.LengthDelimited;
			if (wireType !== expected && !packed) return false;
			reader.skip(wireType, number);
		}
		return reader.pos === reader.len;
	} catch {
		return false;
	}
}

function decode<T>(desc: DescMessage, bytes: Uint8Array): T | undefined {
	if (!unambiguous(desc, bytes)) return undefined;
	try {
		return fromBinary(desc, bytes) as unknown as T;
	} catch {
		return undefined;
	}
}

/** Decodes an answer from spacesd: pinned and trusted for its shape, never for what it allows. */
function decodeAnswer<T>(desc: DescMessage, bytes: Uint8Array): T | undefined {
	try {
		return fromBinary(desc, bytes) as unknown as T;
	} catch {
		return undefined;
	}
}

const encode = (desc: DescMessage, init: Record<string, unknown>): Uint8Array => toBinary(desc, create(desc, init as never));

// ------------------------------------------------------------------ gRPC-Web

function frame(flag: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(5 + payload.byteLength);
	out[0] = flag;
	new DataView(out.buffer).setUint32(1, payload.byteLength);
	out.set(payload, 5);
	return out;
}

const textEncoder = new TextEncoder();
const okTrailer = frame(0x80, textEncoder.encode("grpc-status: 0\r\n"));

function grpcOk(payload: Uint8Array): Response {
	const body = new Uint8Array(5 + payload.byteLength + okTrailer.byteLength);
	body.set(frame(0, payload));
	body.set(okTrailer, 5 + payload.byteLength);
	return new Response(body, { status: 200, headers: { "content-type": GRPC_WEB, "cache-control": "no-store" } });
}

function grpcError(code: number): Response {
	const text = CODE_TEXT[code] ?? CODE_TEXT[Code.Internal]!;
	return new Response(null, {
		status: 200,
		headers: { "content-type": GRPC_WEB, "cache-control": "no-store", "grpc-status": String(code), "grpc-message": encodeURIComponent(text) },
	});
}

const plain = (status: number): Response =>
	new Response(null, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/** Reads at most `limit` bytes of a body, or answers undefined when there are more. */
async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | undefined> {
	if (!body) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				void reader.cancel().catch(() => {});
				return undefined;
			}
			chunks.push(value);
		}
	} catch {
		return undefined;
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

type Frame = { readonly flag: number; readonly payload: Uint8Array };

/** Splits a whole gRPC-Web body into frames, or undefined when it doesn't divide exactly. */
function frames(body: Uint8Array): Frame[] | undefined {
	const out: Frame[] = [];
	let at = 0;
	while (at < body.byteLength) {
		if (body.byteLength - at < 5) return undefined;
		const length = new DataView(body.buffer, body.byteOffset + at + 1, 4).getUint32(0);
		if (body.byteLength - at - 5 < length) return undefined;
		out.push({ flag: body[at]!, payload: body.subarray(at + 5, at + 5 + length) });
		at += 5 + length;
	}
	return out;
}

/** A trailer frame's `grpc-status`, or undefined when it has none or says it twice. */
function trailerStatus(payload: Uint8Array): number | undefined {
	let status: number | undefined;
	for (const line of new TextDecoder().decode(payload).split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== "grpc-status") continue;
		if (status !== undefined) return undefined;
		const value = line.slice(colon + 1).trim();
		status = /^\d{1,2}$/.test(value) ? Number(value) : undefined;
		if (status === undefined) return undefined;
	}
	return status;
}

const upstreamCode = (status: number): number => (status >= 1 && status <= 16 ? status : Code.Internal);

/**
 * Reads gRPC-Web frames from a body that arrives in chunks of any size,
 * one frame per call, or undefined at its end. It holds at most the chunk
 * being read (the transport's own allocation, never joined to another) and
 * one partial frame, whose header is checked against `limit` before any of
 * its payload is kept, so nothing builds up across chunks.
 */
function frameReader(read: () => Promise<ReadableStreamReadResult<Uint8Array>>, limit: number): () => Promise<Frame | undefined> {
	let chunk: Uint8Array = new Uint8Array(0);
	let at = 0;
	const header = new Uint8Array(5);
	let headerHave = 0;
	let payload: Uint8Array | undefined;
	let payloadHave = 0;
	return async () => {
		for (;;) {
			if (payload && payloadHave === payload.byteLength) {
				const out = { flag: header[0]!, payload };
				headerHave = 0;
				payload = undefined;
				return out;
			}
			if (at === chunk.byteLength) {
				const { done, value } = await read();
				if (done) {
					if (headerHave === 0) return undefined;
					throw new Error("A frame was cut short.");
				}
				chunk = value;
				at = 0;
				continue;
			}
			if (headerHave < 5) {
				const n = Math.min(5 - headerHave, chunk.byteLength - at);
				header.set(chunk.subarray(at, at + n), headerHave);
				headerHave += n;
				at += n;
				if (headerHave === 5) {
					const length = new DataView(header.buffer).getUint32(1);
					if (length > limit) throw new Error("A frame is over the bound.");
					payload = new Uint8Array(length);
					payloadHave = 0;
				}
				continue;
			}
			const n = Math.min(payload!.byteLength - payloadHave, chunk.byteLength - at);
			payload!.set(chunk.subarray(at, at + n), payloadHave);
			payloadHave += n;
			at += n;
		}
	};
}

// ------------------------------------------------------------------ helpers

const token = (bytes: number): string => randomBytes(bytes).toString("base64url");
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** spacesd's own percent-encoding of a media ticket in `ws_path`: everything but unreserved characters. */
function percentEncode(value: string): string {
	let out = "";
	for (const byte of Buffer.from(value, "utf8")) {
		const char = String.fromCharCode(byte);
		out += /[A-Za-z0-9\-_.~]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TICKET = /^[\x21-\x7e]{1,4096}$/;
const DISPLAY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LAUNCH_ID = "[A-Za-z0-9_-]{22}";
const ATTACH_TOKEN = "[A-Za-z0-9_-]{43}";
const timestampMs = (t: Duration | undefined): number => (t ? Number(t.seconds) * 1000 + Math.floor(t.nanos / 1e6) : Number.NaN);

/**
 * Hands one transport to a launch through `adopt`, and reports its closure
 * whenever it comes: before `adopt` was called, from inside it (a transport
 * the launch refuses is closed at once, and may say so at once), or after.
 */
function owner(launch: ViewerLaunch, kind: TransportKind) {
	let adoption: { closed: () => void } | undefined;
	let closedEarly = false;
	return {
		closed: (): void => {
			if (adoption) adoption.closed();
			else closedEarly = true;
		},
		adopt: (close: () => void): boolean => {
			const taken = launch.adopt(kind, { close });
			adoption = taken;
			if (closedEarly) taken.closed();
			return taken.admitted;
		},
	};
}

// ------------------------------------------------------------------ launches

/** A media relay: both halves of one browser's socket to one session. */
type Relay = { readonly end: (code?: number) => void };

type Session = {
	readonly id: string;
	readonly upstreamPath: string;
	readonly expiresAtMs: number;
	readonly attachHash: string;
	open: boolean;
	relay: Relay | undefined;
};

type LaunchState = {
	readonly id: string;
	readonly credential: Buffer;
	readonly lifetime: ViewerLaunch;
	readonly ticket: string;
	/** Display ids this launch's display goes by: the configured one, and those ListTargets showed it to be. */
	readonly displays: Set<string>;
	readonly sessions: Map<string, Session>;
	readonly attach: Map<string, Session>;
	opens: number;
	opening: boolean;
	presence: number;
	/** Presence streams asked to close whose cancel failed: still counted as open by the launch. */
	unconfirmed: number;
	readonly cleanup: { requested: number; answered: number; failed: number };
};

export function createViewerAdapter(options: ViewerAdapterOptions): ViewerAdapter {
	const origin = new URL(options.upstream.origin);
	if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin + "/" !== origin.href) {
		throw new RangeError("The upstream origin must be an http or https origin, with no path.");
	}
	if (!DISPLAY_ID.test(options.displayId)) throw new RangeError("The display id must be a plain id or `primary`.");
	const base = origin.origin;
	const mediaBase = `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}`;
	const { fetch: upstreamFetch, openMedia } = options.upstream;
	const wall = options.wallClock ?? Date.now;
	const assets: ReadonlyMap<AssetName, Asset> = loadViewerAssets();
	const launches = new Map<string, LaunchState>();

	/** Makes one gRPC-Web call to spacesd with `authorization`, and answers its one message or its error code. */
	async function call(
		method: string,
		body: Uint8Array,
		authorization: [string, string],
		signal: AbortSignal,
	): Promise<{ ok: true; message: Uint8Array } | { ok: false; code: number }> {
		let response: Response;
		try {
			response = await upstreamFetch(`${base}${method}`, {
				method: "POST",
				headers: [["content-type", GRPC_WEB], ["x-grpc-web", "1"], authorization],
				body: frame(0, body),
				redirect: "manual",
				signal,
			});
		} catch {
			return { ok: false, code: Code.Unavailable };
		}
		const cancel = () => void response.body?.cancel().catch(() => {});
		if (response.status !== 200 || response.headers.get("content-type") !== GRPC_WEB) {
			cancel();
			return { ok: false, code: Code.Unavailable };
		}
		const early = response.headers.get("grpc-status");
		if (early !== null) {
			cancel();
			return { ok: false, code: early === "0" ? Code.Internal : upstreamCode(Number(early)) };
		}
		const whole = await readBounded(response.body, MAX_RESPONSE_BYTES);
		const parts = whole && frames(whole);
		const data = parts?.filter((f) => f.flag === 0x00) ?? [];
		const trailers = parts?.filter((f) => f.flag === 0x80) ?? [];
		if (!parts || data.length + trailers.length !== parts.length || trailers.length !== 1 || parts.at(-1)?.flag !== 0x80) {
			return { ok: false, code: Code.Internal };
		}
		const status = trailerStatus(trailers[0]!.payload);
		if (status === undefined) return { ok: false, code: Code.Internal };
		if (status !== 0) return { ok: false, code: upstreamCode(status) };
		if (data.length !== 1) return { ok: false, code: Code.Internal };
		return { ok: true, message: data[0]!.payload };
	}

	const asViewer = (launch: LaunchState): [string, string] => [ENV_AUTHORIZATION, `Bearer ${launch.ticket}`];

	/** Asks spacesd to close a session this launch opened. What it answers is counted; that is not the session seen closed. */
	function closeUpstream(launch: LaunchState, sessionId: string): void {
		launch.cleanup.requested++;
		void call("/cua.env.v1.StreamService/CloseMedia", encode(schema.closeRequest, { mediaSessionId: sessionId }), asViewer(launch), AbortSignal.timeout(10_000)).then(
			(result) => (result.ok ? launch.cleanup.answered++ : launch.cleanup.failed++),
		);
	}

	/** Takes a session out of the launch: no RPC names it and no socket attaches to it again. */
	function retire(launch: LaunchState, session: Session, closeCode: number | undefined, requestClose: boolean): void {
		if (!session.open) return;
		session.open = false;
		launch.sessions.delete(session.id);
		launch.attach.delete(session.attachHash);
		session.relay?.end(closeCode);
		if (requestClose) closeUpstream(launch, session.id);
	}

	function ended(launch: LaunchState): void {
		launches.delete(launch.id);
		for (const session of [...launch.sessions.values()]) retire(launch, session, undefined, true);
	}

	async function startLaunch(request: LaunchRequest): Promise<LaunchHandle> {
		const lifetime = startViewerLaunch({ lifetimeMs: request.lifetimeMs, clock: options.clock, timers: options.timers });
		const id = token(16);
		const credential = token(32);
		const principal = { id: `pim-${token(12)}`, displayName: request.displayName ?? "Pim viewer", kind: 1 };
		// The ticket outlives the launch: its lifetime is counted from after the launch started.
		const ttl = BigInt(Math.ceil(lifetime.status().remainingMs / 1000));
		const minted = await call(
			"/cua.env.v1.SystemService/CreateViewerTicket",
			// Every grant named, not left to spacesd's defaults: unset `policy` would mean ALLOW_ACTIVATION.
			encode(schema.ticketRequest, { ttl: { seconds: ttl, nanos: 0 }, policy: SessionPolicy.VIEW_ONLY, clipboard: false, filesRoot: "", audioUplink: false, principal }),
			["authorization", `Bearer ${request.rootToken}`],
			lifetime.signal,
		);
		const answer = minted.ok ? decodeAnswer<{ ticket: string; filesRoot: string }>(schema.ticketResponse, minted.message) : undefined;
		if (!answer || !TICKET.test(answer.ticket) || !answer.ticket.startsWith("v1.") || answer.filesRoot !== "" || !lifetime.live()) {
			lifetime.end();
			// Nothing spacesd said, nor the root token, is repeated.
			throw new Error("The desktop did not grant a view-only viewer ticket for this launch.");
		}
		const launch: LaunchState = {
			id,
			credential: digest(credential),
			lifetime,
			ticket: answer.ticket,
			displays: new Set([options.displayId]),
			sessions: new Map(),
			attach: new Map(),
			opens: 0,
			opening: false,
			presence: 0,
			unconfirmed: 0,
			cleanup: { requested: 0, answered: 0, failed: 0 },
		};
		launches.set(id, launch);
		lifetime.signal.addEventListener("abort", () => ended(launch), { once: true });
		return Object.freeze({
			id,
			viewerPath: `/${id}/viewer/#ticket=${credential}&clipboard=0`,
			end: lifetime.end,
			status: () => ({ ...lifetime.status(), sessions: launch.sessions.size, unconfirmed: launch.unconfirmed, cleanup: { ...launch.cleanup } }),
		});
	}

	// -------------------------------------------------------------- RPCs

	/** Whether a display id names this launch's display. */
	const ours = (launch: LaunchState, displayId: string): boolean => launch.displays.has(displayId);

	function targets(launch: LaunchState, bytes: Uint8Array): Uint8Array | undefined {
		const answer = decodeAnswer<{ targets: StreamTarget[]; codecs: number[]; audioCodecs: number[] }>(schema.targetsResponse, bytes);
		if (!answer) return undefined;
		const displays = answer.targets.flatMap((t) => (t.target.case === "display" ? [{ display: t.target.value, available: t.available, limitation: t.limitation }] : []));
		const wanted = options.displayId === "primary" ? displays.find((d) => d.display.primary) : displays.find((d) => d.display.id === options.displayId);
		if (wanted && DISPLAY_ID.test(wanted.display.id)) {
			launch.displays.add(wanted.display.id);
			if (wanted.display.primary) {
				launch.displays.add("primary");
				launch.displays.add("");
			}
		}
		const d = wanted?.display;
		return encode(schema.targetsResponse, {
			targets: d
				? [
						{
							target: {
								case: "display",
								value: { id: d.id, name: d.name, primary: d.primary, bounds: d.bounds, nativeSize: d.nativeSize, scaleFactor: d.scaleFactor, refreshRateHz: d.refreshRateHz, rotationDegrees: d.rotationDegrees },
							},
							available: wanted.available,
							limitation: wanted.limitation,
						},
					]
				: [],
			codecs: answer.codecs.filter((c) => c === MediaCodec.H264 || c === MediaCodec.PNG),
			audioCodecs: answer.audioCodecs.filter((c) => c === AudioCodec.OPUS || c === AudioCodec.PCM_S16LE),
			audioUplinkAllowed: false,
			audioUplinkLimitation: "This viewer only watches the display.",
		});
	}

	/** The request spacesd gets for a browser's OpenMedia, or why there is none. */
	function openRequest(launch: LaunchState, request: OpenMediaRequest): { bytes: Uint8Array; codecs: number[]; ttlSeconds: number } | { code: number } {
		const target = request.target?.target;
		if (target?.case !== "displayId" || !ours(launch, target.value)) return { code: Code.PermissionDenied };
		if (request.geometryControl !== GeometryControl.UNSPECIFIED && request.geometryControl !== GeometryControl.OBSERVE_ONLY) return { code: Code.PermissionDenied };
		// Whatever input policy the browser asked for is answered with VIEW_ONLY; one spacesd doesn't define is refused.
		if (!Object.values(SessionPolicy).includes(request.policy as never)) return { code: Code.InvalidArgument };
		if (request.preferQuic || request.disableVideo || request.presenceParticipantId !== "") return { code: Code.PermissionDenied };
		const codecs = request.codecs;
		if (codecs.length === 0 || codecs.length > 2 || new Set(codecs).size !== codecs.length || codecs.some((c) => c !== MediaCodec.H264 && c !== MediaCodec.PNG)) {
			return { code: Code.InvalidArgument };
		}
		if (request.bitrateKbps !== 0 && (request.bitrateKbps < 250 || request.bitrateKbps > 100_000)) return { code: Code.InvalidArgument };
		const ttl = request.ticketTtl;
		if (ttl && (ttl.seconds < 0n || ttl.nanos < 0 || ttl.nanos > 999_999_999 || ttl.seconds > 86_400n)) return { code: Code.InvalidArgument };
		const remaining = Math.ceil(launch.lifetime.status().remainingMs / 1000);
		const ttlSeconds = Math.max(1, Math.min(ttl && ttl.seconds > 0n ? Number(ttl.seconds) : 60, MAX_MEDIA_TICKET_SECONDS, remaining));
		let audio: Record<string, unknown> | undefined;
		if (request.audio) {
			const { enabled, sourceIds, encoding: e, uplink } = request.audio;
			if (uplink !== undefined || sourceIds.length > 0) return { code: Code.PermissionDenied };
			if (
				e &&
				(e.codecs.length > 2 ||
					e.codecs.some((c) => c !== AudioCodec.OPUS && c !== AudioCodec.PCM_S16LE) ||
					![0, 8000, 12000, 16000, 24000, 48000].includes(e.sampleRateHz) ||
					e.channels > 2 ||
					(e.bitrateKbps !== 0 && (e.bitrateKbps < 6 || e.bitrateKbps > 510)) ||
					![0, 10, 20, 40, 60].includes(e.frameMs) ||
					e.expectedLossPercent > 100)
			) {
				return { code: Code.InvalidArgument };
			}
			audio = {
				enabled,
				sourceIds: [],
				encoding: e && { codecs: [...e.codecs], sampleRateHz: e.sampleRateHz, channels: e.channels, bitrateKbps: e.bitrateKbps, fec: e.fec, dtx: e.dtx, frameMs: e.frameMs, expectedLossPercent: e.expectedLossPercent },
			};
		}
		const dimension = request.maxDimension === 0 ? MAX_DIMENSION : Math.min(Math.max(request.maxDimension, MIN_DIMENSION), MAX_DIMENSION);
		const bytes = encode(schema.openRequest, {
			target: { target: { case: "displayId", value: options.displayId } },
			codecs: [...codecs],
			maxFps: Math.min(request.maxFps === 0 ? 30 : request.maxFps, MAX_FPS),
			maxDimension: dimension,
			bitrateKbps: Math.min(request.bitrateKbps, MAX_BITRATE_KBPS),
			policy: SessionPolicy.VIEW_ONLY,
			geometryControl: GeometryControl.OBSERVE_ONLY,
			ticketTtl: { seconds: BigInt(ttlSeconds), nanos: 0 },
			preferQuic: false,
			audio,
			disableVideo: false,
			presenceParticipantId: "",
		});
		return { bytes, codecs, ttlSeconds };
	}

	/** Checks spacesd's answer to OpenMedia and records the session; answers the browser's copy, or why there is none. */
	function opened(launch: LaunchState, bytes: Uint8Array, codecs: number[], ttlSeconds: number): Uint8Array | { code: number } {
		const answer = decodeAnswer<OpenMediaResponse>(schema.openResponse, bytes);
		if (!answer || !SESSION_ID.test(answer.mediaSessionId)) return { code: Code.Internal };
		const reject = (): { code: number } => {
			closeUpstream(launch, answer.mediaSessionId);
			return { code: Code.Internal };
		};
		const now = wall();
		const expires = timestampMs(answer.ticketExpiresAt);
		const size = answer.geometry?.frameSize;
		if (
			answer.policy !== SessionPolicy.VIEW_ONLY ||
			answer.geometryControl !== GeometryControl.OBSERVE_ONLY ||
			answer.quic !== undefined ||
			answer.audio?.uplink?.granted ||
			!TICKET.test(answer.ticket) ||
			answer.wsPath !== `/media?ticket=${percentEncode(answer.ticket)}` ||
			!codecs.includes(answer.codec) ||
			answer.wireVersion !== 2 ||
			!(expires > now && expires <= now + (ttlSeconds + 60) * 1000) ||
			(size && (size.width > 16_384 || size.height > 16_384)) ||
			launch.sessions.has(answer.mediaSessionId)
		) {
			return reject();
		}
		const attach = token(32);
		const session: Session = { id: answer.mediaSessionId, upstreamPath: answer.wsPath, expiresAtMs: expires, attachHash: digest(attach).toString("hex"), open: true, relay: undefined };
		// The viewer holds one session at a time: one it opens again replaces the last.
		for (const earlier of [...launch.sessions.values()]) retire(launch, earlier, 4404, true);
		launch.sessions.set(session.id, session);
		launch.attach.set(session.attachHash, session);
		const g = answer.geometry;
		return encode(schema.openResponse, {
			mediaSessionId: session.id,
			ticket: "",
			ticketExpiresAt: answer.ticketExpiresAt,
			wsPath: `/media?ticket=${attach}`,
			codec: answer.codec,
			maxFps: answer.maxFps,
			maxDimension: answer.maxDimension,
			bitrateKbps: answer.bitrateKbps,
			policy: SessionPolicy.VIEW_ONLY,
			geometryControl: GeometryControl.OBSERVE_ONLY,
			geometry: g && { frameSize: g.frameSize, scale: g.scale, logicalBounds: g.logicalBounds, geometryEpoch: g.geometryEpoch },
			wireVersion: 2,
			audio: answer.audio && {
				tracks: answer.audio.tracks.map((t) => ({ trackId: t.trackId, source: t.source && { sourceId: t.source.sourceId, kind: t.source.kind, name: t.source.name } })),
				encoding: answer.audio.encoding,
			},
		});
	}

	/** The request spacesd gets for a browser's SetPreferences, RequestKeyframe or CloseMedia, or why there is none. */
	function sessionRequest(launch: LaunchState, method: Method, request: Record<string, unknown>): Uint8Array | { code: number } {
		const id = request.mediaSessionId;
		if (typeof id !== "string" || !launch.sessions.get(id)?.open) return { code: Code.NotFound };
		if (method === "/cua.env.v1.StreamService/RequestKeyframe") return encode(schema.keyframeRequest, { mediaSessionId: id });
		if (method === "/cua.env.v1.StreamService/CloseMedia") return encode(schema.closeRequest, { mediaSessionId: id });
		const r = request as { maxFps: number; maxDimension: number; bitrateKbps: number; audioEnabled?: boolean } & Record<string, unknown>;
		const others = ["audioBitrateKbps", "audioFrameMs"].some((k) => r[k] !== 0) || ["audioFec", "audioDtx", "audioExpectedLossPercent", "audioUplinkMuted"].some((k) => r[k] !== undefined);
		if (others || (r.bitrateKbps !== 0 && (r.bitrateKbps < 250 || r.bitrateKbps > 100_000))) return { code: Code.InvalidArgument };
		return encode(schema.preferencesRequest, {
			mediaSessionId: id,
			maxFps: Math.min(r.maxFps, MAX_FPS),
			// 0 keeps the session's current size, which was bounded when it opened.
			maxDimension: r.maxDimension === 0 ? 0 : Math.min(Math.max(r.maxDimension, MIN_DIMENSION), MAX_DIMENSION),
			bitrateKbps: Math.min(r.bitrateKbps, MAX_BITRATE_KBPS),
			audioEnabled: r.audioEnabled,
		});
	}

	async function rpc(launch: LaunchState, method: Method, request: Request): Promise<Response> {
		const authority = request.headers.get(ENV_AUTHORIZATION);
		const presented = authority?.startsWith("Bearer ") ? authority.slice(7) : undefined;
		if (request.headers.has("authorization") || !presented || !/^[A-Za-z0-9_-]{43}$/.test(presented) || !timingSafeEqual(digest(presented), launch.credential)) {
			return grpcError(Code.Unauthenticated);
		}
		if (request.headers.get("content-type") !== GRPC_WEB) return plain(415);
		for (const name of ["grpc-encoding", "content-encoding"]) {
			const value = request.headers.get(name);
			if (value !== null && value !== "identity") return plain(415);
		}
		const length = request.headers.get("content-length");
		if (length !== null && !(Number(length) <= MAX_REQUEST_BYTES)) return plain(413);
		const body = await readBounded(request.body, MAX_REQUEST_BYTES);
		if (!body) return plain(413);
		const parts = frames(body);
		if (!parts || parts.length !== 1 || parts[0]!.flag !== 0x00) return grpcError(Code.InvalidArgument);
		const decoded = decode<Record<string, unknown>>(METHODS[method], parts[0]!.payload);
		if (!decoded) return grpcError(Code.InvalidArgument);
		if (!launch.lifetime.live()) return grpcError(Code.FailedPrecondition);
		const signal = AbortSignal.any([launch.lifetime.signal, request.signal]);

		switch (method) {
			case "/cua.env.v1.SystemService/GetCapabilities": {
				const result = await call(method, encode(schema.capabilitiesRequest, {}), asViewer(launch), signal);
				if (!launch.lifetime.live()) return grpcError(Code.FailedPrecondition);
				if (!result.ok) return grpcError(result.code);
				const caps = decodeAnswer<{ hostname: string; os?: { family: number } }>(schema.capabilitiesResponse, result.message);
				if (!caps) return grpcError(Code.Internal);
				return grpcOk(encode(schema.capabilitiesResponse, { hostname: caps.hostname, os: { family: caps.os?.family ?? 0 } }));
			}
			case "/cua.env.v1.StreamService/ListTargets": {
				const r = decoded as { includeWindows: boolean; windowFilter?: unknown };
				if (r.includeWindows || r.windowFilter !== undefined) return grpcError(Code.PermissionDenied);
				const result = await call(method, encode(schema.targetsRequest, { includeWindows: false }), asViewer(launch), signal);
				if (!launch.lifetime.live()) return grpcError(Code.FailedPrecondition);
				if (!result.ok) return grpcError(result.code);
				const answer = targets(launch, result.message);
				return answer ? grpcOk(answer) : grpcError(Code.Internal);
			}
			case "/cua.env.v1.StreamService/OpenMedia": {
				const outbound = openRequest(launch, decoded as unknown as OpenMediaRequest);
				if ("code" in outbound) return grpcError(outbound.code);
				if (launch.opening || launch.opens >= MAX_MEDIA_OPENS) return grpcError(Code.ResourceExhausted);
				launch.opening = true;
				launch.opens++;
				try {
					const result = await call(method, outbound.bytes, asViewer(launch), signal);
					if (!result.ok) return grpcError(result.code);
					if (!launch.lifetime.live()) {
						// spacesd opened a session for a launch that has ended since: it is asked to close it.
						const late = decodeAnswer<OpenMediaResponse>(schema.openResponse, result.message);
						if (late && SESSION_ID.test(late.mediaSessionId)) closeUpstream(launch, late.mediaSessionId);
						return grpcError(Code.FailedPrecondition);
					}
					const answer = opened(launch, result.message, outbound.codecs, outbound.ttlSeconds);
					return answer instanceof Uint8Array ? grpcOk(answer) : grpcError(answer.code);
				} finally {
					launch.opening = false;
				}
			}
			case "/cua.env.v1.StreamService/SetPreferences":
			case "/cua.env.v1.StreamService/RequestKeyframe":
			case "/cua.env.v1.StreamService/CloseMedia": {
				const outbound = sessionRequest(launch, method, decoded);
				if (!(outbound instanceof Uint8Array)) return grpcError(outbound.code);
				const result = await call(method, outbound, asViewer(launch), signal);
				if (!launch.lifetime.live()) return grpcError(Code.FailedPrecondition);
				if (!result.ok) return grpcError(result.code);
				const id = decoded.mediaSessionId as string;
				if (method === "/cua.env.v1.StreamService/CloseMedia") {
					const session = launch.sessions.get(id);
					if (session) retire(launch, session, 4404, false);
					return grpcOk(encode(schema.closeResponse, {}));
				}
				if (method === "/cua.env.v1.StreamService/RequestKeyframe") return grpcOk(encode(schema.keyframeResponse, {}));
				const p = decodeAnswer<{ maxFps: number; maxDimension: number; bitrateKbps: number; audioEnabled: boolean; audioEncoding?: unknown }>(schema.preferencesResponse, result.message);
				if (!p) return grpcError(Code.Internal);
				return grpcOk(encode(schema.preferencesResponse, { maxFps: p.maxFps, maxDimension: p.maxDimension, bitrateKbps: p.bitrateKbps, audioEnabled: p.audioEnabled, audioEncoding: p.audioEncoding }));
			}
			case "/cua.env.v1.PresenceService/Join":
				return join(launch, decoded, request.signal);
		}
	}

	// -------------------------------------------------------------- presence

	/** A cursor as this launch's viewer may see it: on its display and not over a window, or none. */
	function cursor(launch: LaunchState, c: CursorPosition | undefined): Record<string, unknown> | undefined {
		if (!c || c.window !== undefined || !ours(launch, c.displayId)) return undefined;
		return { displayId: c.displayId, position: c.position, visible: c.visible, shape: c.shape, shapeSource: c.shapeSource };
	}

	const participant = (p: Participant | undefined) =>
		p && { participantId: p.participantId, principal: p.principal && { id: p.principal.id, displayName: p.principal.displayName, color: p.principal.color, kind: p.principal.kind }, joinedAt: p.joinedAt };

	/** One presence event rebuilt from only what the viewer reads, or none. */
	function presenceEvent(launch: LaunchState, bytes: Uint8Array): Uint8Array | undefined {
		const event = decodeAnswer<{ event: JoinEvent }>(schema.joinResponse, bytes)?.event;
		const moved = (m: CursorMoved) => {
			const c = cursor(launch, m.cursor);
			return c && { participantId: m.participantId, cursor: c, at: m.at };
		};
		let value: unknown;
		switch (event?.case) {
			case "joined":
				// No datagram channel: its QUIC ticket stays upstream.
				value = { participant: participant(event.value.participant), roster: event.value.roster.map((r) => ({ participant: participant(r.participant), cursor: cursor(launch, r.cursor) })) };
				break;
			case "participantJoined":
				value = participant(event.value);
				break;
			case "participantLeft":
				value = { participantId: event.value.participantId, reason: event.value.reason };
				break;
			case "cursorMoved":
				value = moved(event.value);
				break;
			case "cursorBatch": {
				const moves = event.value.moves.flatMap((m) => moved(m) ?? []);
				value = moves.length > 0 ? { moves, tick: event.value.tick, at: event.value.at } : undefined;
				break;
			}
			case "cursorShapeChanged":
				value = { participantId: event.value.participantId, shape: event.value.shape, source: event.value.source };
				break;
			case "rosterHeartbeat":
				value = { participantIds: [...event.value.participantIds], at: event.value.at };
				break;
			case "keepalive":
				value = {};
				break;
			default:
				return undefined;
		}
		return value === undefined ? undefined : encode(schema.joinResponse, { event: { case: event.case, value } });
	}

	async function join(launch: LaunchState, request: Record<string, unknown>, browserSignal: AbortSignal): Promise<Response> {
		const r = request as { principal?: unknown; cursorDatagrams: boolean };
		if (r.principal !== undefined || r.cursorDatagrams) return grpcError(Code.PermissionDenied);
		if (launch.presence >= MAX_PRESENCE_STREAMS) return grpcError(Code.ResourceExhausted);
		launch.presence++;
		const stream = owner(launch.lifetime, "presence-rpc");
		const abort = new AbortController();
		let browser: ReadableStreamDefaultController<Uint8Array> | undefined;
		/** spacesd's body, once its answer has come. */
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		/** Whether spacesd's answer is still awaited: until it settles, a body may still come that has to be let go. */
		let acquiring = true;
		/** Whether spacesd's body ended or failed by itself, so nothing is left to let go. */
		let settled = false;
		let requested = false;
		let cancelling = false;
		let observed = false;
		/** The stream is seen closed: it leaves the launch's counts, once. */
		const observe = () => {
			if (observed) return;
			observed = true;
			launch.presence--;
			stream.closed();
		};
		/** Lets go of spacesd's side once a shutdown has been requested, and reports the stream closed only when that is seen to have happened. */
		const release = () => {
			if (!requested || acquiring || cancelling || observed) return;
			if (!reader || settled) return observe();
			cancelling = true;
			const body = reader;
			body.cancel().then(observe, () => {
				// A body that had failed by itself has ended, and its cancel says so by failing too. One that was
				// open and whose cancel failed hasn't confirmed its end: it stays counted as open, and as unconfirmed.
				body.closed.then(
					() => void launch.unconfirmed++,
					() => observe(),
				);
			});
		};
		/** Requests the stream's end both ways. */
		const finish = (trailer?: Uint8Array) => {
			if (requested) return;
			requested = true;
			abort.abort();
			try {
				if (trailer) {
					browser?.enqueue(trailer);
					browser?.close();
				} else browser?.error(new Error("The presence stream ended."));
			} catch {
				// The browser's side has gone already.
			}
			release();
		};
		browserSignal.addEventListener("abort", () => finish(), { once: true });
		// Cursor shapes are never asked for: spacesd may compute them by moving the real pointer (its idle probe).
		const outbound = encode(schema.joinRequest, { cursorShapes: false, cursorBatches: true, cursorDatagrams: false, rosterInterval: { seconds: ROSTER_SECONDS, nanos: 0 } });
		if (!stream.adopt(() => finish()) || browserSignal.aborted) {
			acquiring = false;
			finish();
			release();
			return grpcError(Code.FailedPrecondition);
		}
		let response: Response;
		try {
			response = await upstreamFetch(`${base}/cua.env.v1.PresenceService/Join`, {
				method: "POST",
				headers: [["content-type", GRPC_WEB], ["x-grpc-web", "1"], asViewer(launch)],
				body: frame(0, outbound),
				redirect: "manual",
				signal: AbortSignal.any([abort.signal, launch.lifetime.signal]),
			});
		} catch {
			// Nothing came, so nothing is left to let go.
			acquiring = false;
			finish();
			release();
			return grpcError(Code.Unavailable);
		}
		acquiring = false;
		reader = response.body?.getReader();
		// A body that came after the shutdown was requested is let go now, and the stream counts until it is.
		if (requested || !launch.lifetime.live()) {
			finish();
			release();
			return grpcError(Code.FailedPrecondition);
		}
		const early = response.headers.get("grpc-status");
		if (response.status !== 200 || response.headers.get("content-type") !== GRPC_WEB || early !== null || !reader) {
			finish();
			return grpcError(early !== null && early !== "0" ? upstreamCode(Number(early)) : Code.Unavailable);
		}
		const source = reader;
		const next = frameReader(async () => {
			try {
				const result = await source.read();
				if (result.done) settled = true;
				return result;
			} catch (error) {
				settled = true;
				throw error;
			}
		}, MAX_PRESENCE_MESSAGE_BYTES);
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				browser = controller;
			},
			// One event is read from spacesd for each the browser takes, so a browser that stops reading holds spacesd's stream back.
			pull: async (controller) => {
				try {
					for (;;) {
						if (requested) return;
						if (!launch.lifetime.live()) return finish();
						const f = await next();
						if (requested) return release();
						if (!launch.lifetime.live()) return finish();
						if (!f) return finish(frame(0x80, textEncoder.encode(`grpc-status: ${Code.Unavailable}\r\n`)));
						if (f.flag === 0x80) {
							const status = trailerStatus(f.payload);
							return finish(frame(0x80, textEncoder.encode(`grpc-status: ${status === 0 ? 0 : upstreamCode(status ?? Code.Internal)}\r\n`)));
						}
						if (f.flag !== 0x00) return finish();
						const event = presenceEvent(launch, f.payload);
						if (event) {
							controller.enqueue(frame(0, event));
							return;
						}
					}
				} catch {
					finish();
					release();
				}
			},
			cancel: () => finish(),
		});
		return new Response(body, { status: 200, headers: { "content-type": GRPC_WEB, "cache-control": "no-store" } });
	}

	// -------------------------------------------------------------- media

	/** The one control message the browser may send up, rebuilt, or undefined. */
	function fromBrowser(session: Session, data: string | Uint8Array): string | undefined {
		if (typeof data !== "string" || byteLength(data) > MAX_BROWSER_CONTROL_BYTES) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return undefined;
		}
		const m = parsed as { type?: unknown; payload?: Record<string, unknown> };
		const p = m?.payload;
		if (!p || typeof p !== "object" || p.session_id !== session.id) return undefined;
		const keys = Object.keys(p).sort().join(",");
		if (m.type === "request_keyframe" && keys === "session_id") return JSON.stringify({ type: "request_keyframe", payload: { session_id: session.id } });
		if (
			m.type === "frame_ack" &&
			keys === "decode_queue,sequence,session_id" &&
			Number.isSafeInteger(p.sequence) &&
			(p.sequence as number) >= 0 &&
			Number.isSafeInteger(p.decode_queue) &&
			(p.decode_queue as number) >= 0 &&
			(p.decode_queue as number) <= 4096
		) {
			return JSON.stringify({ type: "frame_ack", payload: { session_id: session.id, sequence: p.sequence, decode_queue: p.decode_queue } });
		}
		return undefined;
	}

	/** A control message from spacesd: its type and payload, unwrapping the `{direction, message}` form. */
	function control(text: string): { type: string; payload: Record<string, unknown> } | undefined {
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return undefined;
		}
		let o = value as Record<string, unknown> | null;
		if (o && typeof o === "object" && "direction" in o) o = o.direction === "server" ? (o.message as Record<string, unknown>) : null;
		if (!o || typeof o !== "object" || typeof o.type !== "string") return undefined;
		const payload = o.payload && typeof o.payload === "object" ? (o.payload as Record<string, unknown>) : {};
		return { type: o.type, payload };
	}

	function sessionOpenedOk(launch: LaunchState, session: Session, p: Record<string, unknown>): boolean {
		const target = p.target as { kind?: unknown; display_id?: unknown } | undefined;
		return (
			p.session_id === session.id &&
			p.policy === "view_only" &&
			(p.geometry_control === undefined || p.geometry_control === "observe_only") &&
			target?.kind === "display" &&
			typeof target.display_id === "string" &&
			ours(launch, target.display_id)
		);
	}

	const RELAYED_CLOSE = new Set([1000, 1001, 1011, 4400, 4401, 4404, 4408, 4410, 4429, 4500]);

	function attach(launch: LaunchState, session: Session, open: (events: MediaEvents) => MediaSocket): void {
		let browser: MediaSocket | undefined;
		let upstream: MediaSocket | undefined;
		let opened = false;
		let done = false;
		const abort = new AbortController();
		const viewer = owner(launch.lifetime, "media-viewer");
		// Each half is terminated once, by whichever of the relay and the launch gets there first.
		let browserStopped = false;
		let upstreamStopped = false;
		const stopBrowser = () => {
			if (browserStopped || !browser) return;
			browserStopped = true;
			browser.terminate();
		};
		const stopUpstream = () => {
			if (upstreamStopped || !upstream) return;
			upstreamStopped = true;
			upstream.terminate();
		};
		const relay: Relay = {
			end: (code) => {
				if (done) return;
				done = true;
				abort.abort();
				if (session.relay === relay) session.relay = undefined;
				try {
					// A close with a code tells the viewer what happened; the launch still terminates it if it never finishes closing.
					if (code === undefined || browserStopped) stopBrowser();
					else browser?.close(code);
				} catch {
					// Its owner still reports it closed.
				}
				try {
					stopUpstream();
				} catch {
					// Its owner still reports it closed.
				}
			},
		};
		/** spacesd broke the view-only contract on this socket: the session is dropped and asked to close. */
		const untrusted = () => {
			retire(launch, session, 4404, true);
			relay.end(4404);
		};
		browser = open({
			message: (data) => {
				if (done) return;
				// The launch's clock is read for every message: one that comes after the deadline ends the launch here, whether or not its timer has run.
				if (!launch.lifetime.live()) return relay.end();
				const up = opened && upstream ? fromBrowser(session, data) : undefined;
				// Anything else (input, actions, geometry, audio, or a message before the stream started) ends the relay; nothing of it goes up.
				if (up === undefined) return relay.end(1008);
				upstream!.send(up);
			},
			closed: () => {
				viewer.closed();
				relay.end();
			},
		});
		if (!viewer.adopt(stopBrowser) || done) return relay.end();
		if (!session.open) return relay.end(4404);
		session.relay?.end(4404);
		session.relay = relay;
		const fromUpstream = (data: string | Uint8Array) => {
			if (done) return;
			if (!launch.lifetime.live()) return relay.end();
			if (typeof data === "string") {
				const m = byteLength(data) <= MAX_MEDIA_CONTROL_BYTES ? control(data) : undefined;
				if (!m) return untrusted();
				if (m.type === "session_opened") {
					if (opened || !sessionOpenedOk(launch, session, m.payload)) return untrusted();
					opened = true;
				} else if (!opened && m.type !== "hello") return untrusted();
			} else if (!opened || data.byteLength > MAX_MEDIA_PACKET_BYTES) return untrusted();
			browser!.send(data);
			if (browser!.bufferedAmount() > MAX_BROWSER_BUFFERED_BYTES) relay.end(1011);
		};
		const upstreamOwner = owner(launch.lifetime, "media-upstream");
		void (async () => {
			let socket: MediaSocket;
			try {
				if (!launch.lifetime.live() || done) return relay.end();
				socket = await openMedia({
					url: `${mediaBase}${session.upstreamPath}`,
					protocol: MEDIA_PROTOCOL,
					signal: AbortSignal.any([abort.signal, launch.lifetime.signal]),
					events: {
						message: fromUpstream,
						closed: (code) => {
							upstreamOwner.closed();
							relay.end(code !== undefined && RELAYED_CLOSE.has(code) ? code : 1011);
						},
					},
				});
			} catch (error) {
				// Nothing was opened, so there is nothing to own.
				const status = (error as { status?: unknown })?.status;
				return relay.end(status === 401 ? 4401 : status === 404 || status === 410 ? 4404 : 1011);
			}
			upstream = socket;
			// Adopted even when the launch or the relay has ended meanwhile: the launch then refuses it and closes it.
			if (!upstreamOwner.adopt(stopUpstream) || done) {
				stopUpstream();
				relay.end();
			}
		})();
	}

	function media(target: string, protocols: readonly string[]): MediaUpgrade {
		const m = new RegExp(`^/(${LAUNCH_ID})/media\\?ticket=(${ATTACH_TOKEN})$`).exec(target);
		if (!m) return { status: 404 };
		if (!protocols.includes(MEDIA_PROTOCOL)) return { status: 400 };
		const [, id, token] = m as unknown as [string, string, string];
		/** The live launch and open session this target names now, with an unexpired media ticket, or why not. */
		const check = (): { launch: LaunchState; session: Session } | { status: 401 | 404 } => {
			const launch = launches.get(id);
			if (!launch?.lifetime.live()) return { status: 404 };
			const session = launch.attach.get(digest(token).toString("hex"));
			if (!session?.open) return { status: 404 };
			// An expired media ticket lets no new socket attach; one already attached stays, until the launch ends.
			if (wall() >= session.expiresAtMs) return { status: 401 };
			return { launch, session };
		};
		const first = check();
		if ("status" in first) return first;
		let used = false;
		return {
			status: 101,
			protocol: MEDIA_PROTOCOL,
			attach: (open) => {
				if (used) throw new Error("A media upgrade is attached once.");
				used = true;
				// Checked again: time has passed since the upgrade was asked for, and the ticket, session or launch may have gone.
				const now = check();
				if ("status" in now) return now.status;
				attach(now.launch, now.session, open);
				return 101;
			},
		};
	}

	// -------------------------------------------------------------- HTTP

	const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'";

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const m = new RegExp(`^/(${LAUNCH_ID})/(.+)$`).exec(url.pathname);
		if (!m || url.search !== "" || url.username !== "" || url.password !== "") return plain(404);
		const [, id, rest] = m as unknown as [string, string, string];
		const asset: AssetName | undefined = rest === "viewer/" ? "index.html" : rest.startsWith("viewer/") && Object.hasOwn(VIEWER_ASSETS, rest.slice(7)) ? (rest.slice(7) as AssetName) : undefined;
		const method = rest.startsWith("cua.env.v1.") && Object.hasOwn(METHODS, `/${rest}`) ? (`/${rest}` as Method) : undefined;
		if (!asset && !method) return plain(404);
		const launch = launches.get(id);
		if (!launch?.lifetime.live()) return plain(404);
		if (asset) {
			if (request.method !== "GET") return plain(405);
			const file = assets.get(asset)!;
			const headers: Record<string, string> = {
				"content-type": file.type,
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
				"cross-origin-resource-policy": "same-origin",
			};
			if (asset === "index.html") headers["content-security-policy"] = CSP;
			return new Response(new Uint8Array(file.body), { status: 200, headers });
		}
		if (request.method !== "POST") return plain(405);
		return rpc(launch, method!, request);
	}

	return Object.freeze({ startLaunch, fetch: handle, media });
}
