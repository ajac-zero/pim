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
 * The person can pause their agents to use the machine themselves, in Cua's
 * viewer. While they are paused every call the agents' tools make here is
 * refused when it would run, whenever it was asked for or approved; a pause
 * waits for calls under way to finish, here and on the bridge, before the
 * viewer opens; and only the person resumes, naming the pause they end. The
 * pause is kept in the space's storage, so a restart keeps it.
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

/** Who is using the machine: the agents, or the person (`paused`), or the agents' calls still finishing before the person can (`pausing`). */
type Control = { readonly mode: CuaMode; readonly generation: number; readonly at: number };

export type CuaStatus = {
	/** Whether this space may use the evaluation. */
	readonly offered: boolean;
	/** Whether its agents use it now, in place of the space's other computer. */
	readonly enabled: boolean;
	readonly mode: CuaMode;
	/** Which pause or resume this is: resuming names it, so a stale page can't end a newer pause. */
	readonly generation: number;
	/** Agent calls under way in this space now. */
	readonly pending: number;
	readonly host: string | null;
};

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
	/** Agent calls under way here: a whole tool's calls count as one (`hold`). */
	#pending = 0;
	readonly #held = new AsyncLocalStorage<true>();
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

	enable(now: number): void {
		if (!this.offered()) throw new HttpError(404, "This space isn't part of the Cua evaluation.");
		if (!this.active()) this.#meta.setMeta(ENABLED_KEY, String(now));
	}

	/** The agents go back to the space's other computer, if it has one; a pause stays, for when it's turned on again. */
	disable(): void {
		this.#meta.deleteMeta(ENABLED_KEY);
	}

	#control(): Control {
		const kept = this.#meta.meta(CONTROL_KEY);
		return kept ? (JSON.parse(kept) as Control) : { mode: "agents", generation: 0, at: 0 };
	}

	#setControl(control: Control): void {
		this.#meta.setMeta(CONTROL_KEY, JSON.stringify(control));
		this.#changed();
	}

	view(): CuaStatus {
		const { mode, generation } = this.#control();
		const settings = this.#settings();
		return { offered: settings !== null, enabled: this.active(), mode, generation, pending: this.#pending, host: settings ? new URL(settings.base).host : null };
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

	/**
	 * Runs one agent tool's work on the machine, if the agents may use it
	 * now: checked once, here, when it starts, and counted under way until
	 * it ends, so a pause waits for it. The check and the count happen
	 * together, before anything else can run.
	 */
	async hold<T>(work: () => Promise<T>): Promise<T> {
		if (this.#held.getStore()) return work();
		if (!this.active()) throw new HttpError(404, "The Cua evaluation isn't on in this space.");
		if (this.#control().mode !== "agents") throw new HttpError(423, CUA_PAUSED_MESSAGE);
		this.#pending++;
		try {
			return await this.#held.run(true, work);
		} finally {
			this.#pending--;
			if (this.#pending === 0 && this.#control().mode === "pausing") void this.settle().catch(() => {});
		}
	}

	/** One of pim-computer's calls, on the machine. */
	call<T>(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
		if (!CALLS.has(op)) return Promise.reject(new HttpError(409, `The Cua evaluation computer doesn't take ${op}: its browser is driven through cua-driver, not DevTools.`));
		return this.hold(async () => {
			const answer = await this.#post<{ result?: unknown; error?: { message?: unknown; code?: unknown } }>("call", { op, args }, timeoutMs + 30_000);
			if (answer.error) throw callError(answer.error);
			return answer.result as T;
		});
	}

	/** One cua-driver tool, for the agents' browser (./cua-browser.ts). */
	driver(tool: string, args: Record<string, unknown>): Promise<DriverAnswer> {
		return this.hold(() => this.#post<DriverAnswer>("driver", { tool, arguments: args }, 100_000));
	}

	/** Stops the agents' calls from starting here, and waits for those under way. Answers at once; `settle` finishes it. */
	async pause(): Promise<CuaStatus> {
		if (!this.active()) throw new HttpError(404, "The Cua evaluation isn't on in this space.");
		const control = this.#control();
		if (control.mode === "agents") this.#setControl({ mode: "pausing", generation: control.generation + 1, at: Date.now() });
		return this.settle();
	}

	/**
	 * A pause is complete once no agent call is under way, here or on the
	 * bridge: a restarted space has forgotten what it had under way, so it
	 * asks the bridge too, and stays pausing while the bridge doesn't answer.
	 */
	async settle(): Promise<CuaStatus> {
		const control = this.#control();
		if (control.mode !== "pausing" || this.#pending > 0) return this.view();
		const { inflight } = await this.#post<{ inflight?: unknown }>("status", {}, 10_000);
		const now = this.#control();
		if (inflight === 0 && this.#pending === 0 && now.mode === "pausing" && now.generation === control.generation) {
			this.#setControl({ mode: "paused", generation: control.generation, at: Date.now() });
		}
		return this.view();
	}

	/** The agents may use the machine again: only for the pause the person saw, `generation`. */
	resume(generation: unknown): CuaStatus {
		const control = this.#control();
		if (control.mode === "agents") throw new HttpError(409, "Agents aren't paused.");
		if (generation !== control.generation) throw new HttpError(409, "This pause has ended or changed since. Look again before resuming.");
		this.#setControl({ mode: "agents", generation: control.generation + 1, at: Date.now() });
		return this.view();
	}

	/**
	 * A link to Cua's viewer for the person, with a ticket that lets them in
	 * for five minutes, made only while the agents are paused and nothing of
	 * theirs is under way. The ticket is in the link's fragment, which no
	 * server sees.
	 */
	async viewer(): Promise<{ url: string; expiresAt: number }> {
		if (!this.active()) throw new HttpError(404, "The Cua evaluation isn't on in this space.");
		const before = await this.settle();
		if (before.mode !== "paused") {
			throw new HttpError(409, before.mode === "agents" ? "Pause the agents before opening the viewer." : "Agents' work is still finishing on the computer. Open the viewer once it has.");
		}
		const { viewerPath, expiresAt } = await this.#post<{ viewerPath?: unknown; expiresAt?: unknown }>("viewer", {}, 20_000);
		if (typeof viewerPath !== "string" || !/^\/viewer\/#ticket=[A-Za-z0-9._~-]{16,512}$/.test(viewerPath)) throw new HttpError(502, "The Cua bridge's viewer link wasn't one Pim opens.");
		const after = this.#control();
		// Resumed meanwhile: the ticket goes unused, and expires.
		if (after.mode !== "paused" || after.generation !== before.generation) throw new HttpError(409, "Agents were resumed meanwhile; the viewer stays closed.");
		return { url: `${this.#settings()!.base}${viewerPath}`, expiresAt: Number(expiresAt) * 1000 };
	}

	/** Asks the bridge, with Pim's credential, following no redirect; what comes back is capped, and its errors say nothing of the credential. */
	async #post<T>(route: "status" | "call" | "driver" | "viewer", body: unknown, timeoutMs: number): Promise<T> {
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
		if (response.status === 409) throw new HttpError(409, said || "The Cua computer is busy.");
		if (response.status === 429) throw new HttpError(503, "The Cua bridge is busy. Try again in a minute.");
		throw new HttpError(502, said || `The Cua bridge answered ${response.status}.`);
	}
}
