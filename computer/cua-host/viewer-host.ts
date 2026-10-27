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
 * launch is refused before anything is stored. Spacesd's own credential
 * setup, and where its file lives, are a separate gate: this program only
 * reads the file it is given. The account that runs it must not be in any
 * group the desktop user is in, and the bridge's token and TLS key stay in
 * files only it can read.
 *
 * **The journal** is never created here (see ./journal-store.ts). When its
 * store can't be opened, the host still serves: every launch is refused,
 * with the reason in `blockers()`, and nothing is written.
 *
 * Importing it does nothing; `createViewerHost(...)` opens the journal.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { WebSocket } from "ws";
import type { ViewerRoutes } from "./host.ts";
import { type JournalFiles, JournalStoreRefused, NODE_JOURNAL_FILES, openJournalStore } from "./journal-store.ts";
import { createViewerAdapter, MAX_MEDIA_PACKET_BYTES, type MediaEvents, type MediaSocket, type UpstreamOptions } from "./viewer-adapter.ts";
import { openViewerLaunchManager } from "./viewer-launch-manager.ts";

/** The longest root token spacesd's clients take, as in ./cua-credential.ts. */
export const MAX_ROOT_TOKEN_BYTES = 4096;

const { O_RDONLY, O_NOFOLLOW } = fs.constants;
const PRINTABLE = /^[\x21-\x7e]{1,4096}$/;

/**
 * The root token in `file`, or `undefined` when there is none to be had:
 * missing, not as it must be, or unreadable. It says nothing about why, and
 * keeps nothing.
 */
export function readRootToken(file: string, files: JournalFiles = NODE_JOURNAL_FILES): string | undefined {
	let descriptor: number | undefined;
	try {
		const uid = files.uid();
		descriptor = files.open(file, O_RDONLY | O_NOFOLLOW);
		const stat = files.fstat(descriptor);
		if (uid === undefined || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > MAX_ROOT_TOKEN_BYTES + 1) return undefined;
		const bytes = files.read(descriptor, MAX_ROOT_TOKEN_BYTES + 1);
		const text = bytes.toString("latin1");
		const token = text.endsWith("\n") ? text.slice(0, -1) : text;
		return bytes.length <= MAX_ROOT_TOKEN_BYTES + 1 && PRINTABLE.test(token) ? token : undefined;
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) {
			try {
				files.close(descriptor);
			} catch {
				// Read, or not; the token isn't kept either way.
			}
		}
	}
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

/** Opens a media socket to spacesd with `ws`: resolves once it is open, rejects with the upgrade's `status`, and reports its closure even before that. */
export const nodeOpenMedia: UpstreamOptions["openMedia"] = ({ url, protocol, signal, events }) =>
	new Promise<MediaSocket>((resolve, reject) => {
		let opened = false;
		let settled = false;
		let closed = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const ws = new WebSocket(url.replace(/^http/, "ws"), protocol, { perMessageDeflate: false, followRedirects: false, maxPayload: MAX_MEDIA_PACKET_BYTES + 1024, handshakeTimeout: HANDSHAKE_MS });
		const stop = () => ws.terminate();
		if (signal.aborted) stop();
		else signal.addEventListener("abort", stop, { once: true });
		const reportClosed = (code?: number) => {
			if (closed) return;
			closed = true;
			signal.removeEventListener("abort", stop);
			events.closed(code);
		};
		const socket: MediaSocket = {
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
			resolve(socket);
		});
		ws.on("message", (data: Buffer, isBinary: boolean) => {
			if (!opened || closed) return;
			events.message(isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.length) : data.toString("utf8"));
		});
		ws.on("unexpected-response", (_request, response) => {
			response.resume();
			fail(Object.assign(new Error("The media upgrade was refused."), { status: response.statusCode }));
			ws.terminate();
		});
		ws.on("error", () => fail(new Error("The media socket failed.")));
		ws.on("close", (code: number) => {
			fail(new Error("The media socket closed before it opened."));
			reportClosed(opened ? code : undefined);
		});
	});

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
};

export type ViewerHost = {
	readonly routes: ViewerRoutes;
	/** Why no launch is admitted; empty when launches are. Includes a journal store that wasn't opened. */
	readonly blockers: () => readonly string[];
	/** Releases the journal's lock. Launches already open are not ended by it: the next generation finds them unconfirmed. */
	readonly close: () => void;
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
	const manager = await openViewerLaunchManager({
		adapter,
		...(journal ? { store: journal.store } : {}),
		generation: options.generation ?? randomUUID(),
		rootToken: () => readRootToken(options.rootTokenFile, files),
	});
	return {
		routes: { manager, adapter },
		blockers: () => [...(refused ? [refused] : []), ...manager.blockers()],
		close: () => journal?.close(),
	};
}
