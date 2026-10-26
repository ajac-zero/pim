/**
 * The Cua viewer adapter (../viewer-adapter.ts), driven two ways:
 *
 * - by Cua's own viewer, the pinned `viewer.js` itself (the bytes the
 *   adapter serves), run in this process with a DOM, `fetch` and
 *   `WebSocket` made of in-memory records that route to the adapter;
 * - by requests the tests build with the pinned schema, for what that
 *   viewer never sends.
 *
 * What answers behind the adapter is a stand-in for spacesd written here
 * from its source at the pinned commit (what it clamps, which geometry it
 * would let a window session change, how it answers); it shows what the
 * adapter sends and does, and proves nothing about the real binary. No
 * browser, desktop, socket, server or process is involved.
 *
 *   pnpm --filter pim-cua-host test
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { create, type DescMessage, fromBinary, toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import type { Timers } from "../viewer-lifetime.ts";
import {
	createViewerAdapter,
	type LaunchHandle,
	MAX_DIMENSION,
	MAX_MEDIA_TICKET_SECONDS,
	type MediaEvents,
	type MediaSocket,
	type ViewerAdapter,
	type ViewerAdapterOptions,
} from "../viewer-adapter.ts";
import { CUA_COMMIT, DESCRIPTORS, GeometryControl, MediaCodec, message, SessionPolicy, VIEWER_ASSETS } from "../viewer-upstream.ts";

const ORIGIN = "http://127.0.0.1:3211";
const ROOT = "root-token-of-the-stand-in-0123456789";
const VIEWER_TICKET = "v1.viewer-ticket-of-the-stand-in.sig";
const GRPC = "application/grpc-web+proto";
const PAGE = "https://pim.test";
const ASSETS = new URL("../cua-viewer/assets/", import.meta.url);

const settle = async (rounds = 5) => {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > ms) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

// ------------------------------------------------------------------ gRPC-Web

const S = (name: string) => message(`cua.env.v1.${name}`);
const RPC: Record<string, readonly [DescMessage, DescMessage]> = {
	"/cua.env.v1.SystemService/CreateViewerTicket": [S("CreateViewerTicketRequest"), S("CreateViewerTicketResponse")],
	"/cua.env.v1.SystemService/GetCapabilities": [S("GetCapabilitiesRequest"), S("GetCapabilitiesResponse")],
	"/cua.env.v1.StreamService/ListTargets": [S("ListTargetsRequest"), S("ListTargetsResponse")],
	"/cua.env.v1.StreamService/OpenMedia": [S("OpenMediaRequest"), S("OpenMediaResponse")],
	"/cua.env.v1.StreamService/SetPreferences": [S("SetPreferencesRequest"), S("SetPreferencesResponse")],
	"/cua.env.v1.StreamService/RequestKeyframe": [S("RequestKeyframeRequest"), S("RequestKeyframeResponse")],
	"/cua.env.v1.StreamService/CloseMedia": [S("CloseMediaRequest"), S("CloseMediaResponse")],
	"/cua.env.v1.PresenceService/Join": [S("JoinRequest"), S("JoinResponse")],
	"/cua.env.v1.PresenceService/Leave": [S("LeaveRequest"), S("LeaveResponse")],
	"/cua.env.v1.PresenceService/UpdateCursor": [S("UpdateCursorRequest"), S("UpdateCursorResponse")],
};

function frame(flag: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(5 + payload.byteLength);
	out[0] = flag;
	new DataView(out.buffer).setUint32(1, payload.byteLength);
	out.set(payload, 5);
	return out;
}

const trailer = (status: number) => frame(0x80, new TextEncoder().encode(`grpc-status:${status}\r\n`));
const bytesOf = (schema: DescMessage, init: object) => toBinary(schema, create(schema, init as never));

function grpcAnswer(schema: DescMessage, init: object): Response {
	const data = frame(0, bytesOf(schema, init));
	const end = trailer(0);
	const body = new Uint8Array(data.byteLength + end.byteLength);
	body.set(data);
	body.set(end, data.byteLength);
	return new Response(body, { status: 200, headers: { "content-type": GRPC } });
}

const grpcFailure = (code: number) => new Response(null, { status: 200, headers: { "content-type": GRPC, "grpc-status": String(code), "grpc-message": "stand-in refusal" } });

function parseFrames(body: Uint8Array): { flag: number; payload: Uint8Array }[] {
	const out = [];
	let at = 0;
	while (at + 5 <= body.byteLength) {
		const length = new DataView(body.buffer, body.byteOffset + at + 1, 4).getUint32(0);
		out.push({ flag: body[at]!, payload: body.subarray(at + 5, at + 5 + length) });
		at += 5 + length;
	}
	return out;
}

const percent = (value: string) => [...Buffer.from(value)].map((b) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");

// ------------------------------------------------------------------ the stand-in for spacesd

type Call = { method: string; authorization: string | null; env: string | null; request: Record<string, any>; signal: AbortSignal };

type UpstreamSocket = MediaSocket & {
	readonly session: string;
	readonly url: string;
	readonly received: (string | Uint8Array)[];
	terminated: number;
	closed: boolean;
	serve: (data: string | Uint8Array) => void;
	drop: (code?: number) => void;
};

type PresenceStream = { readonly call: Call; push: (event: object) => void; end: (status?: number) => void; aborted: boolean; cancelled: boolean };

/**
 * A stand-in for spacesd 0.7.0, written from its source: viewer tickets
 * cap the media policy (`ViewerGrant::clamp_policy`), an unset ticket
 * policy means ALLOW_ACTIVATION, a window OpenMedia with bidirectional
 * geometry gets a geometry lease (counted in `geometry`), and input,
 * actions and window geometry on a media socket reach the desktop
 * (counted in `geometry` and `input`). It is a record of what the adapter
 * sends, not spacesd.
 */
