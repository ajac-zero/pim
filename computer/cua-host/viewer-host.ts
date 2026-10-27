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
 * answered to end (those still starting too, as they answer), and reads
 * their status until each is seen closed or one deadline passes. Every wait
 * races that deadline, so a held call can't hold the shutdown, and nothing
 * is taken as settled that wasn't seen to be. It reports what was requested,
 * seen closed, pending, in flight and unsettled, and leaves the journal's
 * lock held when a call could still write it. What is pending stays
 * unresolved in the journal, and the next process finds it unconfirmed.
 *
 * Importing it does nothing; `createViewerHost(...)` opens the journal.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage } from "node:http";
import * as path from "node:path";
import { WebSocket } from "ws";
import { isHttpsOrigin, type ViewerRoutes } from "./host.ts";
import { type JournalFiles, JournalStoreRefused, NODE_JOURNAL_FILES, openJournalStore } from "./journal-store.ts";
import { createViewerAdapter, MAX_MEDIA_PACKET_BYTES, type MediaEvents, type MediaSocket, type UpstreamOptions } from "./viewer-adapter.ts";
import { type KeyRequest, openViewerLaunchManager, type ViewerLaunchManager } from "./viewer-launch-manager.ts";
import type { Timers } from "./viewer-lifetime.ts";

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
	/** spacesd's origin, the host's upstream. Not what a browser connects to. */
	readonly origin: string;
	readonly displayId: string;
	readonly journalDirectory: string;
	readonly rootTokenFile: string;
	/** The exact HTTPS origin the browser loads the viewer from and connects to: the bridge's own public address. */
	readonly publicOrigin: string;
	/** The exact HTTPS origin of the Pim app that may frame the viewer, if embedding is chosen; none otherwise. */
	readonly embedOrigin?: string;
};

const DISPLAY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The viewer's settings from the flags and the environment, all or nothing:
 * `undefined` when none of them is given, the settings when every one that
 * is required is given and valid, and a thrown `RangeError` (with a fixed
 * message) when some are given and some missing or invalid. A lone root
 * token file, display or embedding flag is a mistake, not a bridge without a
 * viewer. `publicOrigin` is required and is separate from `origin`, which is
 * where spacesd is, not where a browser goes.
 */
export function parseViewerSettings(
	flags: { readonly origin?: string; readonly journalDirectory?: string; readonly display?: string; readonly publicOrigin?: string; readonly embedOrigin?: string },
	env: { readonly PIM_VIEWER_ROOT_TOKEN_FILE?: string },
): ViewerSettings | undefined {
	const given = [flags.origin, flags.journalDirectory, flags.display, flags.publicOrigin, flags.embedOrigin, env.PIM_VIEWER_ROOT_TOKEN_FILE];
	if (given.every((value) => value === undefined)) return undefined;
	const { origin, journalDirectory, display, publicOrigin, embedOrigin } = flags;
	const rootTokenFile = env.PIM_VIEWER_ROOT_TOKEN_FILE;
	if (origin === undefined || journalDirectory === undefined || rootTokenFile === undefined || publicOrigin === undefined) {
		throw new RangeError("The viewer needs its spacesd origin, public origin, journal directory and root token file together.");
	}
	if (!checkedOrigin(origin)) throw new RangeError("The viewer's origin must be exactly https://host[:port], or http:// on a loopback address.");
	if (!isHttpsOrigin(publicOrigin)) throw new RangeError("The viewer's public origin must be exactly an https origin.");
	if (embedOrigin !== undefined && !isHttpsOrigin(embedOrigin)) throw new RangeError("The viewer's embedding origin must be exactly an https origin.");
	if (!path.isAbsolute(journalDirectory) || path.resolve(journalDirectory) !== journalDirectory) throw new RangeError("The viewer's journal directory must be an absolute, canonical path.");
	if (!path.isAbsolute(rootTokenFile) || path.resolve(rootTokenFile) !== rootTokenFile) throw new RangeError("The viewer's root token file must be an absolute, canonical path.");
	if (display !== undefined && !DISPLAY_ID.test(display)) throw new RangeError("The viewer's display must be a display ID.");
	return { origin, displayId: display ?? "primary", journalDirectory, rootTokenFile, publicOrigin, ...(embedOrigin === undefined ? {} : { embedOrigin }) };
}

export type ShutdownOptions = {
	/** How long, in all, the shutdown may wait: every stage of it races this one deadline, held by one timer. */
	readonly graceMs: number;
	/** The pause between status reads, and the grace the journal's drain gets when the deadline had already passed when it began. */
	readonly pollMs: number;
	/** Every timer the shutdown sets, each cleared once it is no longer needed: nothing is left running. Tests give their own. */
	readonly timers: Timers;
};

/**
 * What a shutdown saw. Nothing here claims more than was seen: a call that
 * hadn't answered by the deadline is counted as such, and its work is not
 * taken as settled.
 */
