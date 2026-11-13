// Amp's INTERNAL HTTPS API (POST /api/internal?<method>), the one the Amp CLI
// itself uses, is the only transport here. The documented /api/v2 rejects the
// sgamp_ access token with 401, so it is not used. No CLI, workspace or socket
// is involved, including while a turn is running.
//
// Verified live: resolveProjectByRepositoryURLs, createRemoteExecutorThread,
// getThreadTail, sendMessageToThread, archiveThread. There is no cancelThread:
// `stop` is archiveThread, which hides the thread but may NOT halt a running
// agent (unverified). Only Authorization and content-type headers are sent;
// the CLI's x-amp-* headers were not needed.
import { OrbAuthError, OrbError, OrbLostError, OrbUnreachableError, OrbUnsupportedError, type OrbClient, type OrbMessage, type OrbStart, type OrbStatus, type OrbThread, type OrbUsage } from "./types";

export const AMP_HTTP_UNSUPPORTED = "not supported by Amp: archiving may not halt a running agent";
const DEFAULT_BASE = "https://ampcode.com";
/** Upper bound on a response body read, and on one transcript message's text. */
export const AMP_MAX_RESPONSE_BYTES = 2_000_000;
export const AMP_MAX_MESSAGE_CHARS = 8_000;
const TAIL_LIMIT = 200;
const AGENT_MODES = new Set(["low", "medium", "high", "ultra"]);