function standIn(wall: () => number = Date.now) {
	const calls: Call[] = [];
	const geometry = { calls: 0 };
	const input = { calls: 0 };
	const tickets = new Map<string, { session: string; expiresAt: number }>();
	const sockets: UpstreamSocket[] = [];
	const presence: PresenceStream[] = [];
	const closed: string[] = [];
	let grant = { policy: SessionPolicy.ALLOW_ACTIVATION };
	let sessions = 0;
	const options = {
		/** When set, OpenMedia answers this instead of its own answer. */
		openAnswer: undefined as ((own: Record<string, any>) => object) | undefined,
		/** When set, OpenMedia waits for this before answering. */
		openGate: undefined as Promise<void> | undefined,
		/** When set, opening a media socket waits for this. */
		mediaGate: undefined as Promise<void> | undefined,
		/** When set, the `session_opened` the socket sends. */
		sessionOpened: undefined as ((session: string) => object) | undefined,
		/** A socket's `terminate` reports it closed at once, from within itself. */
		closesAtOnce: false,
		mintAnswer: undefined as object | undefined,
		joined: undefined as object | undefined,
	};

	const viewer = (call: Call) => call.env === `Bearer ${VIEWER_TICKET}`;
	const handlers: Record<string, (call: Call) => Response | Promise<Response>> = {
		"/cua.env.v1.SystemService/CreateViewerTicket": (call) => {
			if (call.authorization !== `Bearer ${ROOT}`) return grpcFailure(16);
			// An unset policy means a full interactive viewer (`create_viewer_ticket`).
			grant = { policy: call.request.policy === 0 ? SessionPolicy.ALLOW_ACTIVATION : call.request.policy };
			return grpcAnswer(
				RPC[call.method]![1],
				options.mintAnswer ?? { ticket: VIEWER_TICKET, expiresAt: { seconds: BigInt(Math.floor(wall() / 1000) + 86_400), nanos: 0 }, viewerPath: `/viewer/#ticket=${VIEWER_TICKET}`, filesRoot: "" },
			);
		},
		"/cua.env.v1.SystemService/GetCapabilities": (call) =>
			viewer(call) ? grpcAnswer(RPC[call.method]![1], { version: "0.7.0", hostname: "desk", os: { family: 2, prettyName: "Ubuntu 24.04" }, features: [{ name: "computer.exec", supported: true }] }) : grpcFailure(16),
		"/cua.env.v1.StreamService/ListTargets": (call) =>
			viewer(call)
				? grpcAnswer(RPC[call.method]![1], {
						targets: [
							{ target: { case: "display", value: { id: "0", name: "XVFB-0", primary: true, nativeSize: { width: 1920, height: 1080 }, scaleFactor: 1 } }, available: true },
							{ target: { case: "display", value: { id: "1", name: "XVFB-1", primary: false } }, available: true },
							{ target: { case: "window", value: { ref: { id: "w-secret", epoch: 1n }, title: "Private window" } }, available: true },
						],
						codecs: [MediaCodec.H264, MediaCodec.BGRA],
						audioUplinkAllowed: true,
					})
				: grpcFailure(16),
		"/cua.env.v1.StreamService/OpenMedia": async (call) => {
			if (!viewer(call)) return grpcFailure(16);
			if (options.openGate) await options.openGate;
			const r = call.request;
			const window = r.target?.target?.case === "window";
			if (window && r.geometryControl === GeometryControl.BIDIRECTIONAL) geometry.calls++;
			const n = ++sessions;
			const session = `ms-${n}`;
			const ticket = `v1.media-${n}+${"/".repeat(2)}.sig`;
			const ttl = Number(r.ticketTtl?.seconds ?? 60n) || 60;
			const expiresAt = wall() + Math.min(ttl, 600) * 1000;
			tickets.set(ticket, { session, expiresAt });
			const own = {
				mediaSessionId: session,
				ticket,
				ticketExpiresAt: { seconds: BigInt(Math.floor(expiresAt / 1000)), nanos: (expiresAt % 1000) * 1e6 },
				wsPath: `/media?ticket=${percent(ticket)}`,
				codec: r.codecs[0] ?? MediaCodec.H264,
				maxFps: r.maxFps,
				maxDimension: r.maxDimension,
				// `open_media` caps the requested policy by the viewer ticket's grant.
				policy: Math.min(r.policy || SessionPolicy.VIEW_ONLY, grant.policy),
				geometryControl: window && r.geometryControl === GeometryControl.BIDIRECTIONAL ? GeometryControl.BIDIRECTIONAL : GeometryControl.OBSERVE_ONLY,
				geometry: { frameSize: { width: 1920, height: 1080 }, scale: 1 },
				wireVersion: 2,
			};
			return grpcAnswer(RPC[call.method]![1], options.openAnswer ? options.openAnswer(own) : own);
		},
		"/cua.env.v1.StreamService/SetPreferences": (call) =>
			viewer(call) ? grpcAnswer(RPC[call.method]![1], { maxFps: call.request.maxFps || 30, maxDimension: call.request.maxDimension, bitrateKbps: 0 }) : grpcFailure(16),
		"/cua.env.v1.StreamService/RequestKeyframe": (call) => (viewer(call) ? grpcAnswer(RPC[call.method]![1], {}) : grpcFailure(16)),
		"/cua.env.v1.StreamService/CloseMedia": (call) => {
			if (!viewer(call)) return grpcFailure(16);
			closed.push(call.request.mediaSessionId);
			for (const socket of sockets) if (socket.session === call.request.mediaSessionId) socket.drop(4404);
			return grpcAnswer(RPC[call.method]![1], {});
		},
		"/cua.env.v1.PresenceService/Join": (call) => {
			if (!viewer(call)) return grpcFailure(16);
			const schema = RPC[call.method]![1];
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const stream: PresenceStream = {
				call,
				aborted: false,
				cancelled: false,
				push: (event) => controller.enqueue(frame(0, bytesOf(schema, { event }))),
				end: (status = 0) => {
					controller.enqueue(trailer(status));
					controller.close();
				},
			};
			const body = new ReadableStream<Uint8Array>({
				start: (c) => {
					controller = c;
				},
				cancel: () => {
					stream.cancelled = true;
				},
			});
			call.signal.addEventListener("abort", () => {
				stream.aborted = true;
				try {
					controller.error(new Error("aborted"));
				} catch {}
			});
			presence.push(stream);
			stream.push(
				options.joined ?? {
					case: "joined",
					value: { participant: { participantId: "p-viewer", principal: { id: "viewer:pim", displayName: "Pim viewer" } }, roster: [] },
				},
			);
			return new Response(body, { status: 200, headers: { "content-type": GRPC } });
		},
	};

	async function fetch(url: string, init: RequestInit): Promise<Response> {
		assert.ok(url.startsWith(`${ORIGIN}/`), `the adapter calls only spacesd's origin, not ${url}`);
		assert.equal(init.redirect, "manual");
		const method = url.slice(ORIGIN.length);
		const schemas = RPC[method];
		assert.ok(schemas, `no stand-in for ${method}`);
		const headers = new Headers(init.headers);
		assert.equal(headers.get("content-type"), GRPC);
		const body = init.body as Uint8Array;
		const parts = parseFrames(body);
		assert.equal(parts.length, 1);
		const call: Call = {
			method,
			authorization: headers.get("authorization"),
			env: headers.get("x-cua-env-authorization"),
			request: fromBinary(schemas[0], parts[0]!.payload) as Record<string, any>,
			signal: init.signal!,
		};
		calls.push(call);
		return handlers[method]!(call);
	}

	async function openMedia(request: { url: string; protocol: string; signal: AbortSignal; events: MediaEvents }): Promise<MediaSocket> {
		const url = new URL(request.url);
		assert.equal(`${url.protocol}//${url.host}${url.pathname}`, "ws://127.0.0.1:3211/media");
		assert.equal(request.protocol, "rcdp.v2");
		if (options.mediaGate) await options.mediaGate;
		const ticket = url.searchParams.get("ticket") ?? "";
		const known = tickets.get(ticket);
		// `media_ws::upgrade`: 401 for a missing, unknown or expired ticket.
		if (!known || wall() >= known.expiresAt) throw Object.assign(new Error("ticket refused"), { status: 401 });
		const socket: UpstreamSocket = {
			session: known.session,
			url: request.url,
			received: [],
			terminated: 0,
			closed: false,
			send: (data) => {
				socket.received.push(data);
				if (typeof data !== "string") return;
				const type = JSON.parse(data).type;
				if (type === "set_window_geometry") geometry.calls++;
				if (type === "interactive_input" || type === "action") input.calls++;
			},
			close: (code) => socket.drop(code),
			terminate: () => {
				socket.terminated++;
				socket.drop(1006);
			},
			bufferedAmount: () => 0,
			serve: (data) => request.events.message(data),
			drop: (code) => {
				if (socket.closed) return;
				socket.closed = true;
				if (options.closesAtOnce) request.events.closed(code);
				else setImmediate(() => request.events.closed(code));
			},
		};
		sockets.push(socket);
		setImmediate(() => {
			if (socket.closed) return;
			socket.serve(JSON.stringify({ type: "hello", payload: { wire_version: 2, capabilities: [] } }));
			socket.serve(
				JSON.stringify({
					type: "session_opened",
					payload: options.sessionOpened?.(known.session) ?? {
						session_id: known.session,
						target: { kind: "display", display_id: "0" },
						geometry: { width_px: 1920, height_px: 1080 },
						codec: "h264",
						max_fps: 60,
						max_dimension: 2560,
						capabilities: [],
						action_capabilities: [],
						policy: "view_only",
					},
				}),
			);
		});
		return socket;
	}

	return { calls, geometry, input, sockets, presence, closed, options, fetch, openMedia, methods: () => calls.map((c) => c.method) };
}

// ------------------------------------------------------------------ time and launches

function manualTime(start = 10_000) {
	let now = start;
	const pending = new Map<number, { at: number; callback: () => void }>();
	let next = 1;
	const timers: Timers = {
		set: (callback, ms) => {
			pending.set(next, { at: now + ms, callback });
			return next++;
		},
		clear: (handle) => void pending.delete(handle as number),
	};
	return {
		clock: () => now,
		timers,
		/** Moves the clock without running any timer, as a timer that runs late would leave it. */
		setNow(to: number) {
			now = to;
		},
		advance(ms: number) {
			now += ms;
			for (const [id, t] of [...pending]) {
				if (t.at <= now) {
					pending.delete(id);
					t.callback();
				}
			}
		},
	};
}

type Launch = { handle: LaunchHandle; id: string; credential: string };

async function launch(adapter: ViewerAdapter, lifetimeMs = 30 * 60_000): Promise<Launch> {
	const handle = await adapter.startLaunch({ lifetimeMs, rootToken: ROOT });
	const m = /^\/([^/]+)\/viewer\/#ticket=([^&]+)&clipboard=0$/.exec(handle.viewerPath);
	assert.ok(m, handle.viewerPath);
	return { handle, id: m[1]!, credential: m[2]! };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function setup(options: Partial<ViewerAdapterOptions> = {}, wall: () => number = Date.now, wrap: (fetch: Fetch) => Fetch = (fetch) => fetch) {
	const upstream = standIn(wall);
	const adapter = createViewerAdapter({ upstream: { origin: ORIGIN, fetch: wrap(upstream.fetch), openMedia: upstream.openMedia }, displayId: "primary", wallClock: wall, ...options });
	return { upstream, adapter };
}

type Answer = { http: number; code: number | undefined; message?: Record<string, any> };

/** Calls the adapter as a browser would, with the launch's credential unless told otherwise. */
async function rpc(
	adapter: ViewerAdapter,
	l: Launch,
	method: string,
	init: object | Uint8Array,
	options: { headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer>; path?: string; httpMethod?: string } = {},
): Promise<Answer> {
	const schemas = RPC[method];
	const payload = init instanceof Uint8Array ? init : bytesOf(schemas![0], init);
	const response = await adapter.fetch(
		new Request(`${PAGE}${options.path ?? `/${l.id}${method}`}`, {
			method: options.httpMethod ?? "POST",
			headers: { "content-type": GRPC, "x-cua-env-authorization": `Bearer ${l.credential}`, ...options.headers },
			body: options.httpMethod === "GET" ? undefined : (options.body ?? frame(0, payload)),
		}),
	);
	const early = response.headers.get("grpc-status");
	if (early !== null) return { http: response.status, code: Number(early) };
	if (response.status !== 200 || !schemas) return { http: response.status, code: undefined };
	const parts = parseFrames(new Uint8Array(await response.arrayBuffer()));
	const status = Number(/grpc-status:\s*(\d+)/.exec(new TextDecoder().decode(parts.at(-1)!.payload))![1]);
	return { http: 200, code: status, message: parts.length > 1 ? (fromBinary(schemas[1], parts[0]!.payload) as Record<string, any>) : undefined };
}

const OPEN = "/cua.env.v1.StreamService/OpenMedia";
const openInit = (overrides: object = {}) => ({
	target: { target: { case: "displayId", value: "0" } },
	codecs: [MediaCodec.H264, MediaCodec.PNG],
	maxFps: 60,
	maxDimension: 2560,
	policy: SessionPolicy.ALLOW_ACTIVATION,
	ticketTtl: { seconds: 600n, nanos: 0 },
	...overrides,
});

/** A launch whose display has been listed and whose media session is open, as the viewer does before it attaches. */
async function opened(adapter: ViewerAdapter, l: Launch) {
	assert.equal((await rpc(adapter, l, "/cua.env.v1.StreamService/ListTargets", {})).code, 0);
	const answer = await rpc(adapter, l, OPEN, openInit());
	assert.equal(answer.code, 0);
	return answer.message!;
}

/** A browser's media socket as the host would hand it to the adapter. */
function browserSocket(adapter: ViewerAdapter, target: string, protocols = ["rcdp.v2"]) {
	const upgrade = adapter.media(target, protocols);
	const socket = {
		status: upgrade.status,
		received: [] as (string | Uint8Array)[],
		closedWith: [] as (number | undefined)[],
		terminated: 0,
		events: undefined as MediaEvents | undefined,
		gone: false,
	};
	const drop = (code?: number) => {
		if (socket.gone) return;
		socket.gone = true;
		socket.closedWith.push(code);
		setImmediate(() => socket.events!.closed(code));
	};
	if (upgrade.status === 101) {
		upgrade.attach((events) => {
			socket.events = events;
			return {
				send: (data) => void socket.received.push(data),
				close: (code) => drop(code),
				terminate: () => {
					socket.terminated++;
					drop();
				},
				bufferedAmount: () => 0,
			};
		});
	}
	return socket;
}

const mediaTarget = (l: Launch, wsPath: string) => `/${l.id}${wsPath}`;

// ------------------------------------------------------------------ the pinned viewer, in memory

/** An element with what the viewer's DOM code touches, recording nothing it doesn't need. */
class FakeElement {
	readonly children: FakeElement[] = [];
	parent: FakeElement | undefined;
	readonly style: Record<string, string> = {};
	readonly dataset: Record<string, string> = {};
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Set<(event: unknown) => void>>();
	readonly classes = new Set<string>();
	textContent = "";
	innerHTML = "";
	hidden = false;
	title = "";
	type = "";
	tabIndex = -1;
	width = 300;
	height = 150;
	readonly tagName: string;
	constructor(tagName: string) {
		this.tagName = tagName;
	}
	get className() {
		return [...this.classes].join(" ");
	}
	set className(value: string) {
		this.classes.clear();
		for (const c of value.split(/\s+/).filter(Boolean)) this.classes.add(c);
	}
	readonly classList = {
		add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
		remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
		toggle: (name: string, force?: boolean) => {
			const on = force ?? !this.classes.has(name);
			if (on) this.classes.add(name);
			else this.classes.delete(name);
			return on;
		},
		contains: (name: string) => this.classes.has(name),
	};
	get clientWidth() {
		return 0;
	}
	get clientHeight() {
		return 0;
	}
	append(...nodes: FakeElement[]) {
		for (const node of nodes) this.appendChild(node);
	}
	appendChild(node: FakeElement) {
		node.parent?.children.splice(node.parent.children.indexOf(node), 1);
		node.parent = this;
		this.children.push(node);
		return node;
	}
	replaceChildren(...nodes: FakeElement[]) {
		this.children.splice(0);
		this.append(...nodes);
	}
	remove() {
		this.parent?.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = undefined;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, String(value));
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	addEventListener(type: string, listener: (event: unknown) => void) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(listener);
	}
	removeEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.get(type)?.delete(listener);
	}
	querySelector() {
		return null;
	}
	querySelectorAll() {
		return [];
	}
	contains(node: FakeElement): boolean {
		return node === this || this.children.some((c) => c.contains(node));
	}
	focus() {}
	getBoundingClientRect() {
		return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height, x: 0, y: 0 };
	}
	getContext() {
		return new Proxy({}, { get: () => () => undefined });
	}
	/** Every element below this one, this one included. */
	all(): FakeElement[] {
		return [this, ...this.children.flatMap((c) => c.all())];
	}
}

