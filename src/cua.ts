import { AsyncLocalStorage } from "node:async_hooks";
import type { ComputerProvider, ComputerStatus } from "./computer";
import { HttpError } from "./http";

/**
 * The Cua evaluation: a private, opt-in prototype in which one allowlisted
 * owner's agents use a Cua machine (cua-spacesd with cua-driver) as their
 * computer, in place of a Sprite or a paired pim-computer, which stay as
 * they were and come back when it's turned off. See docs/cua-evaluation.md.
 *
 * It is on only where the deployment sets `CUA_EVAL_BRIDGE_URL`,
 * `CUA_EVAL_BRIDGE_TOKEN` and `CUA_EVAL_OWNER`, only in that owner's space,
 * and only once they turn it on. Pim reaches the machine through
 * pim-cua-bridge (deploy/cua-eval/pim_cua_bridge.py), at an HTTPS address on
 * a fixed allowlist, with a credential of its own: the machine's root token
 * stays on the machine, and neither reaches the app.
 *
 * The bridge decides who has the machine: the person, or the agents under a
 * lease it gave when the person last resumed them, which every call of
 * theirs carries. The space keeps its own record too (`cua_control`), which
 * starts, and stays across restarts, with the agents paused, and checks it
 * before any call leaves: while the agents are paused every call their tools
 * make here is refused when it would run, whenever it was asked for or
 * approved. A pause is complete once nothing of theirs runs, here or on the
 * machine, as the bridge says; only then does the viewer open. Only the
 * person resumes, naming the pause they end; the bridge closes the person's
 * viewer sessions before it hands the machine back.
 */

/** The only hosts a bridge may be at. */
export const CUA_BRIDGE_HOSTS: readonly string[] = ["cua-eval.ajac-zero.com"];
export const CUA_BRIDGE_PREFIX = "/pim-bridge/v1/";
/** The header the bridge reads Pim's credential from, apart from any HTTP Basic login on the same host. */
export const CUA_BRIDGE_AUTH_HEADER = "X-Pim-Bridge-Authorization";

const ENABLED_KEY = "cua_enabled_at";
const CONTROL_KEY = "cua_control";
/** What the bridge can do on the machine: pim-computer's file and command calls, nothing of DevTools. */
const CALLS: ReadonlySet<string> = new Set(["stat", "read", "write", "mkdir", "rm", "rename", "readdir", "find", "grep", "exec"]);
/** The most an answer may be: a 1 MiB read is 1.4 MB of base64; a screenshot more. */
const MAX_ANSWER_BYTES = 12 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;

export const CUA_PAUSED_MESSAGE =
	"The person has paused agents on their Cua evaluation computer to use it themselves. Nothing was done there. Wait until they resume; don't try again until then.";

export type CuaConfig = {
	/** The bridge's origin: https, on `CUA_BRIDGE_HOSTS`, with no path, port or login. */
	readonly base: string;
	readonly token: string;
	/** The one owner whose space may use it. */
	readonly owner: string;
};

/**
 * Reads the deployment's Cua evaluation settings: null when none is set,
 * and an error saying what's wrong (never a value) when any is unsound.
 */
export function readCuaConfig(env: object): CuaConfig | null {
	const vars = env as Record<string, unknown>;
	const read = (name: string) => (typeof vars[name] === "string" ? (vars[name] as string).trim() : "");
	const [address, token, owner] = [read("CUA_EVAL_BRIDGE_URL"), read("CUA_EVAL_BRIDGE_TOKEN"), read("CUA_EVAL_OWNER")];
	if (!address && !token && !owner) return null;
	const problems: string[] = [];
	const url = URL.parse(address);
	if (!url || url.protocol !== "https:") problems.push("CUA_EVAL_BRIDGE_URL must be an https:// address");
	else if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || address.includes("#") || address.includes("?")) {
		problems.push("CUA_EVAL_BRIDGE_URL must be an origin alone, with no login, port, path or query");
	} else if (!CUA_BRIDGE_HOSTS.includes(url.hostname)) problems.push(`CUA_EVAL_BRIDGE_URL must be at ${CUA_BRIDGE_HOSTS.join(" or ")}`);
	if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) problems.push("CUA_EVAL_BRIDGE_TOKEN must be at least 43 base64url characters (256 bits), such as `openssl rand -base64 48 | tr '+/' '-_' | tr -d =`");
	if (!/^o_[0-9a-z]{26}$/.test(owner)) problems.push("CUA_EVAL_OWNER must be one owner id, such as o_01j…");
	if (problems.length > 0) throw new Error(`The Cua evaluation is off: ${problems.join("; ")}`);
	return { base: url!.origin, token, owner };
}

