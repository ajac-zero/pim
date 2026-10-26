import type { ComputerLink } from "./computer";
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

/** How many times a call is made when Sprites is unavailable. */
const RETRIES = 3;

/** How long pim-computer has to quit once its input ends: time to quit the browser, so what's signed in there is saved. */
const QUIT_MS = 20_000;
/** How long it may go on if the socket goes before it has quit. */
const AFTER_DISCONNECT = "30s";

/**
 * What a new Sprite gets once: Google Chrome, which the agents browse
 * with, and the emoji font pages use. Sprites have Node.js already.
 * Downloads are tried again, as they fail now and then.
 */
const SETUP = `set -e
mkdir -p ~/pim ~/.pim-computer
# The key bindings in .bashrc are for terminals: elsewhere, such as in agents' commands, they only warn.
sed -i 's/^bind /[[ $- == *i* ]] \\&\\& bind /' ~/.bashrc || true
if [ "$(dpkg --print-architecture)" = amd64 ] && ! command -v google-chrome-stable >/dev/null; then
	curl -fsSL --retry 5 --retry-all-errors -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
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

/** Splits the bytes of a stream into its lines, each of which goes to `line`. */
function lines(line: (text: string) => void): (bytes: Uint8Array) => void {
	const decoder = new TextDecoder();
	let partial = "";
	return (bytes) => {
		const parts = (partial + decoder.decode(bytes, { stream: true })).split("\n");
		partial = parts.pop() ?? "";
		for (const part of parts) if (part) line(part);
	};
}

export class Sprites {
	readonly #token: string;

	constructor(token: string) {
		this.#token = token;
	}

	async #call(method: string, path: string, body?: unknown): Promise<Response> {
		let response: Response;
		// Sprites answers 503 now and then, asking to be asked again.
		for (let attempt = 1; ; attempt++) {
			response = await fetch(`${API}${path}`, {
				method,
				headers: { Authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (response.status !== 503 || attempt === RETRIES) break;
			await response.body?.cancel();
			await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
		}
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
		await this.#call("POST", "/sprites", { name, wait_for_capacity: true });
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
	 * called once it has stopped, or the Sprite went away. Each message sent
	 * is a line of its input, and closing the link ends its input, so it
	 * quits, and lets go of the Sprite.
	 */
	async connect(name: string, pimUrl: string, receive: (line: string) => void, closed: () => void): Promise<ComputerLink> {
		const socket = await this.#exec(name, LAUNCH, [pimUrl], { afterDisconnect: AFTER_DISCONNECT });
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			closed();
		};
		const output = lines(receive);
		const log = lines((line) => console.log(JSON.stringify({ event: "computer.log", name, line: line.slice(0, 500) })));
		socket.addEventListener("message", (event) => {
			if (typeof event.data === "string") return;
			const frame = new Uint8Array(event.data as ArrayBuffer);
			if (frame[0] === STDOUT) output(frame.subarray(1));
			else if (frame[0] === STDERR) log(frame.subarray(1));
			else if (frame[0] === EXIT) {
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
				end();
				if (socket.readyState !== WebSocket.OPEN) return;
				// Its input ends, so it quits the browser and exits, which closes the socket; one that's slow to is let go of all the same.
				socket.send(Uint8Array.of(STDIN_EOF));
				setTimeout(() => socket.readyState === WebSocket.OPEN && socket.close(1000, "Let go"), QUIT_MS);
			},
		};
	}

}
