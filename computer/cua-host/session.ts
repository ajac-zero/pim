/**
 * The bridge's `OpenSession` (computer/cua-bridge.ts) for a desktop session
 * endpoint (./desktop.ts): each session is one connection to the endpoint's
 * Unix socket, at a path the operator sets, over which pim-computer's
 * messages go a line each, as `--stdio` speaks them. It runs in the bridge's
 * own account, beside the host; it sends the endpoint nothing but the
 * messages the relay hands it, so the bridge's token, its TLS key and the
 * request's headers never cross the socket.
 *
 * A session opens when the connection is made and pim-computer has said its
 * first line (its `hello`), which goes to the relay as it does any other: so
 * an endpoint that refuses the connection, or whose pim-computer doesn't
 * start, fails the session rather than open one that ends at once. Nothing
 * is made up, kept for later, or sent again.
 *
 * Importing it does nothing; `unixSession(...)` returns the `OpenSession`.
 */

import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Lines, MAX_CHUNK_BYTES, type OpenSession, type Session } from "../cua-bridge.ts";
import { MESSAGE_OVERHEAD_BYTES } from "./host.ts";

/** The most bytes a Unix socket's path may take on Linux (`sun_path` less its terminating NUL). */
export const MAX_SOCKET_PATH_BYTES = 107;

export type UnixSessionOptions = {
	/** The endpoint's socket: an absolute, normalized path the operator sets. */
	readonly socketPath: string;
	/**
	 * The most held for the endpoint and not yet handed to the socket. Each
	 * message counts its UTF-8 bytes, its `\n`, and `MESSAGE_OVERHEAD_BYTES`.
	 * A message that would pass it makes `send` throw, which ends the session.
	 */
	readonly maxQueuedBytes?: number;
	/** How long a closed session's socket has to hand on what it holds before it is destroyed. */
	readonly closeMs?: number;
};

/** One largest message, at three bytes a character, fits with room to spare, as in the host. */
export const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CLOSE_MS = 5_000;

/** Whether `socketPath` is one a bridge or an endpoint takes: absolute, normalized, short enough, and not in Linux's abstract namespace. */
export function checkSocketPath(socketPath: string): void {
	if (
		typeof socketPath !== "string" ||
		!path.isAbsolute(socketPath) ||
		path.normalize(socketPath) !== socketPath ||
		socketPath.endsWith("/") ||
		socketPath.includes("\0") ||
		Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES
	) {
		throw new Error(`A session socket's path must be absolute and normalized, at most ${MAX_SOCKET_PATH_BYTES} bytes.`);
	}
}

export function unixSession(options: UnixSessionOptions): OpenSession {
	checkSocketPath(options.socketPath);
	const socketPath = options.socketPath;
	const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
	const closeMs = options.closeMs ?? DEFAULT_CLOSE_MS;
	for (const limit of [maxQueuedBytes, closeMs]) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("A session's limits must be positive whole numbers.");
	}

	return (events, signal) =>
		new Promise<Session>((resolve, reject) => {
			if (signal.aborted) return reject(new Error("The session was given up."));
			// Only a socket, not a link to one; `connect` follows links, so this narrows, and can't close, a race with whoever owns the directory.
			let kind: fs.Stats;
			try {
				kind = fs.lstatSync(socketPath);
			} catch {
				return reject(new Error("The desktop's session socket isn't there."));
			}
			if (!kind.isSocket()) return reject(new Error("The desktop's session socket isn't a socket."));

			const socket = net.connect({ path: socketPath });
			const lines = new Lines();
			let state = "opening" as "opening" | "open" | "ended";
			let charged = 0;
			/** Read through a call, as the state changes while the relay is told something. */
			const ended = () => state === "ended";

			/** Ends everything from this side: the socket goes, the signal is no longer watched, and nothing more reaches the relay. */
			const stop = () => {
				state = "ended";
				signal.removeEventListener("abort", abandoned);
				socket.destroy();
			};
			/** The transport failed or ended: a session still opening fails, an open one tells the relay, once. */
			const failed = () => {
				if (state === "ended") return;
				const was = state;
				stop();
				if (was === "opening") reject(new Error("The desktop's session ended before pim-computer spoke."));
				else events.closed();
			};
			const abandoned = () => {
				if (state !== "opening") return;
				stop();
				reject(new Error("The session was given up."));
			};
			signal.addEventListener("abort", abandoned);

			const session: Session = {
				send(message) {
					if (state !== "open") throw new Error("The session has ended.");
					if (message.includes("\n") || message.includes("\r")) throw new Error("A message can't hold a line break.");
					const charge = Buffer.byteLength(message) + 1 + MESSAGE_OVERHEAD_BYTES;
					if (charged + charge > maxQueuedBytes) throw new Error("The desktop isn't reading what it is sent.");
					charged += charge;
					// What the socket took may or may not reach pim-computer if it then fails: that ends the session, and it isn't written again.
					socket.write(`${message}\n`, (error) => {
						charged -= charge;
						if (error) failed();
					});
				},
				close() {
					if (state === "ended") return;
					state = "ended";
					signal.removeEventListener("abort", abandoned);
					// Ending the socket ends pim-computer's input; what it says after goes nowhere.
					socket.end(() => socket.destroy());
					setTimeout(() => socket.destroy(), closeMs).unref();
				},
			};

			socket.on("data", (chunk: Buffer) => {
				for (let start = 0; start < chunk.length && !ended(); start += MAX_CHUNK_BYTES) {
					let said: string[];
					try {
						said = lines.push(chunk.subarray(start, start + MAX_CHUNK_BYTES));
					} catch {
						return failed();
					}
					for (const message of said) {
						if (ended()) return;
						events.message(message);
						if (state === "opening") {
							state = "open";
							signal.removeEventListener("abort", abandoned);
							resolve(session);
						}
					}
				}
			});
			socket.on("end", failed);
			socket.on("close", failed);
			socket.on("error", failed);
		});
}