export type CuaMode = "agents" | "pausing" | "paused";

/**
 * Who uses the machine as this space sees it: the agents, under `lease`; the
 * person (`paused`), as of the bridge's `epoch`; or neither yet (`pausing`).
 * `generation` changes with each pause and resume, so a stale page can't end a newer pause.
 */
type Control = { readonly mode: CuaMode; readonly generation: number; readonly lease: number | null; readonly epoch: number | null; readonly at: number };

const PAUSED_CONTROL: Control = { mode: "paused", generation: 0, lease: null, epoch: null, at: 0 };

export type CuaStatus = {
	/** Whether this space may use the evaluation. */
	readonly offered: boolean;
	/** Whether its agents use it now, in place of the space's other computer. */
	readonly enabled: boolean;
	readonly mode: CuaMode;
	/** Which pause or resume this is: resuming names it, so a stale page can't end a newer pause. */
	readonly generation: number;
	/** The agents' work still under way, here and on the machine, including commands' background processes. */
	readonly pending: number;
	readonly host: string | null;
};

/** What the bridge says of who has the machine (pim_cua_bridge.py's `view`). */
type BridgeView = { mode?: unknown; epoch?: unknown; inflight?: unknown; background?: unknown; quietSeconds?: unknown };

/** One driver tool's answer, as the bridge passes it on. */
export type DriverAnswer = { structured: Record<string, unknown> | null; text: string; image: string | null; isError: boolean };

type Meta = {
	meta(key: string): string | undefined;
	setMeta(key: string, value: string): void;
	deleteMeta(key: string): void;
};

/** A failure the bridge reported for a call, with its code (`ENOENT`…), as the file tools read it. */
function callError(error: { message?: unknown; code?: unknown }): Error {
	return Object.assign(new Error(String(error.message ?? "The Cua computer failed").slice(0, MAX_ERROR_CHARS)), typeof error.code === "string" ? { code: error.code } : {});
}

