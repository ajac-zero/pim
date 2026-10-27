/**
 * The bridge's viewer side (docs/cua-viewer-first-preview.md): what runs in
 * the bridge's account to let one person watch the VM's display through
 * spacesd's own HTML5 viewer, view only. It builds the viewer adapter
 * (./viewer-adapter.ts) against spacesd's origin and the launch manager
 * (./viewer-launch-manager.ts) over the journal store (./journal-store.ts),
 * and answers `ViewerRoutes` for the Node host (./host.ts), which is what
 * routes to them. It adds no listener of its own, and reads no secret but
 * spacesd's root token.
 *
 * **The root token** is read from a file on every launch, never kept, and
 * never logged, returned or put in an error. The file must be a regular file
 * of this account's, not reached through a link, with no group or other
 * permissions and one link, holding 1 to 4096 printable ASCII characters and
 * at most one newline after them. Anything else reads as no token, and the
 * launch is refused before anything is stored. A descriptor whose close
 * fails is never taken as closed, and never closed again by number: the
 * reader latches, reads nothing more, and the host reports it in
 * `blockers()`. Spacesd's own credential setup, and where its file lives,
 * are a separate gate: this program only reads the file it is given. The
 * account that runs it must not be in any group the desktop user is in, and
 * the bridge's token and TLS key stay in files only it can read.
 *
 * **The journal** is never created here (see ./journal-store.ts). When its
 * store can't be opened, the host still serves: every launch is refused,
 * with the reason in `blockers()`, and nothing is written.
 *
 * **Shutdown** stops admitting launches first, asks every launch this host
 * answered to end, waits a bounded time for each to be seen closed, and
 * reports how many were requested, seen closed and still pending. It does
 * not claim closure it didn't see, and it doesn't wait forever: what is
 * pending stays unresolved in the journal, and the next process finds it
 * unconfirmed. Only then does it release the journal's lock.
 *
 * Importing it does nothing; `createViewerHost(...)` opens the journal.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage } from "node:http";
import * as path from "node:path";
import { WebSocket } from "ws";
import type { ViewerRoutes } from "./host.ts";
import { type JournalFiles, JournalStoreRefused, NODE_JOURNAL_FILES, openJournalStore } from "./journal-store.ts";
import { createViewerAdapter, MAX_MEDIA_PACKET_BYTES, type MediaEvents, type MediaSocket, type UpstreamOptions } from "./viewer-adapter.ts";
import { type KeyRequest, openViewerLaunchManager, type ViewerLaunchManager } from "./viewer-launch-manager.ts";

/** The longest root token spacesd's clients take, as in ./cua-credential.ts. */
export const MAX_ROOT_TOKEN_BYTES = 4096;

const { O_RDONLY, O_NOFOLLOW } = fs.constants;
const PRINTABLE = /^[\x21-\x7e]{1,4096}$/;

export type RootTokenReader = {
	/** The token in the file now, or `undefined`: missing, not as it must be, unreadable, or the reader has latched. It says nothing about why, and keeps nothing. */
	readonly read: () => string | undefined;
	/** Whether a descriptor's close failed, so it may still be open. The reader then reads nothing more. */
	readonly latched: () => boolean;
};

/** A reader of the root token in `file` (see the header). */
export function createRootTokenReader(file: string, files: JournalFiles = NODE_JOURNAL_FILES): RootTokenReader {
	let latched = false;
	return {
		latched: () => latched,
		read() {
			if (latched) return undefined;
			let descriptor: number;
			let token: string | undefined;
			try {
				const uid = files.uid();
				descriptor = files.open(file, O_RDONLY | O_NOFOLLOW);
				try {
					const stat = files.fstat(descriptor);
					if (uid !== undefined && stat.isFile() && stat.uid === uid && (stat.mode & 0o077) === 0 && stat.nlink === 1 && stat.size <= MAX_ROOT_TOKEN_BYTES + 1) {
						const bytes = files.read(descriptor, MAX_ROOT_TOKEN_BYTES + 1);
						const text = bytes.toString("latin1");
						const candidate = text.endsWith("\n") ? text.slice(0, -1) : text;
						if (bytes.length <= MAX_ROOT_TOKEN_BYTES + 1 && PRINTABLE.test(candidate)) token = candidate;
					}
				} catch {
					token = undefined;
				}
			} catch {
				// Not opened: there is no descriptor to close.
				return undefined;
			}
			// Closed once. If that can't be seen, the token is refused, whatever was read, and the number is never closed again.
			try {
				files.close(descriptor);
			} catch {
				latched = true;
				return undefined;
			}
			return token;
		},
	};
}