/** Stored in the thread DO. claim must atomically insert only when absent. */
export interface AmpHttpStore {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
	claim(key: string, value: unknown): Promise<boolean>;
}
export type AmpHttpOptions = {
	store: AmpHttpStore;
	/** The existing coding vault's amp credential, sent as a Bearer token. */
	token: () => Promise<string | null>;
	fetch?: typeof fetch;
	now?: () => number;
	/** Defaults to https://ampcode.com. */
	baseUrl?: string;
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
const userState = () => ({ currentlyVisibleFiles: [], timeZone: "UTC" });
const textContent = (text: string) => [{ type: "text", text }];

/** Text blocks joined and capped; other block types (tool_use, tool_result…) become a short marker and never throw. */
function messageText(content: unknown): string {
	const parts: string[] = [];
	for (const block of Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) {
		const b = object(block);
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (typeof b.type === "string" && b.type !== "thinking") parts.push(`[${b.type.slice(0, 40)}]`);
	}
	const text = parts.join("\n");
	return text.length > AMP_MAX_MESSAGE_CHARS ? `${text.slice(0, AMP_MAX_MESSAGE_CHARS)}… [truncated]` : text;
}

export class AmpHttpOrbClient implements OrbClient {
	readonly id = "amp-http";
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #base: string;
	readonly #projects = new Map<string, string>();
	#lastStatus = 0;
	#failure: string | undefined;
	constructor(readonly options: AmpHttpOptions) {
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#now = options.now ?? Date.now;
		this.#base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
	}
	// `stop` is archiveThread: Amp's internal API has no cancel, and archiving may not halt a running agent.
	capabilities() { return { steer: true, stop: true, usage: false }; }
	async usage(_id: string): Promise<OrbUsage | null> { throw new OrbUnsupportedError("Amp's internal API reports no usage"); }

	async start(start: OrbStart): Promise<OrbThread> {
		const repositoryURL = repositoryUrl(start.project);
		const key = `amp:start:${start.idempotencyKey}`;
		const previous = await this.options.store.get(key) as StartRecord | null;
		if (previous && "thread" in previous) return previous.thread;
		// Resolving creates nothing, so a failure here never reserves the start.
		const projectID = await this.#project(repositoryURL);
		if (previous || !await this.options.store.claim(key, { pending: true })) {
			const saved = await this.options.store.get(key) as StartRecord;
			if (saved && "thread" in saved) return saved.thread;
			// Amp has no idempotency key or lookup by caller key. A lost
			// response cannot safely be retried, even after a DO restart.
			const failure = saved && "pending" in saved ? saved.failure : undefined;
			throw new OrbError(`Amp start outcome is uncertain${failure ? ` (first attempt: ${failure})` : ""}; check Amp before starting another thread`, "orb_start_uncertain");
		}
		this.#failure = undefined;
		try {
			const result = object(await this.#call("createRemoteExecutorThread", {
				agentMode: start.mode && AGENT_MODES.has(start.mode) ? start.mode : "medium",
				content: textContent(start.prompt),
				features: [],
				userState: userState(),
				projectID,
				executeMode: true,
				threadMeta: { visibility: "private", sharedGroupIDs: [] },
			}));
			if (typeof result.threadID !== "string" || !result.threadID) {
				const failure = `invalid thread handle (status ${this.#lastStatus}): ${snippet(JSON.stringify(result))}`;
				this.#log("POST createRemoteExecutorThread", { status: this.#lastStatus, errMessage: "invalid thread handle" }, 0, 1);
				this.#failure = failure;
				throw new OrbError(`Amp returned an ${failure}; check Amp before starting another thread`, "orb_start_uncertain");
			}
			const handle = { threadId: result.threadID, url: typeof result.url === "string" ? result.url : `${this.#base}/threads/${result.threadID}` };
			// The handle is durable before the first poll.
			await this.options.store.put(key, { thread: handle });
			await this.options.store.put(`amp:progress:${handle.threadId}`, { startedAt: this.#now(), working: false, errorAt: null });
			return handle;
		} catch (error) {
			// Only a definitive rejection permits another create. Network failures,
			// malformed success responses and 5xx leave the reservation intact.
			if (error instanceof OrbAuthError || error instanceof AmpRateLimitError || error instanceof AmpBeforeSendError || error instanceof AmpRedirectError || error instanceof AmpRejectedError) await this.options.store.put(key, null);
			else await this.options.store.put(key, this.#failure ? { pending: true, failure: this.#failure } : { pending: true });
			throw error;
		}
	}

	async steer(id: string, message: string): Promise<void> {
		await this.#call("sendMessageToThread", { threadID: id, content: textContent(message), userState: userState() }, id);
	}

	/** Archives the thread. It may not halt a running agent (unverified). */
	async stop(id: string): Promise<void> {
		await this.#call("archiveThread", { thread: id, archived: true }, id);
	}

	async state(id: string): Promise<OrbStatus> {
		const { thread } = await this.#tail(id, 1);
		const agent = object(object(object(thread.data).meta).lastKnownAgentState);
		const key = `amp:progress:${id}`;
		const progress = (await this.options.store.get(key) as Progress | null) ?? { startedAt: this.#now(), working: false, errorAt: null };
		let state: OrbStatus["state"] = "working";
		if (agent.state === "working") progress.working = true;
		if (agent.state === "idle" && (progress.working || this.#now() - progress.startedAt >= 60_000)) state = "idle";
		if (agent.state === "awaiting_approval") state = "awaiting_approval";
		if (agent.state !== undefined && !["working", "idle", "awaiting_approval", "error"].includes(String(agent.state))) {
			// Unknown states are treated as still working, never as finished.
			console.warn(JSON.stringify({ event: "pim.coding.amp_http_unknown_state", state: snippet(String(agent.state)).slice(0, 60) }));
		}
		if (agent.state === "error") {
			progress.errorAt ??= this.#now();
			if (this.#now() - progress.errorAt >= 120_000) state = "error";
		} else progress.errorAt = null;
		await this.options.store.put(key, progress);
		return { state, lastEventAt: timestamp(agent.updatedAt) };
	}

	async messages(id: string, o: { after?: string } = {}): Promise<readonly OrbMessage[]> {
		// The caller's cursor is a message id. Only the tail of the transcript is
		// read, and a smaller window is tried when the response is over the cap.
		let tail: { messages: unknown[] };
		try { tail = await this.#tail(id, TAIL_LIMIT); } catch (error) {
			if (!(error instanceof AmpTooLargeError)) throw error;
			tail = await this.#tail(id, 20);
		}
		const all: OrbMessage[] = [];
		const seen = new Set<string>();
		for (const value of tail.messages) {
			const message = object(value);
			const messageId = typeof message.messageId === "string" ? message.messageId : typeof message.messageId === "number" ? String(message.messageId) : null;
			if (messageId === null || seen.has(messageId)) continue;
			seen.add(messageId);
			all.push({ id: messageId, role: message.role === "user" ? "user" : "assistant", at: timestamp(message.createdAt) ?? 0, text: messageText(message.content) });
		}
		const index = o.after ? all.findIndex((m) => m.id === o.after) : -1;
		return all.slice(index + 1);
	}

	async #tail(id: string, limit: number): Promise<{ thread: Record<string, unknown>; messages: unknown[] }> {
		const result = object(await this.#call("getThreadTail", { thread: id, limit }, id));
		return { thread: object(result.thread), messages: Array.isArray(result.messages) ? result.messages : [] };
	}

	async #project(repositoryURL: string): Promise<string> {
		const cached = this.#projects.get(repositoryURL);
		if (cached) return cached;
		const key = `amp:project:${repositoryURL}`;
		const saved = await this.options.store.get(key);
		if (typeof saved === "string" && saved) { this.#projects.set(repositoryURL, saved); return saved; }
		const result = object(await this.#call("resolveProjectByRepositoryURLs", { repositoryURLs: [repositoryURL] }));
		if (typeof result.projectID !== "string" || !result.projectID) throw new AmpRejectedError("Amp has no project for this repository; connect it in Amp first");
		this.#projects.set(repositoryURL, result.projectID);
		await this.options.store.put(key, result.projectID);
		return result.projectID;
	}

	/** One internal API call. Returns the `result` of an `{"ok":true}` answer. `scope` is the thread the call is about, if any. */
	async #call(method: string, params: Record<string, unknown>, scope = ""): Promise<unknown> {
		const token = await this.options.token();
		if (token === null) throw new OrbAuthError("Connect Amp using the existing Amp Connect field on the coding page");
		const clean = (text: string): string => {
			let out = redact(text);
			if (token) out = out.split(token).join("[redacted]");
			return out.replace(/\s+/g, " ").trim();
		};
		const key = `amp:retry:${method}:${scope}`;
		const retry = await this.options.store.get(key) as Retry | null;
		if (retry && retry.attempts > 6) throw new OrbError("Amp API retry limit reached", "orb_retry_exhausted");
		if (retry && retry.at > this.#now()) throw new AmpBeforeSendError("Amp API is backing off", retry.at - this.#now());
		let response: Response;
		const began = this.#now();
		const op = `POST ${method}`;
		const attempt = (retry?.attempts ?? 0) + 1;
		try {
			response = await this.#fetch(`${this.#base}/api/internal?${method}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
		} catch (error) {
			const elapsedMs = this.#now() - began;
			const errName = error instanceof Error ? error.name : "Error";
			const errMessage = clean(error instanceof Error ? error.message : String(error)).slice(0, 200);
			this.#log(op, { errName, errMessage }, elapsedMs, attempt);
			return this.#retry(key, retry, null, `${errMessage} after ${elapsedMs}ms`);
		}
		this.#lastStatus = response.status;
		const elapsedMs = this.#now() - began;
		// Never follow redirects (the bearer token must not reach another host).
		// Workers rejects redirect:"error", so detect them after the fact.
		if ((response.type as string) === "opaqueredirect" || (response.status >= 300 && response.status <= 399)) {
			this.#log(op, { status: response.status, errMessage: "redirected" }, elapsedMs, attempt);
			await response.body?.cancel().catch(() => {});
			throw new AmpRedirectError(`Amp API redirected (status ${response.status}); refusing to follow`);
		}
		let text: string;
		try { text = await readBounded(response); } catch (error) {
			if (error instanceof AmpTooLargeError) { this.#log(op, { status: response.status, errMessage: "response too large" }, elapsedMs, attempt); throw error; }
			text = "";
		}
		if (response.status === 401 || response.status === 403) {
			const body = clean(text).slice(0, 500);
			const headers: Record<string, string> = {};
			for (const name of ["www-authenticate", "x-request-id", "cf-ray"]) {
				const value = response.headers.get(name);
				if (value) headers[name] = clean(value).slice(0, 200);
			}
			this.#log(op, { status: response.status, ...(body ? { errMessage: body } : {}), ...(Object.keys(headers).length ? { headers } : {}) }, elapsedMs, attempt);
			throw new OrbAuthError(`Amp rejected the saved token (HTTP ${response.status})${body ? `: ${body}` : ""}`);
		}
		if (response.status === 404) throw new OrbLostError();
		if (!response.ok) {
			const body = clean(text).slice(0, 200);
			this.#log(op, { status: response.status, ...(body ? { errMessage: body } : {}) }, elapsedMs, attempt);
			const failure = `HTTP ${response.status}${body ? `: ${body}` : ""} after ${elapsedMs}ms`;
			if (response.status === 429 || response.status >= 500) return this.#retry(key, retry, response, failure);
			this.#failure = failure;
			throw new AmpRejectedError(`Amp API rejected the request (${response.status}${body ? `: ${body}` : ""})`);
		}
		await this.options.store.put(key, null);
		let answer: Record<string, unknown>;
		try { answer = object(JSON.parse(text)); } catch {
			const body = clean(text).slice(0, 200);
			const detail = `invalid JSON (status ${response.status}${body ? `: ${body}` : ""})`;
			this.#log(op, { status: response.status, errMessage: "invalid JSON" }, elapsedMs, attempt);
			this.#failure = `${detail} after ${elapsedMs}ms`;
			throw new OrbError(`Amp API returned ${detail}`, "orb_request");
		}
		if (answer.ok === false) {
			const error = object(answer.error);
			const code = typeof error.code === "string" ? clean(error.code).slice(0, 60) : "error";
			const message = typeof error.message === "string" ? clean(error.message).slice(0, 200) : "";
			this.#log(op, { status: response.status, errMessage: `${code}${message ? `: ${message}` : ""}` }, elapsedMs, attempt);
			if (/unauthori[sz]ed|forbidden/i.test(code)) throw new OrbAuthError(`Amp rejected the saved token (${code})${message ? `: ${message}` : ""}`);
			if (scope && /not[-_ ]?found/i.test(code)) throw new OrbLostError();
			this.#failure = `${code}${message ? `: ${message}` : ""}`;
			throw new AmpRejectedError(`Amp API rejected the request (${code}${message ? `: ${message}` : ""})`);
		}
		if (answer.ok !== true) {
			this.#log(op, { status: response.status, errMessage: "unexpected response shape" }, elapsedMs, attempt);
			this.#failure = `unexpected response shape (status ${response.status})`;
			throw new OrbError(`Amp API returned an unexpected response (status ${response.status})`, "orb_request");
		}
		return answer.result;
	}

	#log(op: string, detail: { status?: number; errName?: string; errMessage?: string; headers?: Record<string, string> }, elapsedMs: number, attempt: number): void {
		console.warn(JSON.stringify({ event: "pim.coding.amp_http_failed", op, ...detail, elapsedMs, attempt }));
	}

	async #retry(key: string, retry: Retry | null, response: Response | null, failure: string): Promise<never> {
		this.#failure = failure;
		const attempts = (retry?.attempts ?? 0) + 1;
		if (attempts > 6) {
			await this.options.store.put(key, { attempts, at: 0, failure });
			throw new OrbError("Amp API retry limit reached", "orb_retry_exhausted");
		}
		const header = response?.headers.get("Retry-After");
		const seconds = header ? Number(header) : NaN;
		const requested = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - this.#now()) : 0;
		const delay = Math.max(15_000 * 2 ** (attempts - 1), Number.isFinite(requested) ? requested : 0);
		await this.options.store.put(key, { attempts, at: this.#now() + delay, failure });
		throw response?.status === 429 ? new AmpRateLimitError("Amp API is rate limited", delay) : new OrbUnreachableError(`Amp API is temporarily unavailable (${failure})`, delay);
	}
}
class AmpRateLimitError extends OrbUnreachableError {}
class AmpBeforeSendError extends OrbUnreachableError {}
class AmpRedirectError extends OrbError { constructor(message: string) { super(message, "orb_request"); } }
/** A definitive refusal (4xx or ok:false): nothing was created. */
class AmpRejectedError extends OrbError { constructor(message: string) { super(message, "orb_request"); } }
class AmpTooLargeError extends OrbError { constructor() { super("Amp API response exceeded the size cap", "orb_request"); } }

/** Reads a body up to the cap, so a huge transcript cannot exhaust memory. */
async function readBounded(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let size = 0;
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > AMP_MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); throw new AmpTooLargeError(); }
		out += decoder.decode(value, { stream: true });
	}
	return out + decoder.decode();
}

/** Amp resolves a project from a repository URL; `namespace/name` is taken as a GitHub repository. */
export function repositoryUrl(project: string): string {
	if (/^[^/:\s]+\/[^/\s]+$/.test(project)) return `https://github.com/${project.replace(/\.git$/, "")}`;
	try {
		const url = new URL(project);
		const name = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
		if (url.protocol === "https:" && /^[^/]+\/[^/]+$/.test(name)) return `https://${url.host}/${name}`;
	} catch { /* Report a safe validation error, never the caller's URL. */ }
	throw new OrbError("Amp requires a project named namespace/name or an https repository URL", "orb_request");
}