/** Reads at most `max` bytes of a response, or fails. */
async function readCapped(response: Response, max: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const parts: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			throw new HttpError(502, "The Cua bridge's answer was too large.");
		}
		parts.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export class CuaEvaluation implements ComputerProvider {
	/** Writes go in parts small enough for the bridge's request limit. */
	readonly chunkBytes = 64 * 1024;
	readonly #meta: Meta;
	readonly #config: () => CuaConfig | null;
	readonly #owner: () => string;
	/** Agent work under way here: a whole tool's calls count as one (`hold`). */
	#pending = 0;
	/** What the bridge last said it had under way, while a pause waits for it. */
	#remote = 0;
	readonly #held = new AsyncLocalStorage<number>();
	/** Pausing, resuming and minting a viewer ticket, one at a time. */
	#transition: Promise<unknown> = Promise.resolve();
	/** Whether the bridge answered the last time it was asked. */
	#reachable: boolean | null = null;
	/** Called when what the app shows of it changes. */
	readonly #changed: () => void;

	constructor(options: { meta: Meta; config: () => CuaConfig | null; owner: () => string; changed: () => void }) {
		this.#meta = options.meta;
		this.#config = options.config;
		this.#owner = options.owner;
		this.#changed = options.changed;
	}

	#settings(): CuaConfig | null {
		const config = this.#config();
		return config && config.owner === this.#owner() ? config : null;
	}

	offered(): boolean {
		return this.#settings() !== null;
	}

	active(): boolean {
		return this.offered() && this.#meta.meta(ENABLED_KEY) !== undefined;
	}

	/** Turning it on or off changes which computer the agents use, so it waits until nothing of theirs runs on this one. */
	#switchable(): void {
		const { mode } = this.#control();
		if (this.active() && (mode !== "paused" || this.#pending > 0)) throw new HttpError(409, "Pause your agents, and let their work finish, before turning the evaluation off.");
	}

	/** Puts it in place of the space's other computer, with the agents paused until the person resumes them. */
	enable(now: number): void {
		if (!this.offered()) throw new HttpError(404, "This space isn't part of the Cua evaluation.");
		if (this.active()) return;
		const { generation } = this.#control();
		this.#meta.setMeta(CONTROL_KEY, JSON.stringify({ ...PAUSED_CONTROL, generation: generation + 1, at: now }));
		this.#meta.setMeta(ENABLED_KEY, String(now));
	}

	/** The agents go back to the space's other computer, if it has one; only while they're paused here. */
	disable(): void {
		this.#switchable();
		this.#meta.deleteMeta(ENABLED_KEY);
	}

	#control(): Control {
		const kept = this.#meta.meta(CONTROL_KEY);
		return kept ? { ...PAUSED_CONTROL, ...(JSON.parse(kept) as Partial<Control>) } : PAUSED_CONTROL;
	}

	#setControl(control: Control): void {
		this.#meta.setMeta(CONTROL_KEY, JSON.stringify(control));
		this.#changed();
	}

	view(): CuaStatus {
		const { mode, generation } = this.#control();
		const settings = this.#settings();
		return {
			offered: settings !== null,
			enabled: this.active(),
			mode,
			generation,
			// The bridge counts the calls under way here too, so the larger count is what's still to finish.
			pending: Math.max(this.#pending, mode === "agents" ? 0 : this.#remote),
			host: settings ? new URL(settings.base).host : null,
		};
	}

	status(): ComputerStatus {
		const since = Number(this.#meta.meta(ENABLED_KEY) ?? 0);
		return {
			state: this.#reachable === false ? "offline" : "online",
			managed: false,
			pairedAt: since,
			provider: "cua",
			computer: { agent: "pim-cua-bridge", hostname: this.view().host ?? "", platform: "linux", arch: "x64", user: "", root: "/workspace", browser: "cua-driver", connectedAt: since },
		};
	}

	/** Whether work under way here is the agents' on this machine (within `hold`). */
	holding(): boolean {
		return this.#held.getStore() !== undefined;
	}

	/**
	 * Runs one agent tool's work on the machine, if the agents may use it
	 * now: checked once, here, when it starts, and counted under way until
	 * it ends, so a pause waits for it. The check and the count happen
	 * together, before anything else can run. Every call within carries the
	 * lease it started under, which the bridge checks again.
	 */
	async hold<T>(work: () => Promise<T>): Promise<T> {
		if (this.#held.getStore() !== undefined) return work();
		if (!this.active()) throw new HttpError(404, "The Cua evaluation isn't on in this space.");
		const { mode, lease } = this.#control();
		if (mode !== "agents" || lease === null) throw new HttpError(423, CUA_PAUSED_MESSAGE);
		this.#pending++;
		try {
			return await this.#held.run(lease, work);
		} finally {
			this.#pending--;
			if (this.#pending === 0 && this.#control().mode === "pausing") void this.settle().catch(() => {});
		}
	}

	/** The lease the work under way holds; outside `hold`, a call takes one of its own. */
	#leased<T>(work: (lease: number) => Promise<T>): Promise<T> {
		return this.hold(() => work(this.#held.getStore()!));
	}

	/** One of pim-computer's calls, on the machine. */
	call<T>(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
		if (!CALLS.has(op)) return Promise.reject(new HttpError(409, `The Cua evaluation computer doesn't take ${op}: its browser is driven through cua-driver, not DevTools.`));
		return this.#leased(async (lease) => {
			const answer = await this.#agentPost<{ result?: unknown; error?: { message?: unknown; code?: unknown } }>("call", { op, args, lease }, timeoutMs + 30_000);
			if (answer.error) throw callError(answer.error);
			return answer.result as T;
		});
	}

	/** One cua-driver tool, for the agents' browser (./cua-browser.ts). */
	driver(tool: string, args: Record<string, unknown>): Promise<DriverAnswer> {
		return this.#leased((lease) => this.#agentPost<DriverAnswer>("driver", { tool, arguments: args, lease }, 100_000));
	}

	/** An agent call: the bridge refusing its lease means the machine isn't the agents' any more, which this space then shows. */
	async #agentPost<T>(route: "call" | "driver", body: unknown, timeoutMs: number): Promise<T> {
		try {
			return await this.#post<T>(route, body, timeoutMs);
		} catch (error) {
			if (error instanceof HttpError && error.status === 423) {
				const control = this.#control();
				if (control.mode === "agents") this.#setControl({ ...control, mode: "pausing", generation: control.generation + 1, lease: null, at: Date.now() });
			}
			throw error;
		}
	}

	/** One at a time: pausing, resuming and minting a viewer ticket. */
	#serially<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#transition.then(work, work);
		this.#transition = next.catch(() => {});
		return next;
	}

	/** Stops the agents' calls from starting here at once, and asks the bridge to take none of theirs; `settle` finishes it. */
	async pause(): Promise<CuaStatus> {
		if (!this.active()) throw new HttpError(404, "The Cua evaluation isn't on in this space.");
		const control = this.#control();
		if (control.mode === "agents") this.#setControl({ ...control, mode: "pausing", generation: control.generation + 1, lease: null, at: Date.now() });
		return this.settle();
	}

	/**
	 * A pause is complete once nothing of the agents' runs, here or on the
	 * machine. The bridge is told at once, so it takes no call under the
	 * agents' lease from then on, and decides when the machine is the
	 * person's. Asking it again while paused keeps the space in step: if
	 * the bridge no longer says the machine is the person's, the pause isn't
	 * complete here either.
	 */
	settle(): Promise<CuaStatus> {
		return this.#serially(async () => {
			const control = this.#control();
			if (!this.active() || control.mode === "agents") return this.view();
			const said = await this.#post<BridgeView>("pause", {}, 15_000);
			const human = said.mode === "human" && typeof said.epoch === "number";
			this.#remote = human ? 0 : Number(said.inflight ?? 0) + Number(said.background ?? 0);
			const now = this.#control();
			if (now.mode === "agents" || now.generation !== control.generation) return this.view();
			if (human && this.#pending === 0) {
				if (now.mode !== "paused" || now.epoch !== said.epoch) this.#setControl({ ...now, mode: "paused", lease: null, epoch: said.epoch as number, at: Date.now() });
			} else if (now.mode === "paused") {
				this.#setControl({ ...now, mode: "pausing", generation: now.generation + 1, epoch: null, at: Date.now() });
			} else {
				this.#changed();
			}
			return this.view();
		});
	}

	/** The agents may use the machine again: only for the pause the person saw, `generation`, and only once it's complete. */
	resume(generation: unknown): Promise<CuaStatus> {
		return this.#serially(async () => {
			if (!this.active()) throw new HttpError(404, "The Cua evaluation isn't on in this space.");
			const control = this.#control();
			if (control.mode === "agents") throw new HttpError(409, "Agents aren't paused.");
			if (generation !== control.generation) throw new HttpError(409, "This pause has ended or changed since. Look again before resuming.");
			if (control.mode !== "paused" || control.epoch === null) throw new HttpError(409, "Agents' work is still finishing on the computer. Resume once the pause is complete.");
			let said: BridgeView;
			try {
				said = await this.#post<BridgeView>("resume", { epoch: control.epoch }, 30_000);
			} catch (error) {
				// The machine changed hands since, or a viewer session wouldn't close: look again before anything else.
				if (error instanceof HttpError && error.status === 409) this.#setControl({ ...control, mode: "pausing", generation: control.generation + 1, epoch: null, at: Date.now() });
				throw error;
			}
			if (said.mode !== "agents" || typeof said.epoch !== "number") throw new HttpError(502, "The Cua bridge didn't hand the computer to the agents.");
			this.#setControl({ mode: "agents", generation: control.generation + 1, lease: said.epoch, epoch: null, at: Date.now() });
			return this.view();
		});
	}

	/**
	 * A link to Cua's viewer for the person, with a ticket that lets them in
	 * for five minutes, made only once the pause is complete, as the bridge
	 * says when it makes it. The ticket is in the link's fragment, which no
	 * server sees.
	 */
	async viewer(): Promise<{ url: string; expiresAt: number }> {
		if (!this.active()) throw new HttpError(404, "The Cua evaluation isn't on in this space.");
		const before = await this.settle();
		if (before.mode !== "paused") {
			throw new HttpError(409, before.mode === "agents" ? "Pause the agents before opening the viewer." : "Agents' work is still finishing on the computer. Open the viewer once it has.");
		}
		return this.#serially(async () => {
			const { viewerPath, expiresAt } = await this.#post<{ viewerPath?: unknown; expiresAt?: unknown }>("viewer", {}, 20_000);
			if (typeof viewerPath !== "string" || !/^\/viewer\/#ticket=[A-Za-z0-9._~-]{16,512}$/.test(viewerPath)) throw new HttpError(502, "The Cua bridge's viewer link wasn't one Pim opens.");
			const after = this.#control();
			// Resumed meanwhile: the ticket goes unused, and opens nothing once the agents have the machine.
			if (after.mode !== "paused" || after.generation !== before.generation) throw new HttpError(409, "Agents were resumed meanwhile; the viewer stays closed.");
			return { url: `${this.#settings()!.base}${viewerPath}`, expiresAt: Number(expiresAt) * 1000 };
		});
	}

	/** Asks the bridge, with Pim's credential, following no redirect; what comes back is capped, and its errors say nothing of the credential. */
	async #post<T>(route: "status" | "call" | "driver" | "viewer" | "pause" | "resume", body: unknown, timeoutMs: number): Promise<T> {
		const settings = this.#settings();
		if (!settings) throw new HttpError(404, "This space isn't part of the Cua evaluation.");
		const scrub = (text: string) => text.split(settings.token).join("[redacted]").slice(0, MAX_ERROR_CHARS);
		let response: Response;
		try {
			response = await fetch(`${settings.base}${CUA_BRIDGE_PREFIX}${route}`, {
				method: "POST",
				redirect: "manual",
				headers: { "content-type": "application/json", [CUA_BRIDGE_AUTH_HEADER]: `Bearer ${settings.token}` },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			this.#reachable = false;
			throw new HttpError(504, "The Cua evaluation computer didn't answer.");
		}
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel().catch(() => {});
			throw new HttpError(502, "The Cua bridge answered with a redirect, which Pim doesn't follow.");
		}
		let answer: { error?: { message?: unknown; code?: unknown } } & Record<string, unknown>;
		try {
			answer = JSON.parse(await readCapped(response, MAX_ANSWER_BYTES));
		} catch (error) {
			if (error instanceof HttpError) throw error;
			throw new HttpError(502, "The Cua bridge's answer wasn't JSON.");
		}
		this.#reachable = true;
		if (response.ok) return answer as T;
		const said = scrub(String(answer?.error?.message ?? ""));
		if (response.status === 401) throw new HttpError(502, "The Cua bridge refused Pim's credential.");
		if (response.status === 423) throw new HttpError(423, CUA_PAUSED_MESSAGE);
		if (response.status === 409) throw new HttpError(409, said || "The Cua computer is busy.");
		if (response.status === 429) throw new HttpError(503, "The Cua bridge is busy. Try again in a minute.");
		throw new HttpError(502, said || `The Cua bridge answered ${response.status}.`);
	}
}