/** Whether `origin` is exactly `https://host[:port]`, or `http://` on a loopback address written as one: where spacesd is reached. */
export function checkedOrigin(origin: string): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.origin + "/" !== url.href || url.username || url.password) return false;
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && (/^127(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === "[::1]");
}

/** How long spacesd has to answer a media socket's upgrade. */
const HANDSHAKE_MS = 10_000;

/** What the media opener needs of a `ws` client; tests give a stand-in. */
export type UpstreamSocket = Pick<WebSocket, "on" | "terminate" | "close" | "send" | "bufferedAmount">;

/** Makes the client for `url` offering `protocol`; the real one is `ws`'s. It is called only once the open is known not to be cancelled. */
export type UpstreamSocketFactory = (url: string, protocol: string) => UpstreamSocket;

const nodeSocket: UpstreamSocketFactory = (url, protocol) =>
	new WebSocket(url.replace(/^http/, "ws"), protocol, { perMessageDeflate: false, followRedirects: false, maxPayload: MAX_MEDIA_PACKET_BYTES + 1024, handshakeTimeout: HANDSHAKE_MS });

/**
 * Opens a media socket to spacesd: resolves once it is open, rejects with the
 * upgrade's `status`, and reports its closure even before that. A cancelled
 * open (`signal` already aborted) rejects before `socket` is called, so no
 * native socket is made for it; a later abort ends the socket made.
 */
export function createMediaOpener(socket: UpstreamSocketFactory): UpstreamOptions["openMedia"] {
	return ({ url, protocol, signal, events }) =>
		new Promise<MediaSocket>((resolve, reject) => {
			if (signal.aborted) return reject(new Error("The media open was cancelled."));
			let opened = false;
			let settled = false;
			let closed = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			let ws: UpstreamSocket;
			try {
				ws = socket(url, protocol);
			} catch {
				return reject(new Error("The media socket couldn't be made."));
			}
			const stop = () => ws.terminate();
			signal.addEventListener("abort", stop, { once: true });
			const reportClosed = (code?: number) => {
				if (closed) return;
				closed = true;
				signal.removeEventListener("abort", stop);
				events.closed(code);
			};
			const media: MediaSocket = {
				send: (data) => ws.send(data, { binary: typeof data !== "string" }),
				close: (code) => {
					try {
						ws.close(code);
					} catch {
						// A code a WebSocket can't send: ended instead.
						ws.terminate();
					}
				},
				terminate: () => ws.terminate(),
				bufferedAmount: () => ws.bufferedAmount,
			};
			ws.on("open", () => {
				opened = true;
				if (settled) return ws.terminate();
				settled = true;
				resolve(media);
			});
			ws.on("message", (data: Buffer, isBinary: boolean) => {
				if (!opened || closed) return;
				events.message(isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.length) : data.toString("utf8"));
			});
			ws.on("unexpected-response", (_request: unknown, response: IncomingMessage) => {
				response.resume();
				fail(Object.assign(new Error("The media upgrade was refused."), { status: response.statusCode }));
				ws.terminate();
			});
			ws.on("error", () => fail(new Error("The media socket failed.")));
			ws.on("close", (code: number) => {
				fail(new Error("The media socket closed before it opened."));
				reportClosed(opened ? code : undefined);
			});
			// Aborted while the socket was being made: ended at once, and its closure is reported as for any other.
			if (signal.aborted) stop();
		});
}

export const nodeOpenMedia = createMediaOpener(nodeSocket);