export type ViewerShutdown = {
	/** Launches the shutdown asked to end. */
	readonly requested: number;
	/** Launches whose status was seen `closed_observed`. */
	readonly closed: number;
	/** Launches this host answered and didn't see closed. Their end was requested; their journal entries stay unresolved, and the next process finds them unconfirmed. */
	readonly pending: number;
	/** Of those, the ones whose last status read was `unconfirmed`. */
	readonly unconfirmed: number;
	/** `launch` calls that hadn't answered at the deadline. A launch may still come of one, and is ended when it does. */
	readonly inFlight: number;
	/** `end` and `status` calls that hadn't answered at the deadline. */
	readonly unsettled: number;
	/** The journal's lock is still held, or its close wasn't seen to finish. That blocks the next process, which is what keeps unobserved work from being started over. */
	readonly lockLeft: boolean;
	/** Nothing is pending, in flight or unsettled, and the lock was released. */
	readonly settled: boolean;
};

/** A launch manager whose admission a shutdown can stop, and the shutdown. */
export type LaunchAdmission = {
	/**
	 * The manager the host's routes call. Once a shutdown began, **none of
	 * its three calls reaches the underlying manager**: a launch is refused
	 * (`blocked`), an end answers `unconfirmed`, and a status rejects (the
	 * host answers `503`), since a status has no answer that says "not now".
	 * Calls begun before then are tracked until they answer.
	 */
	readonly manager: Pick<ViewerLaunchManager, "launch" | "end" | "status">;
	/**
	 * Stops admission, asks every launch this host answered to end (those
	 * still starting too, as they answer) through the underlying manager, and
	 * reads their status until each is seen closed or the one deadline
	 * passes. Every wait races that deadline, held by a single timer that is
	 * cleared when the shutdown ends, and so is every pause between reads: a
	 * held call doesn't hold the shutdown and no timer outlives it. The
	 * journal's `close` is asked for only when no call is outstanding, since
	 * one could still write it. It races the deadline, or, if the deadline had
	 * already passed, one more poll interval, so the shutdown can take
	 * `graceMs` plus at most `pollMs`. A launch that answers after the
	 * deadline is ended then, and nothing waits for it. A second call gets
	 * the first one's answer.
	 */
	readonly shutdown: (options: ShutdownOptions, journal?: { readonly close: () => Promise<void> }) => Promise<ViewerShutdown>;
};

