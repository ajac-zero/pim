// Amp's External API is the only transport here. No CLI, workspace or socket
// is involved, including while a turn is running.
import { OrbAuthError, OrbError, OrbLostError, OrbUnreachableError, OrbUnsupportedError, type OrbClient, type OrbMessage, type OrbStart, type OrbStatus, type OrbThread, type OrbUsage } from "./types";

export const AMP_HTTP_UNSUPPORTED = "not supported by Amp's HTTP API yet";
export const AMP_HTTP_AUTH_REJECTED = "Amp rejected the saved token for the HTTP API; a PAT with amp.api:threads:create + amp.api:threads:view is needed, save it in the same Amp Connect field";

/** Stored in the thread DO. claim must atomically insert only when absent. */
export interface AmpHttpStore {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
	claim(key: string, value: unknown): Promise<boolean>;
}
export type AmpHttpOptions = {
	store: AmpHttpStore;
	/** The existing coding vault's amp credential, not a separate HTTP login. */
	token: () => Promise<string | null>;
	fetch?: typeof fetch;
	now?: () => number;
	/** Optional credentials from the deployment's vault; never use the PAT for usage. */
	m2m?: () => Promise<{ clientId: string; clientSecret: string } | null>;
};
type Progress = { startedAt: number; working: boolean; errorAt: number | null };
type StartRecord = { pending: true; failure?: string } | { thread: OrbThread };
type Retry = { attempts: number; at: number; failure?: string };
const redact = (text: string): string => text.replace(/sgamp_[A-Za-z0-9_.-]*/g, "[redacted]").replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]");
const snippet = (text: string): string => redact(text).replace(/\s+/g, " ").trim().slice(0, 200);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const timestamp = (value: unknown): number | null => {
	const n = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(n) ? n : null;
};

export class AmpHttpOrbClient implements OrbClient {
	readonly id = "amp-http";
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#lastStatus = 0;
	#failure: string | undefined;
	constructor(readonly options: AmpHttpOptions) {
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#now = options.now ?? Date.now;
	}
	capabilities() { return { steer: false, stop: false, usage: this.options.m2m !== undefined }; }
	async steer(_id: string, _message: string): Promise<void> { throw new OrbUnsupportedError(AMP_HTTP_UNSUPPORTED); }
	async stop(_id: string): Promise<void> { throw new OrbUnsupportedError(AMP_HTTP_UNSUPPORTED); }