/** What `bridge.ts` was given for the viewer, checked whole. */
export type ViewerSettings = {
	readonly origin: string;
	readonly displayId: string;
	readonly journalDirectory: string;
	readonly rootTokenFile: string;
};

const DISPLAY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The viewer's settings from the flags and the environment, all or nothing:
 * `undefined` when none of them is given, the settings when every one that
 * is required is given and valid, and a thrown `RangeError` (with a fixed
 * message) when some are given and some missing or invalid. A lone root
 * token file or display flag is a mistake, not a bridge without a viewer.
 */
export function parseViewerSettings(flags: { readonly origin?: string; readonly journalDirectory?: string; readonly display?: string }, env: { readonly PIM_VIEWER_ROOT_TOKEN_FILE?: string }): ViewerSettings | undefined {
	const given = [flags.origin, flags.journalDirectory, flags.display, env.PIM_VIEWER_ROOT_TOKEN_FILE];
	if (given.every((value) => value === undefined)) return undefined;
	const { origin, journalDirectory, display } = flags;
	const rootTokenFile = env.PIM_VIEWER_ROOT_TOKEN_FILE;
	if (origin === undefined || journalDirectory === undefined || rootTokenFile === undefined) throw new RangeError("The viewer needs its origin, journal directory and root token file together.");
	if (!checkedOrigin(origin)) throw new RangeError("The viewer's origin must be exactly https://host[:port], or http:// on a loopback address.");
	if (!path.isAbsolute(journalDirectory) || path.resolve(journalDirectory) !== journalDirectory) throw new RangeError("The viewer's journal directory must be an absolute, canonical path.");
	if (!path.isAbsolute(rootTokenFile) || path.resolve(rootTokenFile) !== rootTokenFile) throw new RangeError("The viewer's root token file must be an absolute, canonical path.");
	if (display !== undefined && !DISPLAY_ID.test(display)) throw new RangeError("The viewer's display must be a display ID.");
	return { origin, displayId: display ?? "primary", journalDirectory, rootTokenFile };
}

export type ShutdownOptions = {
	/** How long to wait, in all, for launches to be seen closed. */
	readonly graceMs: number;
	readonly pollMs: number;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
};

/** What a shutdown saw of the launches it was asked about: the launches asked to end, those seen closed, and those not. */
export type LaunchShutdown = { readonly requested: number; readonly closed: number; readonly pending: number };

/**
 * Asks every launch in `owned` to end, then reads each one's status until it
 * is seen `closed_observed` or `graceMs` passes. A launch not seen closed is
 * `pending`: its end was requested, nothing is known of its transports, and
 * its journal entry stays unresolved. A manager that throws leaves its
 * launch pending. It doesn't wait longer than `graceMs`.
 */
export async function endOwnedLaunches(manager: Pick<ViewerLaunchManager, "end" | "status">, owned: Iterable<KeyRequest>, options: ShutdownOptions): Promise<LaunchShutdown> {
	const keys = [...owned];
	const deadline = options.now() + options.graceMs;
	const open = new Set(keys.map((_, index) => index));
	for (const [index, key] of keys.entries()) {
		try {
			const answer = await manager.end(key);
			if (answer.outcome === "final" && answer.state === "closed_observed") open.delete(index);
		} catch {
			// Left pending.
		}
	}
	for (;;) {
		for (const index of [...open]) {
			try {
				const answer = await manager.status(keys[index]!);
				if (answer.outcome === "found" && answer.state === "closed_observed") open.delete(index);
			} catch {
				// Left pending.
			}
		}
		if (open.size === 0 || options.now() >= deadline) break;
		await options.sleep(Math.min(options.pollMs, Math.max(1, deadline - options.now())));
	}
	return { requested: keys.length, closed: keys.length - open.size, pending: open.size };
}

