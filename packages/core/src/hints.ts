import { type Socket, connect } from "node:net";
import type { Hints } from "./commands.ts";

/**
 * NATS Core as a best-effort fanout: a minimal client for publish and subscribe. It is never canonical state and never
 * the only way work is found. A message published while disconnected is dropped, and every consumer also polls
 * PostgreSQL, so loss delays discovery and nothing more.
 */
export class NatsHints implements Hints {
	#socket: Socket | undefined;
	#connected = false;
	#buffer = "";
	readonly #subs = new Map<number, { subject: string; cb: (payload: Record<string, unknown>, subject: string) => void }>();
	#nextSid = 1;
	#closed = false;
	#retry: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly url: string,
		private readonly onError: (error: Error) => void = () => undefined,
	) {}

	start(): void {
		this.#open();
	}

	#open(): void {
		if (this.#closed) return;
		const { hostname, port } = new URL(this.url);
		const socket = connect({ host: hostname, port: Number(port || 4222) });
		this.#socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.#onData(chunk));
		socket.on("error", (error) => this.onError(error));
		socket.on("close", () => {
			this.#connected = false;
			this.#socket = undefined;
			if (!this.#closed) this.#retry = setTimeout(() => this.#open(), 500);
		});
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		for (;;) {
			const eol = this.#buffer.indexOf("\r\n");
			if (eol === -1) return;
			const line = this.#buffer.slice(0, eol);
			if (line.startsWith("INFO ")) {
				this.#socket!.write(`CONNECT {"verbose":false,"pedantic":false,"name":"pim"}\r\nPING\r\n`);
				this.#connected = true;
				for (const [sid, sub] of this.#subs) this.#socket!.write(`SUB ${sub.subject} ${sid}\r\n`);
				this.#buffer = this.#buffer.slice(eol + 2);
			} else if (line === "PING") {
				this.#socket!.write("PONG\r\n");
				this.#buffer = this.#buffer.slice(eol + 2);
			} else if (line.startsWith("MSG ")) {
				const [, subject, sid, size] = line.split(" ");
				const length = Number(size);
				if (this.#buffer.length < eol + 2 + length + 2) return;
				const body = this.#buffer.slice(eol + 2, eol + 2 + length);
				this.#buffer = this.#buffer.slice(eol + 2 + length + 2);
				try {
					this.#subs.get(Number(sid))?.cb(JSON.parse(body), subject!);
				} catch {
					// A malformed hint is ignored: hints carry no authority.
				}
			} else this.#buffer = this.#buffer.slice(eol + 2);
		}
	}

	publish(subject: string, payload: Record<string, unknown>): void {
		if (!this.#connected || !this.#socket) return;
		const body = JSON.stringify(payload);
		this.#socket.write(`PUB ${subject} ${Buffer.byteLength(body)}\r\n${body}\r\n`);
	}

	subscribe(subject: string, cb: (payload: Record<string, unknown>, subject: string) => void): void {
		const sid = this.#nextSid++;
		this.#subs.set(sid, { subject, cb });
		if (this.#connected) this.#socket!.write(`SUB ${subject} ${sid}\r\n`);
	}

	close(): void {
		this.#closed = true;
		if (this.#retry) clearTimeout(this.#retry);
		this.#socket?.destroy();
	}
}