	async start(start: OrbStart): Promise<OrbThread> {
		const project = projectName(start.project);
		const key = `amp:start:${start.idempotencyKey}`;
		const previous = await this.options.store.get(key) as StartRecord | null;
		if (previous && "thread" in previous) return previous.thread;
		if (previous || !await this.options.store.claim(key, { pending: true })) {
			const saved = await this.options.store.get(key) as StartRecord;
			if (saved && "thread" in saved) return saved.thread;
			// Amp documents no idempotency key or lookup by caller key. A lost
			// POST response cannot safely be retried, even after a DO restart.
			const failure = saved && "pending" in saved ? saved.failure : undefined;
			throw new OrbError(`Amp start outcome is uncertain${failure ? ` (first attempt: ${failure})` : ""}; check Amp before starting another thread`, "orb_start_uncertain");
		}
		this.#failure = undefined;
		try {
			const body = { project, message: start.prompt, ...(start.mode ? { agentMode: start.mode } : {}), ...(start.title ? { title: start.title } : {}) };
			const answer = await this.#request("/threads", { method: "POST", body: JSON.stringify(body) });
			const thread = object(answer.thread);
			if (typeof thread.id !== "string" || typeof thread.url !== "string") {
				const failure = `invalid thread handle (status ${this.#lastStatus}): ${snippet(JSON.stringify(answer))}`;
				this.#log("POST /threads", { status: this.#lastStatus, errMessage: "invalid thread handle" }, 0, 1);
				this.#failure = failure;
				throw new OrbError(`Amp returned an ${failure}; check Amp before starting another thread`, "orb_start_uncertain");
			}
			const handle = { threadId: thread.id, url: thread.url };
			// The handle is durable before the first metadata/messages request.
			await this.options.store.put(key, { thread: handle });
			await this.options.store.put(`amp:progress:${thread.id}`, { startedAt: this.#now(), working: false, errorAt: null });
			return handle;
		} catch (error) {
			// Only a definitive rejection permits another POST. Network failures,
			// malformed success responses and 5xx leave the reservation intact.
			if (error instanceof OrbAuthError || error instanceof AmpRateLimitError || error instanceof AmpBeforeSendError) await this.options.store.put(key, null);
			else await this.options.store.put(key, this.#failure ? { pending: true, failure: this.#failure } : { pending: true });
			throw error;
		}
	}

	async state(id: string): Promise<OrbStatus> {
		const answer = await this.#request(`/threads/${encodeURIComponent(id)}/metadata`);
		const agent = object(object(answer.thread).agentState);
		const key = `amp:progress:${id}`;
		const progress = (await this.options.store.get(key) as Progress | null) ?? { startedAt: this.#now(), working: false, errorAt: null };
		let state: OrbStatus["state"] = "working";
		if (agent.state === "working") progress.working = true;
		if (agent.state === "idle" && (progress.working || this.#now() - progress.startedAt >= 60_000)) state = "idle";
		if (agent.state === "awaiting_approval") state = "awaiting_approval";
		if (agent.state === "error") {
			progress.errorAt ??= this.#now();
			if (this.#now() - progress.errorAt >= 120_000) state = "error";
		} else progress.errorAt = null;
		await this.options.store.put(key, progress);
		return { state, lastEventAt: timestamp(agent.updatedAt) };
	}

	async messages(id: string, o: { after?: string } = {}): Promise<readonly OrbMessage[]> {
		// Fetch cursor pages defensively. The caller's cursor is a message id,
		// not Amp's opaque page cursor, and must remain usable after a restart.
		const all: OrbMessage[] = [];
		const seen = new Set<string>();
		let cursor: string | null = null;
		for (let page = 0; page < 100; page++) {
			const answer = await this.#request(`/threads/${encodeURIComponent(id)}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
			const raw = Array.isArray(answer.messages) ? answer.messages : [];
			for (const value of raw) {
				const message = object(value);
				if (typeof message.messageID !== "string") continue;
				await this.options.store.put(`amp:message:${id}:${message.messageID}`, value);
				if (seen.has(message.messageID)) continue;
				seen.add(message.messageID);
				all.push({ id: message.messageID, role: message.role === "user" ? "user" : "assistant", at: timestamp(message.createdAt) ?? 0, text: typeof message.text === "string" ? message.text : JSON.stringify(value), raw: value });
			}
			const next = answer.nextCursor;
			if (typeof next !== "string" || !next || next === cursor) break;
			cursor = next;
			if (page === 99) throw new OrbUnreachableError("Amp transcript exceeded the page limit");
		}
		const index = o.after ? all.findIndex((m) => m.id === o.after) : -1;
		return all.slice(index + 1);
	}

	async usage(id: string): Promise<OrbUsage | null> {
		if (!this.options.m2m) throw new OrbUnsupportedError("Amp HTTP usage requires optional M2M credentials");
		const credentials = await this.options.m2m();
		if (!credentials) return null;
		const token = await this.#request("https://auth.ampcode.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.clientSecret, scope: "amp.api:workspace.threads.meta:view" }).toString() }, "");
		if (typeof token.access_token !== "string") throw new OrbAuthError("Amp M2M authentication failed");
		const usage = await this.#request(`/threads/${encodeURIComponent(id)}/usage`, {}, token.access_token);
		const usd = usage.usd;
		return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? { usd } : null;
	}

	async #request(path: string, init: RequestInit = {}, bearer?: string): Promise<Record<string, unknown>> {
		const token = bearer ?? await this.options.token();
		if (token === null) throw new OrbAuthError("Connect Amp using the existing Amp Connect field on the coding page");
		const key = `amp:retry:${path}`;
		const retry = await this.options.store.get(key) as Retry | null;
		if (retry && retry.attempts > 6) throw new OrbError("Amp HTTP API retry limit reached", "orb_retry_exhausted");
		if (retry && retry.at > this.#now()) throw new AmpBeforeSendError("Amp HTTP API is backing off", retry.at - this.#now());
		let response: Response;
		const began = this.#now();
		const op = `${(init.method ?? "GET").toUpperCase()} ${path.startsWith("https:") ? new URL(path).pathname : path.split("?")[0]}`;
		const attempt = (retry?.attempts ?? 0) + 1;
		try {
			response = await this.#fetch(path.startsWith("https:") ? path : `https://ampcode.com/api/v2${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
		} catch (error) {
			const elapsedMs = this.#now() - began;
			const errName = error instanceof Error ? error.name : "Error";
			const errMessage = snippet(error instanceof Error ? error.message : String(error));
			this.#log(op, { errName, errMessage }, elapsedMs, attempt);
			return this.#retry(key, retry, null, `${errMessage} after ${elapsedMs}ms`);
		}
		this.#lastStatus = response.status;
		const elapsedMs = this.#now() - began;
		if (!response.ok && response.status !== 404 && response.status !== 401 && response.status !== 403) {
			const body = snippet(await response.text().catch(() => ""));
			this.#log(op, { status: response.status, ...(body ? { errMessage: body } : {}) }, elapsedMs, attempt);
			const failure = `HTTP ${response.status}${body ? `: ${body}` : ""} after ${elapsedMs}ms`;
			if (response.status === 429 || response.status >= 500) return this.#retry(key, retry, response, failure);
			this.#failure = failure;
			throw new OrbError(`Amp HTTP API rejected the request (${response.status}${body ? `: ${body}` : ""})`, "orb_request");
		}
		if (response.status === 401 || response.status === 403) throw new OrbAuthError(bearer === undefined ? AMP_HTTP_AUTH_REJECTED : "Amp M2M authentication rejected");
		if (response.status === 404) throw new OrbLostError();
		await this.options.store.put(key, null);
		const text = await response.text().catch(() => "");
		try { return object(JSON.parse(text)); } catch {
			const body = snippet(text);
			const detail = `invalid JSON (status ${response.status}${body ? `: ${body}` : ""})`;
			this.#log(op, { status: response.status, errMessage: "invalid JSON" }, elapsedMs, attempt);
			this.#failure = `${detail} after ${elapsedMs}ms`;
			throw new OrbError(`Amp HTTP API returned ${detail}`, "orb_request");
		}
	}

	#log(op: string, detail: { status?: number; errName?: string; errMessage?: string }, elapsedMs: number, attempt: number): void {
		console.warn(JSON.stringify({ event: "pim.coding.amp_http_failed", op, ...detail, elapsedMs, attempt }));
	}

	async #retry(key: string, retry: Retry | null, response: Response | null, failure: string): Promise<never> {
		this.#failure = failure;
		const attempts = (retry?.attempts ?? 0) + 1;
		if (attempts > 6) {
			await this.options.store.put(key, { attempts, at: 0, failure });
			throw new OrbError("Amp HTTP API retry limit reached", "orb_retry_exhausted");
		}
		const header = response?.headers.get("Retry-After");
		const seconds = header ? Number(header) : NaN;
		const requested = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - this.#now()) : 0;
		const delay = Math.max(15_000 * 2 ** (attempts - 1), Number.isFinite(requested) ? requested : 0);
		await this.options.store.put(key, { attempts, at: this.#now() + delay, failure });
		throw response?.status === 429 ? new AmpRateLimitError("Amp HTTP API is rate limited", delay) : new OrbUnreachableError(`Amp HTTP API is temporarily unavailable (${failure})`, delay);
	}
}
class AmpRateLimitError extends OrbUnreachableError {}
class AmpBeforeSendError extends OrbUnreachableError {}

/** The API accepts namespace/name, not a repository URL. */
export function projectName(project: string): string {
	if (/^[^/:\s]+\/[^/\s]+$/.test(project)) return project.replace(/\.git$/, "");
	try {
		const url = new URL(project);
		const name = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
		if (/^[^/]+\/[^/]+$/.test(name)) return name;
	} catch { /* Report a safe validation error, never the caller's URL. */ }
	throw new OrbError("Amp requires a project named namespace/name", "orb_request");
}