export function createLaunchAdmission(manager: Pick<ViewerLaunchManager, "launch" | "end" | "status">): LaunchAdmission {
	let closing = false;
	/** The deadline passed: a launch that answers now is ended at once, and nothing waits for it. */
	let expired = false;
	let result: Promise<ViewerShutdown> | undefined;
	/** The launches this host answered `launched`, until the process ends. */
	const owned = new Map<string, KeyRequest>();
	/** Calls to the underlying manager that haven't answered. A launch call adds its launch to `owned` before it settles. */
	const calls = new Map<Promise<unknown>, "launch" | "call">();
	const track = <T>(kind: "launch" | "call", call: Promise<T>): Promise<T> => {
		calls.set(call, kind);
		const forget = () => void calls.delete(call);
		call.then(forget, forget);
		return call;
	};

	const admitting: LaunchAdmission["manager"] = {
		launch: (request) => {
			if (closing) return Promise.resolve({ outcome: "refused", reason: "blocked" } as const);
			return track(
				"launch",
				manager.launch(request).then((answer) => {
					if (answer.outcome === "launched") {
						const key = { owner: request.owner, key: answer.key, generation: answer.generation };
						owned.set(answer.key, key);
						// Answered after the deadline: no one waits for it, so it is ended now.
						if (expired) void manager.end(key).catch(() => undefined);
					}
					return answer;
				}),
			);
		},
		// Not touched once shutdown began: a new call could write the journal while its lock is being released and the result reported.
		end: (request) => (closing ? Promise.resolve({ outcome: "unconfirmed" } as const) : track("call", manager.end(request))),
		status: (request) => (closing ? Promise.reject(new Error("The viewer host is shutting down.")) : track("call", manager.status(request))),
	};

	async function run(options: ShutdownOptions, journal?: { readonly close: () => Promise<void> }): Promise<ViewerShutdown> {
		closing = true;
		const { timers } = options;
		let pastDeadline = false;
		let deadlineTimer: unknown;
		const deadline = new Promise<void>((resolve) => {
			deadlineTimer = timers.set(() => {
				pastDeadline = true;
				resolve();
			}, options.graceMs);
		});
		/** Waits for `work` to answer or the deadline, whichever is first; the work itself is never stopped or assumed done. */
		const within = async (work: Promise<unknown>): Promise<void> => {
			if (pastDeadline) return;
			await Promise.race([work.then(() => undefined, () => undefined), deadline]);
		};
		/** Pauses for `ms`, or until the deadline; the pause's own timer is cleared either way. */
		const pause = async (ms: number): Promise<void> => {
			let handle: unknown;
			try {
				await Promise.race([new Promise<void>((resolve) => (handle = timers.set(resolve, ms))), deadline]);
			} finally {
				timers.clear(handle);
			}
		};
		try {
			const closed = new Set<string>();
			const asked = new Set<string>();
			const reading = new Set<string>();
			const unconfirmed = new Set<string>();
			for (;;) {
				// Nothing new is asked once everything is seen settled, or the deadline has passed: a call begun now couldn't be waited for.
				if (owned.size === closed.size && calls.size === 0) break;
				if (pastDeadline) break;
				const batch: Promise<unknown>[] = [];
				for (const [key, request] of owned) {
					if (closed.has(key)) continue;
					if (!asked.has(key)) {
						asked.add(key);
						batch.push(
							track("call", manager.end(request)).then(
								(answer) => {
									if (answer.outcome === "final" && answer.state === "closed_observed") closed.add(key);
								},
								() => undefined,
							),
						);
					} else if (!reading.has(key)) {
						// One status read at a time for a launch, so a held one isn't piled on.
						reading.add(key);
						batch.push(
							track("call", manager.status(request))
								.then(
									(answer) => {
										if (answer.outcome !== "found") return;
										if (answer.state === "closed_observed") {
											closed.add(key);
											unconfirmed.delete(key);
										} else if (answer.state === "unconfirmed") unconfirmed.add(key);
										else unconfirmed.delete(key);
									},
									() => undefined,
								)
								.finally(() => reading.delete(key)),
						);
					}
				}
				if (batch.length > 0) await within(Promise.all(batch));
				if (owned.size === closed.size && calls.size === 0) break;
				if (!pastDeadline) await pause(options.pollMs);
			}
			expired = true;

			let inFlight = 0;
			for (const kind of calls.values()) if (kind === "launch") inFlight++;
			const unsettled = calls.size - inFlight;
			let lockLeft = false;
			if (journal) {
				if (calls.size > 0) {
					// A call outstanding could still write the journal: its lock stays held, and `close` isn't asked for.
					lockLeft = true;
				} else {
					// The deadline, or one poll interval more if it had already passed; the extra timer is cleared too.
					let grace: unknown;
					const limit = pastDeadline ? new Promise<void>((resolve) => (grace = timers.set(resolve, options.pollMs))) : deadline;
					try {
						lockLeft = !(await Promise.race([journal.close().then(() => true, () => false), limit.then(() => false)]));
					} finally {
						if (grace !== undefined) timers.clear(grace);
					}
				}
			}
			const pending = owned.size - closed.size;
			return { requested: asked.size, closed: closed.size, pending, unconfirmed: unconfirmed.size, inFlight, unsettled, lockLeft, settled: pending === 0 && calls.size === 0 && !lockLeft };
		} finally {
			// The one deadline timer, and the pause's, never outlive the shutdown.
			timers.clear(deadlineTimer);
		}
	}

	return { manager: admitting, shutdown: (options, journal) => (result ??= run(options, journal)) };
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
	/** The exact HTTPS origin a browser loads the viewer from and connects to (the bridge's own); not `origin`. */
	readonly publicOrigin: string;
	/** The exact HTTPS origin of the Pim app that may frame the viewer, if embedding is chosen. */
	readonly embedOrigin?: string;
	readonly files?: JournalFiles;
	/** Tests give stand-ins for spacesd; by default Node's `fetch` and `ws`. */
	readonly upstream?: Pick<UpstreamOptions, "fetch" | "openMedia">;
	/** This process's generation: `crypto.randomUUID()` unless a test gives one. */
	readonly generation?: string;
	/** Shutdown's bounds and timers: 5 s, 100 ms and the real timers by default. */
	readonly shutdown?: Partial<ShutdownOptions>;
};

export type ViewerHost = {
	readonly routes: ViewerRoutes;
	/** Why no launch is admitted; empty when launches are. Includes a journal store that wasn't opened and a root token reader that latched. */
	readonly blockers: () => readonly string[];
	/** The shutdown of `LaunchAdmission`, with the journal's lock released only when it is seen safe to. A second call gets the first one's answer. */
	readonly close: () => Promise<ViewerShutdown>;
};

export async function createViewerHost(options: ViewerHostOptions): Promise<ViewerHost> {
	if (!checkedOrigin(options.origin)) throw new RangeError("spacesd's origin must be exactly https://host[:port], or http:// on a loopback address.");
	if (!isHttpsOrigin(options.publicOrigin) || (options.embedOrigin !== undefined && !isHttpsOrigin(options.embedOrigin))) throw new RangeError("The viewer's public and embedding origins must each be exactly an https origin.");
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

	const admission = createLaunchAdmission(manager);
	return {
		routes: { manager: admission.manager, adapter, publicOrigin: options.publicOrigin, ...(options.embedOrigin === undefined ? {} : { embedOrigin: options.embedOrigin }) },
		blockers: () => [...(refused ? [refused] : []), ...(reader.latched() ? ["root token reader: descriptor retained"] : []), ...manager.blockers()],
		close: () =>
			admission.shutdown(
				{
					graceMs: options.shutdown?.graceMs ?? 5_000,
					pollMs: options.shutdown?.pollMs ?? 100,
					timers: options.shutdown?.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
				},
				journal,
			),
	};
}