let runs = 0;
const pages: { close: () => void }[] = [];
afterEach(() => {
	for (const page of pages.splice(0)) page.close();
});

/**
 * Loads the pinned `viewer.js` as a page at the launch's path would,
 * with the browser's globals made of records: `fetch` and `WebSocket` reach
 * only the adapter, every request the viewer makes is kept with its decoded
 * message, and every answer it reads is kept as text.
 */
async function openViewer(adapter: ViewerAdapter, l: Launch, options: { dpr?: number; width?: number; height?: number } = {}) {
	const g = globalThis as Record<string, any>;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const windowListeners = new Map<string, Set<(event: unknown) => void>>();
	const sent: { path: string; request?: Record<string, any> }[] = [];
	const seen: string[] = [];
	const sockets: { url: string; protocols: string[]; received: unknown[] }[] = [];
	const storage = new Map<string, string>();
	const location = { href: `${PAGE}${l.handle.viewerPath}`, hash: l.handle.viewerPath.slice(l.handle.viewerPath.indexOf("#")), search: "" };
	const window = {
		location,
		devicePixelRatio: options.dpr ?? 2,
		innerWidth: options.width ?? 1280,
		innerHeight: options.height ?? 800,
		sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) },
		setTimeout: (fn: () => void, ms?: number) => {
			const handle = setTimeout(() => {
				timers.delete(handle);
				fn();
			}, ms);
			timers.add(handle);
			return handle;
		},
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
			timers.delete(handle);
			clearTimeout(handle);
		},
		setInterval: (fn: () => void, ms?: number) => {
			const handle = setInterval(fn, ms);
			timers.add(handle);
			return handle;
		},
		clearInterval: (handle: ReturnType<typeof setTimeout>) => {
			timers.delete(handle);
			clearInterval(handle);
		},
		addEventListener: (type: string, listener: (event: unknown) => void) => {
			if (!windowListeners.has(type)) windowListeners.set(type, new Set());
			windowListeners.get(type)!.add(listener);
		},
		removeEventListener: (type: string, listener: (event: unknown) => void) => windowListeners.get(type)?.delete(listener),
	};
	const root = new FakeElement("div");
	const documentElement = new FakeElement("html");
	const define = (name: string, value: unknown) => Object.defineProperty(g, name, { value, configurable: true, writable: true });
	define("window", window);
	define("document", {
		getElementById: (id: string) => (id === "app" ? root : null),
		createElement: (tag: string) => new FakeElement(tag),
		documentElement,
		body: new FakeElement("body"),
		addEventListener: () => {},
		fullscreenElement: null,
		activeElement: null,
		title: "",
	});
	define("navigator", { platform: "Linux x86_64", userAgent: "stand-in" });
	define("history", {
		replaceState: (_state: unknown, _title: string, url: string) => {
			location.href = url;
			location.hash = new URL(url).hash;
		},
	});
	define("isSecureContext", true);
	define("CSS", { escape: (s: string) => s });
	define("getComputedStyle", () => ({ objectFit: "contain", getPropertyValue: () => "" }));
	// WebCodecs decodes H.264 here, so the viewer asks for it first, then PNG.
	define(
		"VideoDecoder",
		class {
			static isConfigSupported = async () => ({ supported: true });
			state = "unconfigured";
			decodeQueueSize = 0;
			configure() {}
			decode() {}
			close() {}
		},
	);
	define("fetch", async (input: string, init: RequestInit) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		const method = path.slice(path.indexOf("/", 1));
		const body = new Uint8Array(await request.clone().arrayBuffer());
		const schemas = RPC[method];
		sent.push({ path, request: schemas && body.byteLength >= 5 ? (fromBinary(schemas[0], body.subarray(5)) as Record<string, any>) : undefined });
		const response = await adapter.fetch(request);
		if (method !== "/cua.env.v1.PresenceService/Join") seen.push(new TextDecoder("latin1").decode(await response.clone().arrayBuffer()), JSON.stringify([...response.headers]));
		return response;
	});
	define(
		"WebSocket",
		class FakeWebSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;
			readyState = 0;
			binaryType = "blob";
			protocol = "";
			onopen: ((e: unknown) => void) | null = null;
			onmessage: ((e: { data: unknown }) => void) | null = null;
			onclose: ((e: { code: number }) => void) | null = null;
			onerror: ((e: unknown) => void) | null = null;
			private events: MediaEvents | undefined;
			constructor(url: string, protocols: string[]) {
				const record = { url, protocols, received: [] as unknown[] };
				sockets.push(record);
				const u = new URL(url);
				assert.equal(u.protocol, "wss:");
				const upgrade = adapter.media(u.pathname + u.search, protocols);
				setImmediate(() => {
					if (upgrade.status !== 101) return this.drop(1006);
					upgrade.attach((events) => {
						this.events = events;
						this.readyState = 1;
						this.protocol = upgrade.protocol;
						return {
							send: (data) => {
								const copy = typeof data === "string" ? data : data.slice().buffer;
								record.received.push(copy);
								if (typeof data === "string") seen.push(data);
								setImmediate(() => this.onmessage?.({ data: copy }));
							},
							close: (code) => this.drop(code),
							terminate: () => this.drop(1006),
							bufferedAmount: () => 0,
						};
					});
					this.onopen?.({});
				});
			}
			drop(code: number) {
				if (this.readyState === 3) return;
				this.readyState = 3;
				setImmediate(() => {
					this.onclose?.({ code });
					this.events?.closed(code);
				});
			}
			send(data: string | ArrayBuffer) {
				const events = this.events!;
				setImmediate(() => events.message(typeof data === "string" ? data : new Uint8Array(data)));
			}
			close(code = 1000) {
				this.drop(code);
			}
		},
	);
	// The viewer page fetches its script as a browser would, from the adapter.
	const page = await adapter.fetch(new Request(`${PAGE}/${l.id}/viewer/`));
	assert.equal(page.status, 200);
	assert.deepEqual(new Uint8Array(await page.arrayBuffer()), new Uint8Array(readFileSync(new URL("index.html", ASSETS))));
	const script = await adapter.fetch(new Request(`${PAGE}/${l.id}/viewer/viewer.js`));
	const scriptBytes = new Uint8Array(await script.arrayBuffer());
	assert.equal(createHash("sha256").update(scriptBytes).digest("hex"), VIEWER_ASSETS["viewer.js"].sha256);
	await import(`${new URL("viewer.js", ASSETS).href}?run=${++runs}`);
	const viewer = () => (window as Record<string, any>).__cuaViewer?.viewer;
	const handle = {
		root,
		window,
		sent,
		seen,
		sockets,
		viewer,
		fire: (type: string) => {
			for (const listener of [...(windowListeners.get(type) ?? [])]) listener({ type });
		},
		/** A toolbar button by its id. */
		button: (id: string) => root.all().find((e) => e.tagName === "button" && e.dataset.id === id),
		close: () => {
			viewer()?.session?.stop();
			for (const t of timers) clearTimeout(t);
			timers.clear();
		},
	};
	pages.push(handle);
	return handle;
}

// ------------------------------------------------------------------ tests