export type ViewerHostOptions = {
	/** Where spacesd is served: `https://host[:port]`, or `http://` on a loopback address. */
	readonly origin: string;
	/** The one display every launch shows: an ID, or `primary`. */
	readonly displayId: string;
	/** The journal's directory: this account's own, closed to everyone else (./journal-store.ts). */
	readonly journalDirectory: string;
	/** The file holding spacesd's root token, read for each launch. */
	readonly rootTokenFile: string;
	readonly files?: JournalFiles;
	/** Tests give stand-ins for spacesd; by default Node's `fetch` and `ws`. */
	readonly upstream?: Pick<UpstreamOptions, "fetch" | "openMedia">;
	/** This process's generation: `crypto.randomUUID()` unless a test gives one. */
	readonly generation?: string;
	/** Shutdown's bounds, and the clock and sleep it uses; 5 s, 100 ms and the real ones by default. */
	readonly shutdown?: Partial<ShutdownOptions>;
};

/** What a viewer host's shutdown did and saw. `lockLeft` is true when the journal's lock was left in place, which blocks the next process. */
export type ViewerShutdown = LaunchShutdown & { readonly lockLeft: boolean };

export type ViewerHost = {
	readonly routes: ViewerRoutes;
	/** Why no launch is admitted; empty when launches are. Includes a journal store that wasn't opened and a root token reader that latched. */
	readonly blockers: () => readonly string[];
	/**
	 * Stops admitting launches, asks each launch this host answered to end,
	 * waits a bounded time, and then releases the journal's lock once its
	 * queued writes settled. It says what it saw and doesn't claim closure it
	 * didn't see. A second call gets the first one's answer.
	 */
	readonly close: () => Promise<ViewerShutdown>;
};

export async function createViewerHost(options: ViewerHostOptions): Promise<ViewerHost> {
	if (!checkedOrigin(options.origin)) throw new RangeError("spacesd's origin must be exactly https://host[:port], or http:// on a loopback address.");
	const files = options.files ?? NODE_JOURNAL_FILES;
	const adapter = createViewerAdapter({
		upstream: { origin: options.origin, fetch: options.upstream?.fetch ?? ((url, init) => globalThis.fetch(url, init)), openMedia: options.upstream?.openMedia ?? nodeOpenMedia },
		displayId: options.displayId,
	});
	let journal: ReturnType<typeof openJournalStore> | undefined;
	let refused: string | undefined;
	try {
		journal = openJournalStore({ directory: options.journalDirectory, files });
	} catch (error) {
		refused = error instanceof JournalStoreRefused ? `journal store: ${error.reason}` : "journal store";
	}
	const reader = createRootTokenReader(options.rootTokenFile, files);
	const manager = await openViewerLaunchManager({
		adapter,
		...(journal ? { store: journal.store } : {}),
		generation: options.generation ?? randomUUID(),
		rootToken: () => reader.read(),
	});

	let closing = false;
	/** The launches this host answered `launched`, until their shutdown. */
	const owned = new Map<string, KeyRequest>();
	const ending = (key: KeyRequest) => {
		void manager.end(key).catch(() => undefined);
	};
	const admitting: ViewerLaunchManager = {
		...manager,
		// After shutdown began, nothing new starts; and a launch that was starting meanwhile is ended as soon as it is answered.
		launch: async (request) => {
			if (closing) return { outcome: "refused", reason: "blocked" };
			const answer = await manager.launch(request);
			if (answer.outcome === "launched") {
				const key = { owner: request.owner, key: answer.key, generation: answer.generation };
				owned.set(answer.key, key);
				if (closing) ending(key);
			}
			return answer;
		},
	};

	let shutdown: Promise<ViewerShutdown> | undefined;
	return {
		routes: { manager: admitting, adapter },
		blockers: () => [...(refused ? [refused] : []), ...(reader.latched() ? ["root token reader: descriptor retained"] : []), ...manager.blockers()],
		close: () =>
			(shutdown ??= (async () => {
				closing = true;
				const launches = await endOwnedLaunches(manager, owned.values(), {
					graceMs: options.shutdown?.graceMs ?? 5_000,
					pollMs: options.shutdown?.pollMs ?? 100,
					now: options.shutdown?.now ?? Date.now,
					sleep: options.shutdown?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
				});
				let lockLeft = false;
				try {
					await journal?.close();
				} catch {
					// The lock is left where it is; the result says so.
					lockLeft = true;
				}
				return { ...launches, lockLeft };
			})()),
	};
}
