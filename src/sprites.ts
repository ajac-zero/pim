import { HttpError } from "./http";

/**
 * Computers Pim starts for people who don't bring one: a Fly.io Sprite
 * each, a Linux VM whose whole disk persists, so what agents and the
 * person install there stays, as on a computer of their own. A Sprite
 * runs while something is connected to it and sleeps by itself soon after
 * nothing is, and Sprites bill only while they run.
 *
 * The space doesn't wait for the computer to connect, as it does a
 * computer the person brings: it starts pim-computer there itself, through
 * the Sprites API's exec, which wakes the Sprite, and speaks to it over
 * that command's input and output (`connect`). Letting go of it lets the
 * Sprite sleep (see ./computer.ts). So nothing on the Sprite listens on a
 * port, and only the API's token reaches it.
 */

const API = "https://api.sprites.dev/v1";

/** The streams of an exec's binary frames, each frame's first byte. */
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const EXIT = 3;
const STDIN_EOF = 4;

/** How long pim-computer may go on once let go of: time to quit the browser, so what's signed in there is saved. */
const AFTER_DISCONNECT = "30s";

/**
 * What a new Sprite gets once: Google Chrome, which the agents browse
 * with, and the emoji font pages use. Sprites have Node.js already.
 */
const SETUP = `set -e
mkdir -p ~/pim ~/.pim-computer
if [ "$(dpkg --print-architecture)" = amd64 ] && ! command -v google-chrome-stable >/dev/null; then
	curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
	sudo apt-get update -qq
	sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/chrome.deb fonts-noto-color-emoji
	rm -f /tmp/chrome.deb
fi`;

/**
 * Starts pim-computer, as the Pim at `$1` serves it now, so a Sprite stays
 * in step with its Pim; the copy it has is used when the Pim can't be reached.
 */
const LAUNCH = `curl -fsSL "$1/pim-computer.ts" -o ~/.pim-computer/next.ts && mv ~/.pim-computer/next.ts ~/.pim-computer/pim-computer.ts
exec node ~/.pim-computer/pim-computer.ts --stdio --root ~/pim`;

/** pim-computer on a Sprite, as the space talks to it: a line at a time. */
export type SpriteLink = {
	readonly readyState: number;
	send(line: string): void;
	/** Ends its input, so it quits, and lets go of the Sprite. */
	close(): void;
};

export class Sprites {
	readonly #token: string;

	constructor(token: string) {
		this.#token = token;
	}

	async #call(method: string, path: string, body?: unknown): Promise<Response> {
		const response = await fetch(`${API}${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok && !(method === "DELETE" && response.status === 404)) {
			const detail = (await response.text()).slice(0, 300);
			console.error(JSON.stringify({ event: "sprites.failed", method, path, status: response.status, detail }));
			throw new HttpError(502, `Fly.io couldn't ${method === "DELETE" ? "remove" : "start"} the computer (${response.status}). Try again later.`);
		}
		return response;
	}

	/** Runs `script` with bash on the Sprite, over a WebSocket that carries its input and output. */
	async #exec(name: string, script: string, args: string[], options: { afterDisconnect?: string } = {}): Promise<WebSocket> {
		const url = new URL(`${API}/sprites/${encodeURIComponent(name)}/exec`);
		for (const arg of ["bash", "-c", script, "pim", ...args]) url.searchParams.append("cmd", arg);
		url.searchParams.set("path", "bash");
		url.searchParams.set("stdin", "true");
		if (options.afterDisconnect) url.searchParams.set("max_run_after_disconnect", options.afterDisconnect);
		const response = await fetch(url, { headers: { Authorization: `Bearer ${this.#token}`, Upgrade: "websocket" } });
		const socket = response.webSocket;
		if (!socket) {
			console.error(JSON.stringify({ event: "sprites.exec_failed", status: response.status, detail: (await response.text()).slice(0, 300) }));
			throw new HttpError(502, `Fly.io couldn't reach the computer (${response.status}). Try again in a minute.`);
		}
		socket.binaryType = "arraybuffer";
		socket.accept();
		return socket;
	}

	/** Creates a Sprite named `name` and sets it up; one that can't be set up is removed. */
	async create(name: string): Promise<void> {
		await this.#call("POST", "/sprites", { name });
		try {
			const socket = await this.#exec(name, SETUP, []);
			const { code, errors } = await new Promise<{ code: number; errors: string }>((resolve) => {
				let errors = "";
				let code = -1;
				socket.addEventListener("message", (event) => {
					if (typeof event.data === "string") return;
					const frame = new Uint8Array(event.data as ArrayBuffer);
					if (frame[0] === STDERR) errors = (errors + new TextDecoder().decode(frame.subarray(1))).slice(-2000);
					if (frame[0] === EXIT) {
						code = frame[1] ?? 0;
						socket.close(1000);
						resolve({ code, errors });
					}
				});
				socket.addEventListener("close", () => resolve({ code, errors }));
			});
			if (code !== 0) {
				console.error(JSON.stringify({ event: "sprites.setup_failed", name, code, errors }));
				throw new HttpError(502, "The computer couldn't be set up. Try again later.");
			}
		} catch (error) {
			await this.destroy(name).catch(() => undefined);
			throw error;
		}
	}

	/** Removes the Sprite, with everything on it; one that's gone already is removed. */
	async destroy(name: string): Promise<void> {
		await this.#call("DELETE", `/sprites/${encodeURIComponent(name)}`);
	}

	/**
	 * Starts pim-computer on the Sprite, waking it, with the Pim at `pimUrl`
	 * to fetch it from. Each line it writes goes to `receive`; `closed` is
	 * called once it has stopped, or the Sprite went away.
	 */
	async connect(name: string, pimUrl: string, receive: (line: string) => void, closed: () => void): Promise<SpriteLink> {
		const socket = await this.#exec(name, LAUNCH, [pimUrl], { afterDisconnect: AFTER_DISCONNECT });
		const decoder = new TextDecoder();
		let partial = "";
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			closed();
		};
		socket.addEventListener("message", (event) => {
			if (typeof event.data === "string") return;
			const frame = new Uint8Array(event.data as ArrayBuffer);
			if (frame[0] === STDOUT) {
				const lines = (partial + decoder.decode(frame.subarray(1), { stream: true })).split("\n");
				partial = lines.pop() ?? "";
				for (const line of lines) if (line) receive(line);
			} else if (frame[0] === STDERR) {
				console.log(JSON.stringify({ event: "computer.log", name, line: new TextDecoder().decode(frame.subarray(1)).trimEnd().slice(0, 500) }));
			} else if (frame[0] === EXIT) {
				socket.close(1000);
				end();
			}
		});
		socket.addEventListener("close", end);
		socket.addEventListener("error", end);
		const encoder = new TextEncoder();
		return {
			get readyState() {
				return ended ? WebSocket.CLOSED : socket.readyState;
			},
			send(line) {
				const bytes = encoder.encode(`${line}\n`);
				const frame = new Uint8Array(bytes.byteLength + 1);
				frame[0] = STDIN;
				frame.set(bytes, 1);
				socket.send(frame);
			},
			close() {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(Uint8Array.of(STDIN_EOF));
					socket.close(1000, "Let go");
				}
				end();
			},
		};
	}
}