describe("the Cua viewer adapter", () => {
	it("lets the pinned viewer watch its display, view only, and change its capture size", async () => {
		const { upstream, adapter } = setup();
		const l = await launch(adapter);
		const page = await openViewer(adapter, l);
		await until(() => page.root.dataset.status === "streaming", "the viewer to stream");
		await until(() => upstream.presence.length === 1, "presence to join");

		// What the viewer itself asked for: an interactive session, as it does without `view_only=1`, and cursor shapes.
		const browserOpen = page.sent.find((s) => s.path.endsWith("/OpenMedia"))!.request!;
		assert.equal(browserOpen.policy, SessionPolicy.ALLOW_ACTIVATION);
		assert.deepEqual(browserOpen.target.target, { case: "displayId", value: "0" });
		assert.deepEqual(browserOpen.codecs, [MediaCodec.H264, MediaCodec.PNG]);
		assert.equal(page.sent.find((s) => s.path.endsWith("/ListTargets"))!.request!.includeWindows, false);
		assert.equal(page.sent.find((s) => s.path.endsWith("/Join"))!.request!.cursorShapes, true);

		// What spacesd was asked for: the configured display, view only, observe only, nothing else.
		assert.deepEqual(upstream.methods(), [
			"/cua.env.v1.SystemService/CreateViewerTicket",
			"/cua.env.v1.SystemService/GetCapabilities",
			"/cua.env.v1.StreamService/ListTargets",
			"/cua.env.v1.StreamService/OpenMedia",
			"/cua.env.v1.PresenceService/Join",
		]);
		const open = upstream.calls[3]!.request;
		assert.deepEqual(open.target.target, { case: "displayId", value: "primary" });
		assert.equal(open.policy, SessionPolicy.VIEW_ONLY);
		assert.equal(open.geometryControl, GeometryControl.OBSERVE_ONLY);
		assert.deepEqual(open.codecs, [MediaCodec.H264, MediaCodec.PNG]);
		assert.equal(open.preferQuic, false);
		assert.equal(open.maxDimension, 2560);
		assert.equal(open.ticketTtl.seconds, BigInt(MAX_MEDIA_TICKET_SECONDS));
		assert.equal(upstream.calls[2]!.request.includeWindows, false);
		const join = upstream.calls[4]!.request;
		assert.equal(join.cursorShapes, false);
		assert.equal(join.cursorDatagrams, false);
		for (const call of upstream.calls.slice(1)) {
			assert.equal(call.env, `Bearer ${VIEWER_TICKET}`);
			assert.equal(call.authorization, null);
		}

		// The viewer saw one display, no microphone, and a view-only session, so it built no input.
		const viewer = page.viewer();
		assert.equal(viewer.media.policy, SessionPolicy.VIEW_ONLY);
		assert.equal(viewer.input, null);
		assert.equal(viewer.uplink, null);
		assert.equal(page.button("keys")!.hidden, true);
		assert.equal(page.button("mic")!.hidden, true);

		// Its socket reached the adapter, never spacesd: spacesd's media ticket stayed behind it.
		const [socket] = page.sockets;
		assert.match(socket!.url, new RegExp(`^wss://pim\\.test/${l.id}/media\\?ticket=[A-Za-z0-9_-]{43}$`));
		assert.deepEqual(socket!.protocols, ["rcdp.v2"]);
		assert.equal(upstream.sockets.length, 1);
		const upstreamTicket = new URL(upstream.sockets[0]!.url).searchParams.get("ticket")!;
		assert.ok(!socket!.url.includes(percent(upstreamTicket)));

		// A resize asks for a new capture size for its own session, bounded.
		page.window.innerWidth = 1000;
		page.window.innerHeight = 700;
		page.fire("resize");
		await until(() => upstream.methods().includes("/cua.env.v1.StreamService/SetPreferences"), "the first SetPreferences");
		page.window.innerWidth = 3000;
		page.window.innerHeight = 1800;
		page.fire("resize");
		await until(() => upstream.methods().filter((m) => m.endsWith("/SetPreferences")).length === 2, "the second SetPreferences");
		const prefs = upstream.calls.filter((c) => c.method.endsWith("/SetPreferences")).map((c) => c.request);
		assert.deepEqual(
			prefs.map((p) => [p.mediaSessionId, p.maxDimension]),
			[
				["ms-1", 2000],
				["ms-1", MAX_DIMENSION],
			],
		);
		assert.deepEqual(
			page.sent.filter((s) => s.path.endsWith("/SetPreferences")).map((s) => s.request!.maxDimension),
			[2000, 6000],
		);

		// spacesd's capture changing size reaches the viewer's canvas.
		upstream.sockets[0]!.serve(JSON.stringify({ type: "lifecycle", payload: { session_id: "ms-1", event: { kind: "geometry_changed", geometry: { width_px: 1280, height_px: 720 } } } }));
		const canvas = page.root.all().find((e) => e.tagName === "canvas")!;
		await until(() => canvas.width === 1280 && canvas.height === 720, "the canvas to take the new size");

		// Neither spacesd's credentials nor its tickets reached anything the browser read.
		const visible = [l.handle.viewerPath, ...page.seen, ...page.sockets.map((s) => s.url)].join("\n");
		for (const secret of [ROOT, VIEWER_TICKET, upstreamTicket, percent(upstreamTicket)]) assert.ok(!visible.includes(secret), "a secret reached the browser");
		assert.ok(!visible.includes("w-secret") && !visible.includes("Private window"), "a window target reached the browser");

		// Leaving the page leaves presence by ending the stream; its Leave call goes nowhere.
		page.fire("pagehide");
		await until(() => upstream.presence[0]!.aborted, "the Join stream to end upstream");
		await until(() => l.handle.status().transports["presence-rpc"] === 0, "the presence stream to report closed");
		await until(() => page.sent.some((s) => s.path.endsWith(".PresenceService/Leave")), "the viewer's Leave");
		await settle();
		assert.ok(!upstream.methods().some((m) => m.endsWith("/Leave") || m.endsWith("/UpdateCursor")));
		assert.equal(upstream.geometry.calls + upstream.input.calls, 0);
		l.handle.end();
	});

	it("lets the pinned viewer open a new session when its media ticket runs out, without moving the launch's deadline, and refuses it once the launch ends", async () => {
		// spacesd's clock runs an hour behind the browser's, so every media ticket looks spent to the viewer and a dropped socket opens a new session.
		const { upstream, adapter } = setup({}, () => Date.now() - 3_600_000);
		const l = await launch(adapter);
		const page = await openViewer(adapter, l);
		await until(() => page.root.dataset.status === "streaming", "the viewer to stream");
		const before = l.handle.status().remainingMs;
		const firstPath = page.sockets[0]!.url.slice(page.sockets[0]!.url.indexOf("/media"));

		upstream.sockets[0]!.drop(1006);
		await until(() => upstream.sockets.length === 2 && page.root.dataset.status === "streaming", "the viewer to open a new session", 8_000);
		assert.deepEqual(
			upstream.calls.filter((c) => c.method === OPEN).map((c) => c.request.policy),
			[SessionPolicy.VIEW_ONLY, SessionPolicy.VIEW_ONLY],
		);
		assert.equal(upstream.sockets[1]!.session, "ms-2");
		// The first session was handed back and its socket path no longer attaches.
		await until(() => upstream.closed.includes("ms-1"), "CloseMedia for the first session");
		assert.equal(adapter.media(`/${l.id}${firstPath}`, ["rcdp.v2"]).status, 404);
		const status = l.handle.status();
		assert.ok(status.remainingMs < before, "a new session gave the launch no time");
		assert.equal(status.sessions, 1);

		l.handle.end();
		const opens = upstream.calls.filter((c) => c.method === OPEN).length;
		await until(() => page.sent.filter((s) => s.path.endsWith("/OpenMedia")).length > opens, "the viewer to try again", 8_000);
		assert.equal(upstream.calls.filter((c) => c.method === OPEN).length, opens, "a late OpenMedia reached spacesd");
		await until(() => l.handle.status().phase === "closed", "every transport to report closed");
		assert.equal(upstream.sockets.length, 2);
	});

	it("mints its viewer ticket view-only with every other grant named off, and never shows spacesd's credentials", async () => {
		const { upstream, adapter } = setup();
		const l = await launch(adapter, 90 * 60_000);
		const [mint] = upstream.calls;
		assert.equal(mint!.method, "/cua.env.v1.SystemService/CreateViewerTicket");
		assert.equal(mint!.authorization, `Bearer ${ROOT}`);
		assert.equal(mint!.env, null);
		const r = mint!.request;
		assert.equal(r.policy, SessionPolicy.VIEW_ONLY);
		assert.equal(r.clipboard, false);
		assert.equal(r.filesRoot, "");
		assert.equal(r.audioUplink, false);
		assert.equal(r.ttl.seconds, 5_400n);
		assert.match(r.principal.id, /^pim-[A-Za-z0-9_-]{16}$/);
		assert.ok(!r.principal.id.includes(l.id));
		// The root token is used for nothing else.
		await opened(adapter, l);
		assert.ok(upstream.calls.slice(1).every((c) => c.authorization === null && c.env === `Bearer ${VIEWER_TICKET}`));
		assert.ok(!l.handle.viewerPath.includes(ROOT) && !l.handle.viewerPath.includes(VIEWER_TICKET));

		// A grant with files, or none at all, starts no launch, and says nothing of spacesd's.
		for (const answer of [{ ticket: VIEWER_TICKET, filesRoot: "/home/user" }, { ticket: "" }]) {
			upstream.options.mintAnswer = answer;
			await assert.rejects(
				adapter.startLaunch({ lifetimeMs: 60_000, rootToken: ROOT }),
				(error: Error) => !error.message.includes(ROOT) && !error.message.includes(VIEWER_TICKET) && /view-only viewer ticket/.test(error.message),
			);
		}
		upstream.options.mintAnswer = undefined;
		await assert.rejects(adapter.startLaunch({ lifetimeMs: 60_000, rootToken: "wrong" }), (error: Error) => !error.message.includes("wrong"));

		// The browser can't mint a ticket, or reach any other service.
		const before = upstream.calls.length;
		for (const path of [
			"/cua.env.v1.SystemService/CreateViewerTicket",
			"/cua.env.v1.SystemService/Health",
			"/cua.env.v1.ComputerService/GetClipboard",
			"/cua.env.v1.ComputerService/SetClipboard",
			"/cua.env.v1.ComputerService/Click",
			"/cua.env.v1.FilesystemService/ReadFile",
			"/cua.env.v1.FilesystemService/BeginUpload",
			"/cua.env.v1.ProcessService/Exec",
			"/cua.env.v1.TunnelService/Forward",
			"/cua.env.v1.VolumeService/Mount",
			"/cua.env.v1.PresenceService/UpdateCursor",
			"/cua.env.v1.PresenceService/Leave",
			"/cua.env.v1.StreamService/toString",
		]) {
			assert.equal((await rpc(adapter, l, OPEN, {}, { path: `/${l.id}${path}` })).http, 404, path);
		}
		for (const path of ["/mcp", `/${l.id}/mcp`, `/${l.id}/files`, `/${l.id}/tunnel`, `/${l.id}/hotspot`, `/${l.id}/volume`, `/${l.id}/media`, `/${l.id}/viewer`, `/${l.id}/viewer/other.js`, `/${l.id}/viewer/toString`, `/${l.id}/viewer/%2e%2e/mcp`, `/${l.id}/cua.env.v1.StreamService/OpenMedia/x`, "/cua.env.v1.StreamService/OpenMedia"]) {
			const response = await adapter.fetch(new Request(`${PAGE}${path}`, { method: "POST", headers: { "x-cua-env-authorization": `Bearer ${l.credential}` }, body: "x" }));
			assert.equal(response.status, 404, path);
			assert.equal(response.headers.get("location"), null);
		}
		assert.equal((await adapter.fetch(new Request(`${PAGE}/${l.id}/viewer/?base=https://elsewhere.test/`))).status, 404);
		assert.equal((await rpc(adapter, l, OPEN, openInit(), { httpMethod: "GET" })).http, 405);
		assert.equal(upstream.calls.length, before, "a refused path reached spacesd");
	});

	it("refuses window targets, bidirectional geometry, side channels and malformed gRPC-Web before anything reaches spacesd", async () => {
		const { upstream, adapter } = setup();
		const l = await launch(adapter);
		assert.equal((await rpc(adapter, l, "/cua.env.v1.StreamService/ListTargets", {})).code, 0);
		const before = upstream.calls.length;
		const target = (value: object) => ({ target: value });
		const refusals: [string, object][] = [
			["a window target", openInit(target({ target: { case: "window", value: { id: "w-secret", epoch: 1n } } }))],
			["a window target with bidirectional geometry", openInit({ ...target({ target: { case: "window", value: { id: "w-secret", epoch: 1n } } }), geometryControl: GeometryControl.BIDIRECTIONAL })],
			["bidirectional geometry", openInit({ geometryControl: GeometryControl.BIDIRECTIONAL })],
			["an unknown geometry control", openInit({ geometryControl: 7 })],
			["an unknown policy", openInit({ policy: 9 })],
			["another display", openInit(target({ target: { case: "displayId", value: "1" } }))],
			["no target", openInit({ target: undefined })],
			["QUIC", openInit({ preferQuic: true })],
			["no video", openInit({ disableVideo: true })],
			["another participant's input", openInit({ presenceParticipantId: "p-agent" })],
			["a microphone", openInit({ audio: { enabled: true, uplink: { enabled: true } } })],
			["an empty microphone request", openInit({ audio: { enabled: true, uplink: {} } })],
			["chosen audio sources", openInit({ audio: { enabled: true, sourceIds: ["firefox"] } })],
			["raw frames", openInit({ codecs: [MediaCodec.BGRA] })],
			["no codec", openInit({ codecs: [] })],
			["a bitrate out of range", openInit({ bitrateKbps: 100_001 })],
			["a negative ticket lifetime", openInit({ ticketTtl: { seconds: -1n, nanos: 0 } })],
		];
		for (const [what, init] of refusals) {
			const answer = await rpc(adapter, l, OPEN, init);
			assert.ok(answer.code !== 0 && answer.code !== undefined, what);
		}

		// Encodings protobuf itself would take, keeping the last of each.
		const w = () => new BinaryWriter();
		const display = w().tag(1, WireType.LengthDelimited).string("0").finish();
		const window = w().tag(2, WireType.LengthDelimited).bytes(w().tag(1, WireType.LengthDelimited).string("w-secret").finish()).finish();
		const both = new Uint8Array([...display, ...window]);
		const valid = bytesOf(RPC[OPEN]![0], openInit());
		const encodings: [string, Uint8Array][] = [
			["both members of the target's oneof", w().tag(1, WireType.LengthDelimited).bytes(both).finish()],
			["the target twice", w().tag(1, WireType.LengthDelimited).bytes(display).tag(1, WireType.LengthDelimited).bytes(window).finish()],
			["the policy twice", new Uint8Array([...valid, ...w().tag(6, WireType.Varint).int32(SessionPolicy.VIEW_ONLY).finish()])],
			["geometry control twice", new Uint8Array([...bytesOf(RPC[OPEN]![0], openInit({ geometryControl: GeometryControl.OBSERVE_ONLY })), ...w().tag(7, WireType.Varint).int32(GeometryControl.BIDIRECTIONAL).finish()])],
			["an unknown field", new Uint8Array([...valid, ...w().tag(99, WireType.Varint).int32(1).finish()])],
			["a field with the wrong wire type", new Uint8Array([...valid, ...w().tag(9, WireType.LengthDelimited).bytes(new Uint8Array([1])).finish()])],
			["a truncated message", valid.subarray(0, valid.byteLength - 1)],
		];
		for (const [what, payload] of encodings) assert.equal((await rpc(adapter, l, OPEN, payload)).code, 3, what);

		const bodies: [string, Uint8Array<ArrayBuffer>, Record<string, string>?][] = [
			["a compressed frame", (() => {
				const f = frame(0, valid);
				f[0] = 1;
				return f;
			})()],
			["a trailer frame", frame(0x80, valid)],
			["two frames", new Uint8Array([...frame(0, valid), ...frame(0, valid)])],
			["a frame longer than its body", frame(0, valid).subarray(0, 20)],
			["a body over the bound", frame(0, new Uint8Array(8 * 1024))],
			["gzip", frame(0, valid), { "grpc-encoding": "gzip" }],
			["another content type", frame(0, valid), { "content-type": "application/grpc-web-text" }],
			["no credential", frame(0, valid), { "x-cua-env-authorization": "" }],
			["a credential beside an authorization header", frame(0, valid), { authorization: `Bearer ${l.credential}` }],
			["spacesd's own ticket", frame(0, valid), { "x-cua-env-authorization": `Bearer ${VIEWER_TICKET}` }],
		];
		for (const [what, body, headers] of bodies) {
			const answer = await rpc(adapter, l, OPEN, {}, { body, headers });
			assert.ok(answer.http !== 200 || (answer.code !== 0 && answer.code !== undefined), what);
		}
		// ListTargets may not list windows.
		assert.equal((await rpc(adapter, l, "/cua.env.v1.StreamService/ListTargets", { includeWindows: true })).code, 7);
		assert.equal((await rpc(adapter, l, "/cua.env.v1.StreamService/ListTargets", { windowFilter: {} })).code, 7);
		// Presence may not name a principal or ask for QUIC datagrams.
		assert.equal((await rpc(adapter, l, "/cua.env.v1.PresenceService/Join", { principal: { id: "agent" } })).code, 7);
		assert.equal((await rpc(adapter, l, "/cua.env.v1.PresenceService/Join", { cursorDatagrams: true })).code, 7);

		assert.equal(upstream.calls.length, before, "a refused request reached spacesd");
		assert.equal(upstream.geometry.calls, 0);

		// What the adapter does send is bounded.
		const big = await rpc(adapter, l, OPEN, openInit({ maxFps: 240, maxDimension: 0, bitrateKbps: 100_000, ticketTtl: { seconds: 86_400n, nanos: 0 }, audio: { enabled: true, encoding: { codecs: [1], frameMs: 20 } } }));
		assert.equal(big.code, 0);
		const sent = upstream.calls.at(-1)!.request;
		assert.deepEqual([sent.maxFps, sent.maxDimension, sent.bitrateKbps, sent.ticketTtl.seconds], [60, MAX_DIMENSION, 20_000, 600n]);
		assert.deepEqual([sent.audio.enabled, sent.audio.sourceIds, sent.audio.uplink], [true, [], undefined]);
	});

	it("refuses spacesd answers that would grant more than watching the display, and hands such sessions back", async () => {
		const { upstream, adapter } = setup();
		const l = await launch(adapter);
		assert.equal((await rpc(adapter, l, "/cua.env.v1.StreamService/ListTargets", {})).code, 0);
		const bad: [string, (own: Record<string, any>) => object][] = [
			["an interactive policy", (own) => ({ ...own, policy: SessionPolicy.ALLOW_ACTIVATION })],
			["bidirectional geometry", (own) => ({ ...own, geometryControl: GeometryControl.BIDIRECTIONAL })],
			["a QUIC endpoint", (own) => ({ ...own, quic: { port: 3212 } })],
			["a granted microphone", (own) => ({ ...own, audio: { uplink: { granted: true } } })],
			["another socket path", (own) => ({ ...own, wsPath: `/tunnel?ticket=${percent(own.ticket)}` })],
			["another host", (own) => ({ ...own, wsPath: `//evil.test/media?ticket=${percent(own.ticket)}` })],
			["a path with traversal", (own) => ({ ...own, wsPath: `/../media?ticket=${percent(own.ticket)}` })],
			["a ticket that has expired", (own) => ({ ...own, ticketExpiresAt: { seconds: 1n, nanos: 0 } })],
			["a codec it wasn't asked for", (own) => ({ ...own, codec: MediaCodec.BGRA })],
		];
		for (const [what, answer] of bad) {
			upstream.options.openAnswer = answer;
			const sessionId = `ms-${upstream.calls.filter((c) => c.method === OPEN).length + 1}`;
			assert.equal((await rpc(adapter, l, OPEN, openInit())).code, 13, what);
			await until(() => upstream.closed.includes(sessionId), `CloseMedia for ${what}`);
		}
		assert.equal(l.handle.status().sessions, 0);
		assert.equal(upstream.sockets.length, 0);
	});

	it("relays only keyframe requests and frame acks up a media socket, and ends it on input, actions or geometry", async () => {
		const { upstream, adapter } = setup();
		const l = await launch(adapter);
		const media = await opened(adapter, l);
		assert.equal(media.ticket, "");
		const forbidden = [
			JSON.stringify({ type: "set_window_geometry", payload: { session_id: "ms-1", revision: 1, width_points: 800, height_points: 600 } }),
			JSON.stringify({ type: "interactive_input", payload: { session_id: "ms-1", first_sequence: 1, events: [{ kind: "key", key: "a" }] } }),
			JSON.stringify({ type: "action", payload: { session_id: "ms-1", action: { kind: "click" } } }),
			JSON.stringify({ type: "request_keyframe", payload: { session_id: "ms-other" } }),
			JSON.stringify({ type: "frame_ack", payload: { session_id: "ms-1", sequence: 1, decode_queue: 0, extra: true } }),
			JSON.stringify({ type: "audio_uplink_state", payload: { track_id: 1, muted: false } }),
			new Uint8Array([0x52, 0x41, 0x55, 0x32]),
		];
		for (const message of forbidden) {
			const socket = browserSocket(adapter, mediaTarget(l, media.wsPath));
			assert.equal(socket.status, 101);
			await until(() => socket.received.length === 2, "hello and session_opened");
			socket.events!.message(JSON.stringify({ type: "request_keyframe", payload: { session_id: "ms-1" } }));
			socket.events!.message(JSON.stringify({ type: "frame_ack", payload: { session_id: "ms-1", sequence: 7, decode_queue: 1 } }));
			socket.events!.message(message);
			await until(() => socket.closedWith.length === 1, "the relay to end");
			assert.deepEqual(socket.closedWith, [1008]);
			const up = upstream.sockets.at(-1)!;
			await until(() => up.closed, "the upstream half to end");
			assert.deepEqual(
				up.received.map((d) => JSON.parse(d as string).type),
				["request_keyframe", "frame_ack"],
			);
		}
		assert.equal(upstream.geometry.calls, 0);
		assert.equal(upstream.input.calls, 0);
		await until(() => l.handle.status().transports["media-viewer"] + l.handle.status().transports["media-upstream"] === 0, "every half to report closed");

		// A session_opened that isn't this view-only display session ends the relay and hands the session back.
		for (const [what, payload] of [
			["an interactive policy", { policy: "allow_activation" }],
			["bidirectional geometry", { geometry_control: "bidirectional" }],
			["a window", { target: { kind: "window", handle: 7, epoch: 1 } }],
			["another display", { target: { kind: "display", display_id: "1" } }],
		] as const) {
			const fresh = await rpc(adapter, l, OPEN, openInit());
			const id = fresh.message!.mediaSessionId;
			upstream.options.sessionOpened = (session) => ({ session_id: session, target: { kind: "display", display_id: "0" }, policy: "view_only", ...payload });
			const socket = browserSocket(adapter, mediaTarget(l, fresh.message!.wsPath));
			await until(() => socket.closedWith.length === 1, `the relay to end on ${what}`);
			assert.deepEqual(socket.closedWith, [4404], what);
			assert.equal(socket.received.filter((d) => typeof d === "string" && d.includes("session_opened")).length, 0, what);
			await until(() => upstream.closed.includes(id), `CloseMedia on ${what}`);
		}
		upstream.options.sessionOpened = undefined;
		// Packets before the session opened end it too.
		const fresh = await rpc(adapter, l, OPEN, openInit());
		const socket = browserSocket(adapter, mediaTarget(l, fresh.message!.wsPath));
		await until(() => upstream.sockets.length > 0 && upstream.sockets.at(-1)!.session === fresh.message!.mediaSessionId, "the upstream half");
		upstream.sockets.at(-1)!.serve(new Uint8Array([1, 2, 3]));
		await until(() => socket.closedWith.length === 1, "the relay to end");
		assert.equal(upstream.geometry.calls + upstream.input.calls, 0);
	});

	it("refuses another launch's credential, session ids and socket paths", async () => {
		const { upstream, adapter } = setup();
		const a = await launch(adapter);
		const b = await launch(adapter);
		const mediaA = await opened(adapter, a);
		assert.equal((await rpc(adapter, b, "/cua.env.v1.StreamService/ListTargets", {})).code, 0);
		const before = upstream.calls.length;
		// A's credential on B's path.
		assert.equal((await rpc(adapter, { ...b, credential: a.credential }, "/cua.env.v1.StreamService/ListTargets", {})).code, 16);
		// A's session through B.
		for (const method of ["/cua.env.v1.StreamService/SetPreferences", "/cua.env.v1.StreamService/RequestKeyframe", "/cua.env.v1.StreamService/CloseMedia"]) {
			assert.equal((await rpc(adapter, b, method, { mediaSessionId: mediaA.mediaSessionId, maxDimension: 1000 })).code, 5, method);
		}
		// A session that is no one's.
		assert.equal((await rpc(adapter, a, "/cua.env.v1.StreamService/RequestKeyframe", { mediaSessionId: "ms-99" })).code, 5);
		// SetPreferences touches only the capture.
		assert.equal((await rpc(adapter, a, "/cua.env.v1.StreamService/SetPreferences", { mediaSessionId: mediaA.mediaSessionId, audioUplinkMuted: false })).code, 3);
		assert.equal(upstream.calls.length, before, "a replayed id reached spacesd");
		// A's socket path under B, a made-up one, and one offering no wire protocol.
		assert.equal(adapter.media(mediaTarget(b, mediaA.wsPath), ["rcdp.v2"]).status, 404);
		assert.equal(adapter.media(`/${a.id}/media?ticket=${"A".repeat(43)}`, ["rcdp.v2"]).status, 404);
		assert.equal(adapter.media(mediaTarget(a, mediaA.wsPath), ["rcdp.v1"]).status, 400);
		assert.equal(adapter.media(`${mediaTarget(a, mediaA.wsPath)}&ticket=x`, ["rcdp.v2"]).status, 404);
		// spacesd's own media ticket is no socket path.
		assert.equal(adapter.media(`/${a.id}/media?ticket=${percent("v1.media-1+//.sig")}`, ["rcdp.v2"]).status, 404);
		// A launch that has ended is gone, its credential and its sockets with it.
		a.handle.end();
		assert.equal((await rpc(adapter, a, "/cua.env.v1.StreamService/ListTargets", {})).http, 404);
		assert.equal(adapter.media(mediaTarget(a, mediaA.wsPath), ["rcdp.v2"]).status, 404);
		assert.equal((await adapter.fetch(new Request(`${PAGE}/${a.id}/viewer/`))).status, 404);
		// B still works.
		assert.equal((await rpc(adapter, b, "/cua.env.v1.SystemService/GetCapabilities", {})).code, 0);
	});

	it("closes every half it owns at the launch's deadline while the media ticket is still valid, and refuses what comes late", async () => {
		const time = manualTime();
		const wall = 1_800_000_000_000;
		const { upstream, adapter } = setup({ clock: time.clock, timers: time.timers }, () => wall);
		const l = await launch(adapter, 60_000);
		const media = await opened(adapter, l);
		const socket = browserSocket(adapter, mediaTarget(l, media.wsPath));
		await until(() => socket.received.length === 2, "the relay to open");
		const join = await adapter.fetch(
			new Request(`${PAGE}/${l.id}/cua.env.v1.PresenceService/Join`, {
				method: "POST",
				headers: { "content-type": GRPC, "x-cua-env-authorization": `Bearer ${l.credential}` },
				body: frame(0, new Uint8Array()),
			}),
		);
		const reader = join.body!.getReader();
		assert.equal((await reader.read()).done, false);
		assert.deepEqual(l.handle.status().transports, { "media-viewer": 1, "media-upstream": 1, "presence-rpc": 1 });
		// The media ticket was given no more than the launch's minute.
		assert.ok(Number(media.ticketExpiresAt.seconds) * 1000 <= wall + 60_000);
		assert.equal(upstream.calls.find((c) => c.method === OPEN)!.request.ticketTtl.seconds, 60n);

		time.advance(60_000);
		// spacesd's clock hasn't reached the media ticket's expiry: it would still let a socket attach, and the launch closes everything anyway.
		assert.ok(Number(media.ticketExpiresAt.seconds) * 1000 > wall);
		assert.equal(l.handle.status().phase, "closing");
		assert.equal(l.handle.status().reason, "expired");
		assert.equal(socket.terminated, 1);
		assert.equal(upstream.sockets[0]!.terminated, 1);
		await until(() => upstream.presence[0]!.aborted, "the Join stream to end upstream");
		await assert.rejects(reader.read());
		// Requested is not observed: until each half reports itself closed, the launch is closing.
		await until(() => l.handle.status().phase === "closed", "every half to report closed");
		await until(() => l.handle.status().cleanup.answered === 1, "CloseMedia to be answered");
		assert.deepEqual(upstream.closed, ["ms-1"]);
		assert.deepEqual(l.handle.status().cleanup, { requested: 1, answered: 1, failed: 0 });

		const calls = upstream.calls.length;
		assert.equal((await rpc(adapter, l, OPEN, openInit())).http, 404);
		assert.equal(adapter.media(mediaTarget(l, media.wsPath), ["rcdp.v2"]).status, 404);
		assert.equal(upstream.calls.length, calls);
	});

	it("refuses opens that finish after the launch ended, and counts what they opened until it reports closed", async () => {
		const time = manualTime();
		const { upstream, adapter } = setup({ clock: time.clock, timers: time.timers });
		const l = await launch(adapter, 60_000);
		assert.equal((await rpc(adapter, l, "/cua.env.v1.StreamService/ListTargets", {})).code, 0);

		// An OpenMedia spacesd answers after the deadline: the browser gets nothing, and spacesd is asked to close the session.
		let release!: () => void;
		upstream.options.openGate = new Promise((resolve) => (release = resolve));
		const late = rpc(adapter, l, OPEN, openInit());
		await until(() => upstream.calls.some((c) => c.method === OPEN), "OpenMedia upstream");
		time.advance(60_000);
		release();
		const answer = await late;
		assert.notEqual(answer.code, 0);
		await until(() => upstream.closed.includes("ms-1"), "CloseMedia for the late session");

		// A media socket spacesd opens after the deadline is closed at once, through the launch, and counted until it reports closed.
		const second = await launch(adapter, 60_000);
		upstream.options.openGate = undefined;
		const media = await opened(adapter, second);
		let open!: () => void;
		upstream.options.mediaGate = new Promise((resolve) => (open = resolve));
		upstream.options.closesAtOnce = true;
		const socket = browserSocket(adapter, mediaTarget(second, media.wsPath));
		assert.equal(socket.status, 101);
		await settle();
		second.handle.end();
		assert.equal(socket.terminated, 1);
		open();
		await until(() => upstream.sockets.length === 1, "the late upstream socket");
		assert.equal(upstream.sockets[0]!.terminated, 1);
		// It reported itself closed from inside its own close, before `adopt` returned.
		await until(() => second.handle.status().phase === "closed", "every half to report closed");
		assert.equal(second.handle.status().refused, 0);
	});

	it("lets no new socket attach on a media ticket that has expired, and leaves the attached one open", async () => {
		let wall = 1_800_000_000_000;
		const { upstream, adapter } = setup({}, () => wall);
		const l = await launch(adapter);
		const media = await opened(adapter, l);
		const socket = browserSocket(adapter, mediaTarget(l, media.wsPath));
		await until(() => socket.received.length === 2, "the relay to open");
		wall += 601_000;
		assert.equal(adapter.media(mediaTarget(l, media.wsPath), ["rcdp.v2"]).status, 401);
		upstream.sockets[0]!.serve(new Uint8Array([9, 9, 9]));
		await until(() => socket.received.length === 3, "a packet after expiry");
		assert.equal(socket.closedWith.length, 0);
		assert.equal(l.handle.status().transports["media-viewer"], 1);
		// The same session's socket path, attached again while one is open, replaces it: one relay per session.
		wall -= 601_000;
		const again = browserSocket(adapter, mediaTarget(l, media.wsPath));
		await until(() => again.received.length === 2, "the second relay to open");
		assert.deepEqual(socket.closedWith, [4404]);
		l.handle.end();
	});

	it("keeps presence to the launch's display, without cursor shapes, datagrams or windows", async () => {
		const { upstream, adapter } = setup();
		const l = await launch(adapter);
		assert.equal((await rpc(adapter, l, "/cua.env.v1.StreamService/ListTargets", {})).code, 0);
		const cursor = (displayId: string, extra: object = {}) => ({ displayId, position: { x: 0.5, y: 0.5 }, visible: true, ...extra });
		upstream.options.joined = {
			case: "joined",
			value: {
				participant: { participantId: "p-viewer", principal: { id: "viewer:pim", displayName: "Pim viewer" } },
				roster: [
					{ participant: { participantId: "p-agent" }, cursor: cursor("0") },
					{ participant: { participantId: "p-other" }, cursor: cursor("1") },
				],
				datagrams: { endpoint: { port: 3212 }, ticket: "pt-secret" },
			},
		};
		// Joined as the viewer joins: asking for cursor shapes, batches and roster heartbeats.
		const body = await adapter.fetch(
			new Request(`${PAGE}/${l.id}/cua.env.v1.PresenceService/Join`, {
				method: "POST",
				headers: { "content-type": GRPC, "x-cua-env-authorization": `Bearer ${l.credential}` },
				body: frame(0, bytesOf(RPC["/cua.env.v1.PresenceService/Join"]![0], { cursorShapes: true, cursorBatches: true, rosterInterval: { seconds: 5n, nanos: 0 } })),
			}),
		);
		const second = upstream.presence[0]!;
		assert.deepEqual([second.call.request.cursorShapes, second.call.request.cursorDatagrams, second.call.request.principal], [false, false, undefined]);
		second.push({ case: "cursorMoved", value: { participantId: "p-agent", cursor: cursor("0") } });
		second.push({ case: "cursorMoved", value: { participantId: "p-other", cursor: cursor("1") } });
		second.push({ case: "cursorMoved", value: { participantId: "p-window", cursor: cursor("0", { window: { id: "w-secret", epoch: 1n } }) } });
		second.push({ case: "cursorBatch", value: { moves: [{ participantId: "p-agent", cursor: cursor("") }, { participantId: "p-other", cursor: cursor("1") }], tick: 3n } });
		second.push({ case: "participantLeft", value: { participantId: "p-other", reason: 2 } });
		second.end(0);
		const parts = parseFrames(new Uint8Array(await body.arrayBuffer()));
		const events = parts.filter((p) => p.flag === 0).map((p) => (fromBinary(RPC["/cua.env.v1.PresenceService/Join"]![1], p.payload) as Record<string, any>).event);
		assert.deepEqual(
			events.map((e) => e.case),
			["joined", "cursorMoved", "cursorBatch", "participantLeft"],
		);
		assert.equal(events[0].value.datagrams, undefined);
		assert.deepEqual(
			events[0].value.roster.map((r: Record<string, any>) => [r.participant.participantId, r.cursor?.displayId]),
			[
				["p-agent", "0"],
				["p-other", undefined],
			],
		);
		assert.equal(events[1].value.participantId, "p-agent");
		assert.deepEqual(
			events[2].value.moves.map((m: Record<string, any>) => m.participantId),
			["p-agent"],
		);
		assert.match(new TextDecoder().decode(parts.at(-1)!.payload), /grpc-status: 0/);
		assert.ok(!Buffer.concat(parts.map((p) => p.payload)).toString("latin1").includes("pt-secret"));
		l.handle.end();
	});

	it("serves the pinned viewer's files byte for byte, and decodes with the schema that viewer carries", async () => {
		const { adapter } = setup();
		const l = await launch(adapter);
		const bundle = readFileSync(new URL("viewer.js", ASSETS), "latin1");
		for (const [name, descriptor] of Object.entries(DESCRIPTORS)) assert.ok(bundle.includes(`"${descriptor}"`), `the viewer carries ${name}'s descriptor`);
		for (const [name, pinned] of Object.entries(VIEWER_ASSETS)) {
			const response = await adapter.fetch(new Request(`${PAGE}/${l.id}/viewer/${name}`));
			assert.equal(response.status, 200, name);
			assert.equal(response.headers.get("content-type"), pinned.type);
			assert.equal(response.headers.get("x-content-type-options"), "nosniff");
			assert.equal(createHash("sha256").update(new Uint8Array(await response.arrayBuffer())).digest("hex"), pinned.sha256, name);
		}
		const page = await adapter.fetch(new Request(`${PAGE}/${l.id}/viewer/`));
		assert.match(page.headers.get("content-security-policy")!, /connect-src 'self'/);
		assert.equal((await adapter.fetch(new Request(`${PAGE}/${l.id}/viewer/`, { method: "POST", body: "x" }))).status, 405);
		assert.match(readFileSync(new URL("../cua-viewer/LICENSE", import.meta.url), "utf8"), /^# Functional Source License, Version 1\.1, MIT Future License/);
		assert.equal(CUA_COMMIT, "fca21937bc4e1420a23d544d11dbdf987f0266e6");
		l.handle.end();
	});

	it("holds a presence stream it is still opening until spacesd's answer settles, and cancels a body that comes late", async () => {
		/** spacesd's Join answers only when the test says, with a body whose cancel does what the test says. */
		const pending: { signal: AbortSignal; answer: (cancel: () => Promise<void>) => { cancelled: () => number }; fail: () => void }[] = [];
		const wrap = (fetch: Fetch): Fetch => async (url, init) => {
			if (!url.endsWith(".PresenceService/Join")) return fetch(url, init);
			return new Promise<Response>((resolve, reject) => {
				pending.push({
					signal: init.signal!,
					answer: (cancel) => {
						let cancels = 0;
						const body = new ReadableStream<Uint8Array>({
							cancel: () => {
								cancels++;
								return cancel();
							},
						});
						resolve(new Response(body, { status: 200, headers: { "content-type": GRPC } }));
						return { cancelled: () => cancels };
					},
					fail: () => reject(new Error("aborted")),
				});
			});
		};
		const { adapter } = setup({}, Date.now, wrap);
		const join = (l: Launch, signal?: AbortSignal) =>
			adapter.fetch(new Request(`${PAGE}/${l.id}/cua.env.v1.PresenceService/Join`, { method: "POST", headers: { "content-type": GRPC, "x-cua-env-authorization": `Bearer ${l.credential}` }, body: frame(0, new Uint8Array()), signal }));
		const code = async (r: Promise<Response>) => (await r).headers.get("grpc-status");
		const presence = (l: Launch) => l.handle.status().transports["presence-rpc"];

		// The launch ends while spacesd hasn't answered; spacesd answers anyway, and the body it sends is cancelled before the stream counts as closed.
		const a = await launch(adapter);
		const answerA = join(a);
		await until(() => pending.length === 1, "the Join upstream");
		a.handle.end();
		assert.equal(pending[0]!.signal.aborted, true);
		assert.deepEqual([a.handle.status().phase, presence(a)], ["closing", 1]);
		let release!: () => void;
		const late = pending[0]!.answer(() => new Promise((resolve) => (release = resolve)));
		assert.equal(await code(answerA), "9");
		await settle();
		assert.equal(late.cancelled(), 1);
		// A cancel still pending is not a closure.
		assert.deepEqual([a.handle.status().phase, presence(a)], ["closing", 1]);
		release();
		await until(() => a.handle.status().phase === "closed", "the late body's cancel to settle");
		assert.equal(presence(a), 0);
		assert.equal(late.cancelled(), 1);

		// A cancel that fails is not a closure either: the stream stays counted, and says so.
		const b = await launch(adapter);
		const answerB = join(b);
		await until(() => pending.length === 2, "the second Join upstream");
		b.handle.end();
		const failing = pending[1]!.answer(() => Promise.reject(new Error("cancel failed")));
		assert.equal(await code(answerB), "9");
		await settle();
		assert.equal(failing.cancelled(), 1);
		assert.deepEqual([b.handle.status().phase, presence(b), b.handle.status().unconfirmed], ["closing", 1, 1]);

		// An open that fails after the launch ended settles it.
		const c = await launch(adapter);
		const answerC = join(c);
		await until(() => pending.length === 3, "the third Join upstream");
		c.handle.end();
		assert.equal(c.handle.status().phase, "closing");
		pending[2]!.fail();
		assert.equal(await code(answerC), "14");
		await until(() => c.handle.status().phase === "closed", "the failed open to settle");

		// The browser leaving while spacesd hasn't answered: the open is aborted, a body that comes anyway is cancelled, and the launch goes on.
		const d = await launch(adapter);
		const leaving = new AbortController();
		const answerD = join(d, leaving.signal).catch(() => undefined);
		await until(() => pending.length === 4, "the fourth Join upstream");
		leaving.abort();
		assert.equal(pending[3]!.signal.aborted, true);
		assert.equal(presence(d), 1);
		const ignored = pending[3]!.answer(() => Promise.resolve());
		await answerD;
		await until(() => presence(d) === 0, "the ignored body's cancel");
		assert.equal(ignored.cancelled(), 1);
		const e = join(d, AbortSignal.abort()).catch(() => undefined);
		await e;
		await settle();
		assert.equal(presence(d), 0);
		// The launch's own count is exact: two streams may open, and a third may not.
		const first = join(d);
		const second = join(d);
		await until(() => pending.length === 6, "two more Joins upstream");
		assert.equal(await code(join(d)), "8");
		pending[4]!.answer(() => Promise.resolve());
		pending[5]!.answer(() => Promise.resolve());
		assert.equal((await first).status, 200);
		assert.equal((await second).status, 200);
		assert.equal(d.handle.status().phase, "live");
		d.handle.end();
		await until(() => d.handle.status().phase === "closed", "both streams to close");
	});

	it("reads presence frame by frame, holding at most one chunk and one partial frame", async () => {
		let chunks: Uint8Array[] = [];
		/** Whether the body stays open, sending nothing more, once its chunks run out. */
		let hold = false;
		const wrap = (fetch: Fetch): Fetch => async (url, init) => {
			if (!url.endsWith(".PresenceService/Join")) return fetch(url, init);
			const body = new ReadableStream<Uint8Array>({
				pull: (controller) => {
					const next = chunks.shift();
					if (next) controller.enqueue(next);
					else if (hold) return new Promise<void>(() => {});
					else controller.close();
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": GRPC } });
		};
		const { adapter } = setup({}, Date.now, wrap);
		const l = await launch(adapter);
		const schema = RPC["/cua.env.v1.PresenceService/Join"]![1];
		const event = (participantIds: string[]) => frame(0, bytesOf(schema, { event: { case: "rosterHeartbeat", value: { participantIds } } }));
		const read = async () => {
			const response = await adapter.fetch(new Request(`${PAGE}/${l.id}/cua.env.v1.PresenceService/Join`, { method: "POST", headers: { "content-type": GRPC, "x-cua-env-authorization": `Bearer ${l.credential}` }, body: frame(0, new Uint8Array()) }));
			try {
				return { frames: parseFrames(new Uint8Array(await response.arrayBuffer())), failed: false };
			} catch {
				return { frames: [], failed: true };
			}
		};
		// One frame a byte at a time, then many frames, more than the bound in all, in one chunk.
		const one = event(["p-a"]);
		const many = Array.from({ length: 40 }, (_, i) => event([`p-${i}`, "x".repeat(2_000)]));
		const joined = Buffer.concat([...many, trailer(0)]);
		assert.ok(joined.byteLength > 64 * 1024);
		chunks = [...[...one].map((b) => new Uint8Array([b])), new Uint8Array(joined)];
		const ok = await read();
		assert.equal(ok.failed, false);
		assert.equal(ok.frames.filter((f) => f.flag === 0).length, 41);
		assert.match(new TextDecoder().decode(ok.frames.at(-1)!.payload), /grpc-status: 0/);
		// A frame that says it is larger than the bound ends the stream when its header arrives, without waiting for or holding its body, which never comes.
		const huge = new Uint8Array(5);
		new DataView(huge.buffer).setUint32(1, 1 << 30);
		chunks = [one, huge];
		hold = true;
		const refused = await Promise.race([read(), new Promise<undefined>((resolve) => setTimeout(resolve, 2_000))]);
		assert.ok(refused, "the stream waited for the oversized frame's body");
		assert.equal(refused.failed, true);
		await until(() => l.handle.status().transports["presence-rpc"] === 0, "both streams to report closed");
		l.handle.end();
	});

	it("reads the launch's clock on every media message, so a timer that runs late lets nothing through", async () => {
		// Timers that never fire: only the clock tells the relay its launch has ended.
		const inert: Timers = { set: () => 1, clear: () => {} };
		let now = 0;
		const start = async () => {
			const { upstream, adapter } = setup({ clock: () => now, timers: inert });
			now = 0;
			const l = await launch(adapter, 60_000);
			const media = await opened(adapter, l);
			const socket = browserSocket(adapter, mediaTarget(l, media.wsPath));
			await until(() => socket.received.length === 2, "the relay to open");
			return { upstream, l, socket, up: upstream.sockets[0]! };
		};

		// A packet from spacesd after the deadline.
		const a = await start();
		now = 60_000;
		a.up.serve(new Uint8Array([1, 2, 3]));
		assert.equal(a.socket.received.length, 2);
		assert.equal(a.l.handle.status().reason, "expired");
		assert.equal(a.socket.terminated, 1);
		assert.equal(a.up.terminated, 1);

		// A control message from spacesd after the deadline.
		const b = await start();
		now = 60_000;
		b.up.serve(JSON.stringify({ type: "lifecycle", payload: { session_id: "ms-1", event: { kind: "title_changed", title: "late" } } }));
		assert.equal(b.socket.received.length, 2);
		assert.equal(b.l.handle.status().reason, "expired");

		// A frame ack from the browser after the deadline.
		const c = await start();
		c.socket.events!.message(JSON.stringify({ type: "frame_ack", payload: { session_id: "ms-1", sequence: 1, decode_queue: 0 } }));
		assert.equal(c.up.received.length, 1);
		now = 60_000;
		c.socket.events!.message(JSON.stringify({ type: "frame_ack", payload: { session_id: "ms-1", sequence: 2, decode_queue: 0 } }));
		c.socket.events!.message(JSON.stringify({ type: "request_keyframe", payload: { session_id: "ms-1" } }));
		assert.equal(c.up.received.length, 1);
		assert.equal(c.l.handle.status().reason, "expired");
		assert.deepEqual([c.socket.terminated, c.up.terminated], [1, 1]);
		await until(() => c.l.handle.status().phase === "closed", "both halves to report closed");
	});

	it("checks a media upgrade again when it is attached, not only when it was asked for", async () => {
		let wall = 1_800_000_000_000;
		const { upstream, adapter } = setup({}, () => wall);
		const l = await launch(adapter);
		const media = await opened(adapter, l);
		const upgrade = (target = mediaTarget(l, media.wsPath)) => {
			const u = adapter.media(target, ["rcdp.v2"]);
			assert.equal(u.status, 101);
			return u as Extract<typeof u, { status: 101 }>;
		};
		const opens = { count: 0 };
		const open = () => {
			opens.count++;
			return { send: () => {}, close: () => {}, terminate: () => {}, bufferedAmount: () => 0 } satisfies MediaSocket;
		};
		// The media ticket expires between the check and the attach.
		const expiring = upgrade();
		wall += 601_000;
		assert.equal(expiring.attach(open), 401);
		assert.throws(() => expiring.attach(open));
		wall -= 601_000;
		// The session is replaced between them.
		const replaced = upgrade();
		const next = await rpc(adapter, l, OPEN, openInit());
		assert.equal(replaced.attach(open), 404);
		// The launch ends between them.
		const ending = upgrade(mediaTarget(l, next.message!.wsPath));
		l.handle.end();
		assert.equal(ending.attach(open), 404);
		assert.equal(opens.count, 0);
		assert.equal(upstream.sockets.length, 0);
		assert.equal(l.handle.status().phase, "closed");
	});

	it("reads the launch's clock around every read of a presence body, so fragments of a frame after the deadline end the stream", async () => {
		// Timers that never fire: only the clock tells the stream its launch has ended.
		const inert: Timers = { set: () => 1, clear: () => {} };
		let now = 0;
		let body!: { controller: ReadableStreamDefaultController<Uint8Array>; cancels: number; signal: AbortSignal };
		let cancel: () => Promise<void> = () => Promise.resolve();
		const wrap = (fetch: Fetch): Fetch => async (url, init) => {
			if (!url.endsWith(".PresenceService/Join")) return fetch(url, init);
			const record = { cancels: 0, signal: init.signal! } as typeof body;
			body = record;
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					record.controller = controller;
				},
				cancel: () => {
					record.cancels++;
					return cancel();
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": GRPC } });
		};
		const { adapter } = setup({ clock: () => now, timers: inert }, Date.now, wrap);
		const start = async () => {
			now = 0;
			const l = await launch(adapter, 60_000);
			const response = await adapter.fetch(new Request(`${PAGE}/${l.id}/cua.env.v1.PresenceService/Join`, { method: "POST", headers: { "content-type": GRPC, "x-cua-env-authorization": `Bearer ${l.credential}` }, body: frame(0, new Uint8Array()) }));
			void response.body!.getReader().read().catch(() => {});
			await settle();
			return l;
		};
		const presence = (l: Launch) => l.handle.status().transports["presence-rpc"];

		// Half a header before the deadline, the other half's first byte after it: the read that brings it ends the stream.
		const a = await start();
		body.controller.enqueue(new Uint8Array([0]));
		await settle();
		now = 60_000;
		body.controller.enqueue(new Uint8Array([0]));
		await settle();
		assert.deepEqual([body.cancels, body.signal.aborted], [1, true]);
		assert.equal(a.handle.status().reason, "expired");
		await until(() => a.handle.status().phase === "closed", "the cancelled body to report closed");

		// A header and part of a payload before the deadline, more of it after: a pending cancel keeps the stream closing until it finishes.
		let release!: () => void;
		cancel = () => new Promise((resolve) => (release = resolve));
		const b = await start();
		const header = new Uint8Array(5);
		new DataView(header.buffer).setUint32(1, 10);
		body.controller.enqueue(new Uint8Array([...header, 1, 2, 3]));
		await settle();
		now = 60_000;
		body.controller.enqueue(new Uint8Array([4, 5]));
		await settle();
		assert.deepEqual([body.cancels, body.signal.aborted, b.handle.status().reason], [1, true, "expired"]);
		assert.deepEqual([b.handle.status().phase, presence(b)], ["closing", 1]);
		release();
		await until(() => b.handle.status().phase === "closed", "the pending cancel to finish");

		// The same with a cancel that fails: the stream stays closing, and unconfirmed.
		cancel = () => Promise.reject(new Error("cancel failed"));
		const c = await start();
		body.controller.enqueue(new Uint8Array([...header, 1]));
		await settle();
		now = 60_000;
		body.controller.enqueue(new Uint8Array([2]));
		await settle();
		assert.deepEqual([body.cancels, c.handle.status().reason], [1, "expired"]);
		assert.deepEqual([c.handle.status().phase, presence(c), c.handle.status().unconfirmed], ["closing", 1, 1]);
	});
});
