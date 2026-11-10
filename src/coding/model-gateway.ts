import type { Api, Model, ModelCost } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai/models";
import { base64UrlDecode, base64UrlEncode } from "../auth/encoding";

/**
 * The model gateway: how a vendor CLI in a coding workspace, such as Claude
 * Code or Codex, calls a model without the space's provider key ever
 * entering the workspace. The CLI is pointed at Pim
 * (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, see `sandboxModelEnv`) and signs
 * in with a gateway token instead of a key: signed by Pim, bound to one
 * thread, its space and the provider families it may call, good until the
 * thread's time limit runs out (and a margin), and revoked when the thread
 * is aborted or archived. Pim checks the token, the thread's budget and its
 * request caps, adds the space's own key for that family, sends the request
 * on, and passes the answer back as the provider sent it, server-sent events
 * included, while reading the usage it reports to charge the thread.
 *
 * The routes, under `/api` (`MODEL_GATEWAY_PATH`):
 *
 * - `/coding/gateway/anthropic/v1/messages` and
 *   `/coding/gateway/anthropic/v1/messages/count_tokens`: Anthropic's
 *   Messages API, POST only, with `?beta=true` allowed.
 * - `/coding/gateway/openai/v1/responses` and
 *   `/coding/gateway/openai/v1/chat/completions`: OpenAI's Responses and
 *   Chat Completions APIs, POST only.
 *
 * Nothing else is forwarded. The thread's Durable Object does the checking
 * and the forwarding (`CodingThreadDO.gatewayRequest`); this module holds the
 * parts that don't need it.
 */

/** A family of model APIs the gateway forwards to, named as the built-in provider whose key it uses. */
export type GatewayFamily = "anthropic" | "openai";
export const GATEWAY_FAMILIES: readonly GatewayFamily[] = ["anthropic", "openai"];

/** A vendor CLI the gateway serves, and the family it calls. */
export type GatewayHarness = "claude-code" | "codex";
export const HARNESS_FAMILY: Readonly<Record<GatewayHarness, GatewayFamily>> = { "claude-code": "anthropic", codex: "openai" };

/** The gateway's routes, under `/api`. */
export const MODEL_GATEWAY_PATH = "/coding/gateway";

/** How long a token outlives the thread's time limit. */
export const GATEWAY_TOKEN_MARGIN_MS = 15 * 60_000;

/** The caps on one thread's use of the gateway. */
export type GatewayLimits = {
	/** Requests a thread may start in any minute. */
	readonly requestsPerMinute: number;
	/** Requests a thread may have under way at once. */
	readonly concurrent: number;
	/** The largest request body, in bytes. */
	readonly maxRequestBytes: number;
	/** How long the provider may take to start its answer. */
	readonly headersTimeoutMs: number;
	/** How long an answer may go without a byte. */
	readonly idleTimeoutMs: number;
	/** How long one request may take in all. */
	readonly totalTimeoutMs: number;
};

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
	requestsPerMinute: 120,
	concurrent: 4,
	maxRequestBytes: 16 * 1024 * 1024,
	// The Messages API may think for minutes before a non-streamed answer's first byte.
	headersTimeoutMs: 10 * 60_000,
	idleTimeoutMs: 5 * 60_000,
	totalTimeoutMs: 30 * 60_000,
};

/** The space's key for a family, as the gateway uses it: never stored by the thread, logged, or returned. */
export type GatewayCredential = { readonly providerId: string; readonly url: string; readonly key: string };

// Tokens

const TOKEN_PREFIX = "pimgw_";
const encoder = new TextEncoder();

/** What a gateway token lets its holder do: call `families` for thread `threadId` of `space` while `nonce` is the thread's and until `expiresAt`. */
export type GatewayClaims = {
	readonly threadId: string;
	readonly space: string;
	readonly families: readonly GatewayFamily[];
	readonly nonce: string;
	readonly expiresAt: number;
};

/** The key gateway tokens are signed with, derived from `secret` for this use alone. */
export async function gatewayKey(secret: string | Uint8Array): Promise<CryptoKey> {
	const raw = typeof secret === "string" ? encoder.encode(secret) : secret;
	const base = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("pim model gateway token v1") }, base, 256);
	return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

let keyPromise: Promise<CryptoKey> | null = null;

/** The key this Pim signs gateway tokens with, derived from the Directory's own key and read once per isolate. */
export function gatewayTokenKey(env: Env): Promise<CryptoKey> {
	if (!keyPromise) {
		const key = env.Directory.getByName("directory")
			.cookieKey()
			.then((raw) => gatewayKey(base64UrlDecode(raw)));
		keyPromise = key;
		key.catch(() => {
			if (keyPromise === key) keyPromise = null;
		});
	}
	return keyPromise;
}

export async function issueGatewayToken(key: CryptoKey, claims: GatewayClaims): Promise<string> {
	const payload = { v: 1, tid: claims.threadId, sub: claims.space, fam: claims.families, n: claims.nonce, exp: claims.expiresAt };
	const signed = `${TOKEN_PREFIX}${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}`;
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signed)));
	return `${signed}.${base64UrlEncode(mac)}`;
}

/** The claims of a gateway token signed with `key` that hasn't expired, or null. WebCrypto compares the signature in constant time. */
export async function verifyGatewayToken(key: CryptoKey, token: string, now = Date.now()): Promise<GatewayClaims | null> {
	if (typeof token !== "string" || token.length > 2048 || !token.startsWith(TOKEN_PREFIX)) return null;
	const [payload, mac, ...rest] = token.slice(TOKEN_PREFIX.length).split(".");
	if (!payload || !mac || rest.length > 0) return null;
	try {
		if (!(await crypto.subtle.verify("HMAC", key, base64UrlDecode(mac), encoder.encode(`${TOKEN_PREFIX}${payload}`)))) return null;
		const { v, tid, sub, fam, n, exp } = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Record<string, unknown>;
		if (v !== 1 || typeof tid !== "string" || typeof sub !== "string" || typeof n !== "string" || typeof exp !== "number") return null;
		if (!Array.isArray(fam) || fam.length === 0 || !fam.every((family) => GATEWAY_FAMILIES.includes(family as GatewayFamily))) return null;
		return exp > now ? { threadId: tid, space: sub, families: fam as GatewayFamily[], nonce: n, expiresAt: exp } : null;
	} catch {
		return null;
	}
}

/** A fresh nonce for a thread's tokens. */
export const newGatewayNonce = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)));

/** Whether a token's nonce is the thread's, compared in constant time. */
export function sameNonce(given: string, expected: string): boolean {
	const a = encoder.encode(given);
	const b = encoder.encode(expected);
	return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** The token a CLI presents: `x-api-key`, as Anthropic's clients send it, or a bearer token, as OpenAI's do. */
export function presentedGatewayToken(request: Request): string | null {
	const key = request.headers.get("x-api-key");
	if (key) return key.trim();
	const header = request.headers.get("authorization") ?? "";
	return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

// What the workspace is given

/** What a workspace's CLI needs to call its model through the gateway: its environment, and the one host it must reach. */
export type SandboxModelEnv = { readonly env: Readonly<Record<string, string>>; readonly egressHost: string };

/** The environment for `harness` in a workspace, with `token` (`CodingThreadDO.gatewayToken`) as its key and Pim at `origin` as its provider. */
export function sandboxModelEnv(origin: string, harness: GatewayHarness, token: string): SandboxModelEnv {
	const base = `${new URL(origin).origin}/api${MODEL_GATEWAY_PATH}`;
	const env: Record<string, string> =
		HARNESS_FAMILY[harness] === "anthropic"
			? { ANTHROPIC_BASE_URL: `${base}/anthropic`, ANTHROPIC_API_KEY: token }
			: { OPENAI_BASE_URL: `${base}/openai/v1`, OPENAI_API_KEY: token, CODEX_API_KEY: token };
	return { env, egressHost: new URL(origin).hostname };
}

// Routes and errors

/** The APIs the gateway forwards, each metered its own way. */
export type GatewayApi = "anthropic-messages" | "anthropic-count-tokens" | "openai-responses" | "openai-chat";

const ROUTES: Readonly<Record<GatewayFamily, Readonly<Record<string, GatewayApi>>>> = {
	anthropic: { "/v1/messages": "anthropic-messages", "/v1/messages/count_tokens": "anthropic-count-tokens" },
	openai: { "/v1/responses": "openai-responses", "/v1/chat/completions": "openai-chat" },
};

/** Why the gateway refused a request, as its `x-pim-gateway-error` header and OpenAI's `code` say. */
export type GatewayErrorCode =
	| "invalid_token"
	| "family_not_allowed"
	| "not_found"
	| "method_not_allowed"
	| "invalid_request"
	| "too_large"
	| "rate_limited"
	| "too_many_concurrent"
	| "budget_exhausted"
	| "no_credential"
	| "upstream_refused_key"
	| "upstream_unreachable"
	| "upstream_timeout";

const ANTHROPIC_TYPES: Record<number, string> = {
	400: "invalid_request_error",
	401: "authentication_error",
	402: "billing_error",
	403: "permission_error",
	404: "not_found_error",
	405: "invalid_request_error",
	413: "request_too_large",
	429: "rate_limit_error",
};
const OPENAI_TYPES: Record<number, string> = { 401: "invalid_request_error", 402: "insufficient_quota", 403: "permission_error", 429: "rate_limit_error" };

/** A refusal in the shape the family's own API answers errors in, so its CLI shows the message. */
export function gatewayError(family: GatewayFamily, status: number, code: GatewayErrorCode, message: string, headers: Record<string, string> = {}): Response {
	const body =
		family === "anthropic"
			? { type: "error", error: { type: ANTHROPIC_TYPES[status] ?? "api_error", message } }
			: { error: { message, type: OPENAI_TYPES[status] ?? (status >= 500 ? "server_error" : "invalid_request_error"), param: null, code } };
	return Response.json(body, { status, headers: { "cache-control": "no-store", "x-pim-gateway-error": code, ...headers } });
}

/** The API a request is for, if the gateway forwards it, or the refusal. */
export function gatewayRoute(family: GatewayFamily, method: string, path: string, search: string): GatewayApi | Response {
	const api = ROUTES[family][path];
	if (!api) return gatewayError(family, 404, "not_found", `The Pim model gateway doesn't forward ${path}`);
	if (method !== "POST") return gatewayError(family, 405, "method_not_allowed", `${path} takes POST`, { allow: "POST" });
	// Anthropic's SDK asks for beta features as `?beta=true`; nothing else goes in a query.
	const allowed = search === "" || (family === "anthropic" && search === "?beta=true");
	if (!allowed) return gatewayError(family, 400, "invalid_request", "The Pim model gateway takes no query parameters here");
	return api;
}

/** The request's body, refused past `max` bytes whatever its length says; null when it is too large. */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
	if (Number(request.headers.get("content-length") ?? 0) > max) {
		await request.body?.cancel().catch(() => {});
		return null;
	}
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return body;
}

/**
 * The request's JSON, as the gateway reads it: the model it asks for and
 * whether it streams. A streamed Chat Completions request is made to report
 * its usage (`stream_options.include_usage`), which the provider otherwise
 * leaves out and the budget needs; any other body is sent on byte for byte.
 */
export function readGatewayBody(api: GatewayApi, raw: Uint8Array): { model: string; body: Uint8Array } | string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return "The body must be JSON";
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "The body must be a JSON object";
	const request = parsed as Record<string, unknown>;
	if (typeof request.model !== "string" || !/^[\w.:@/+-]{1,200}$/.test(request.model)) return "The body must name a model";
	if (api === "openai-chat" && request.stream === true) {
		const options = request.stream_options !== null && typeof request.stream_options === "object" ? (request.stream_options as Record<string, unknown>) : {};
		if (options.include_usage !== true) return { model: request.model, body: encoder.encode(JSON.stringify({ ...request, stream_options: { ...options, include_usage: true } })) };
	}
	return { model: request.model, body: raw };
}

/** Request headers the provider is sent besides its key: what says how to answer, nothing about the caller. */
const FORWARDED_REQUEST_HEADERS = ["accept", "anthropic-version", "anthropic-beta", "openai-beta", "user-agent"];

/** Answer headers passed back: what describes the answer and the provider's rate limits, nothing about the account or the connection. */
const FORWARDED_RESPONSE_HEADER = /^(content-type|cache-control|retry-after|request-id|x-request-id|openai-processing-ms|anthropic-ratelimit-[a-z0-9-]+|x-ratelimit-[a-z0-9-]+)$/;

/** The headers for the provider: the forwarded ones, the JSON body's type, and the space's key as the family takes it. */
export function upstreamHeaders(family: GatewayFamily, request: Request, key: string): Headers {
	const headers = new Headers();
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	headers.set("content-type", "application/json");
	if (family === "anthropic") {
		headers.set("x-api-key", key);
		if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
	} else headers.set("authorization", `Bearer ${key}`);
	return headers;
}

export function downstreamHeaders(upstream: Headers): Headers {
	const headers = new Headers();
	for (const [name, value] of upstream) if (FORWARDED_RESPONSE_HEADER.test(name)) headers.set(name, value);
	headers.set("x-content-type-options", "nosniff");
	return headers;
}

// Usage

/** Tokens a call used, as the thread's log keeps them: `input` without the cached tokens. */
export type TokenUsage = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };

/** What a finished answer reported, or null when it didn't report usage (it was cut short, or wasn't JSON). */
export type MeteredAnswer = { readonly usage: TokenUsage | null; readonly model: string | null; readonly bytes: number };

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The most of one server-sent event, or of a non-streamed answer, the meter reads; past it, that event's usage is missed. */
const MAX_METERED_BYTES = 8 * 1024 * 1024;

/**
 * Reads the usage an answer reports as its bytes pass, without changing or
 * keeping them: a streamed answer is read one server-sent event at a time,
 * keeping only the event under way; a JSON answer is kept until it ends,
 * up to 8 MiB, to read its `usage`.
 *
 * - Messages API: `message_start` carries the input and cache tokens, and
 *   each `message_delta` the output so far (and newer API versions the
 *   input again); the last of each counts.
 * - Responses API: `response.completed` (or `incomplete`, or `failed`)
 *   carries the whole call's usage; `input_tokens` includes the cached.
 * - Chat Completions: the last chunk carries `usage`; `prompt_tokens`
 *   includes the cached.
 */
export class UsageMeter {
	readonly #api: GatewayApi;
	readonly #streamed: boolean;
	readonly #decoder = new TextDecoder();
	#line = "";
	#event: string[] = [];
	#eventBytes = 0;
	#skipping = false;
	#json: Uint8Array[] | null = [];
	#bytes = 0;
	#usage: Record<keyof TokenUsage, number> | null = null;
	#model: string | null = null;

	constructor(api: GatewayApi, streamed: boolean) {
		this.#api = api;
		this.#streamed = streamed;
	}

	push(chunk: Uint8Array): void {
		this.#bytes += chunk.byteLength;
		if (!this.#streamed) {
			if (this.#json && this.#bytes <= MAX_METERED_BYTES) this.#json.push(chunk);
			else this.#json = null;
			return;
		}
		const lines = (this.#line + this.#decoder.decode(chunk, { stream: true })).split("\n");
		this.#line = lines.pop() ?? "";
		if (this.#line.length > MAX_METERED_BYTES) {
			this.#line = "";
			this.#skipping = true;
		}
		for (const line of lines) this.#readLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	}

	finish(): MeteredAnswer {
		if (this.#streamed) {
			const rest = this.#line + this.#decoder.decode();
			if (rest) this.#readLine(rest);
			this.#readLine("");
		} else if (this.#json) {
			const body = new Uint8Array(this.#bytes);
			let at = 0;
			for (const chunk of this.#json) {
				body.set(chunk, at);
				at += chunk.byteLength;
			}
			try {
				const answer = JSON.parse(new TextDecoder().decode(body)) as unknown;
				if (isObject(answer)) {
					if (typeof answer.model === "string") this.#model = answer.model;
					if (isObject(answer.usage)) this.#apply(answer.usage);
				}
			} catch {}
		}
		return { usage: this.#usage, model: this.#model, bytes: this.#bytes };
	}

	#readLine(line: string): void {
		if (line === "") {
			if (!this.#skipping && this.#event.length > 0) this.#dispatch(this.#event.join("\n"));
			this.#event = [];
			this.#eventBytes = 0;
			this.#skipping = false;
			return;
		}
		if (this.#skipping || !line.startsWith("data:")) return;
		const data = line.slice(line.startsWith("data: ") ? 6 : 5);
		this.#eventBytes += data.length;
		if (this.#eventBytes > MAX_METERED_BYTES) {
			this.#event = [];
			this.#skipping = true;
			return;
		}
		this.#event.push(data);
	}

	#dispatch(data: string): void {
		if (!data.includes('"usage"')) return;
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (!isObject(event)) return;
		if (this.#api === "anthropic-messages") {
			if (event.type === "message_start" && isObject(event.message)) {
				if (typeof event.message.model === "string") this.#model = event.message.model;
				if (isObject(event.message.usage)) this.#apply(event.message.usage);
			} else if (event.type === "message_delta" && isObject(event.usage)) this.#apply(event.usage);
		} else if (this.#api === "openai-responses") {
			if (typeof event.type === "string" && /^response\.(completed|incomplete|failed)$/.test(event.type) && isObject(event.response)) {
				if (typeof event.response.model === "string") this.#model = event.response.model;
				if (isObject(event.response.usage)) this.#apply(event.response.usage);
			}
		} else if (this.#api === "openai-chat" && isObject(event.usage)) {
			if (typeof event.model === "string") this.#model = event.model;
			this.#apply(event.usage);
		}
	}

	/** Takes the fields a usage object reports, over what earlier ones said. */
	#apply(usage: Record<string, unknown>): void {
		const now = { ...(this.#usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) };
		if (this.#api.startsWith("anthropic")) {
			if ("input_tokens" in usage) now.input = count(usage.input_tokens);
			if ("output_tokens" in usage) now.output = count(usage.output_tokens);
			if ("cache_read_input_tokens" in usage) now.cacheRead = count(usage.cache_read_input_tokens);
			if ("cache_creation_input_tokens" in usage) now.cacheWrite = count(usage.cache_creation_input_tokens);
		} else {
			const responses = this.#api === "openai-responses";
			const input = count(responses ? usage.input_tokens : usage.prompt_tokens);
			const details = responses ? usage.input_tokens_details : usage.prompt_tokens_details;
			const cached = Math.min(input, count(isObject(details) ? details.cached_tokens : 0));
			now.input = input - cached;
			now.cacheRead = cached;
			now.output = count(responses ? usage.output_tokens : usage.completion_tokens);
		}
		this.#usage = now;
	}
}

/**
 * What an answer is charged as when it didn't report its usage, such as one
 * the CLI cut short before its last event: a token for every 4 bytes of the
 * request and of the answer, which overcounts rather than lets it go free.
 */
export function estimatedUsage(requestBytes: number, answerBytes: number): TokenUsage {
	return { input: Math.ceil(requestBytes / 4), output: Math.ceil(answerBytes / 4), cacheRead: 0, cacheWrite: 0 };
}

// Prices

let catalog: Promise<Map<GatewayFamily, readonly Model<Api>[]>> | undefined;

function catalogModels(): Promise<Map<GatewayFamily, readonly Model<Api>[]>> {
	catalog ??= import("../provider-catalog").then(({ getBuiltinModels }) => new Map(GATEWAY_FAMILIES.map((family) => [family, getBuiltinModels(family) as Model<Api>[]])));
	return catalog;
}

/**
 * A model's price, from pi-ai's catalog, the one the space's own providers
 * are priced from. A dated snapshot the catalog doesn't list, such as
 * `gpt-5-2025-08-07`, is priced as its model. A model the catalog doesn't
 * know at all is priced as the family's dearest (`fallback`), so a new
 * model never runs free.
 */
export async function gatewayPrice(family: GatewayFamily, model: string): Promise<{ model: Model<Api>; pricing: "catalog" | "fallback" }> {
	const models = (await catalogModels()).get(family) ?? [];
	const undated = model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
	const known = models.find((entry) => entry.id === model) ?? models.find((entry) => entry.id === undated);
	if (known) return { model: known, pricing: "catalog" };
	const dearest = models.reduce<Model<Api> | null>((top, entry) => (top === null || entry.cost.output > top.cost.output ? entry : top), null);
	return { model: dearest ?? ({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } satisfies ModelCost } as Model<Api>), pricing: "fallback" };
}

/** What a call cost in dollars at `model`'s price, its long-context tier included. */
export function gatewayCost(model: Model<Api>, usage: TokenUsage): number {
	return calculateCost(model, { ...usage, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
}

// Limits

/** A thread's request caps, in memory: every request of a thread goes to its one Durable Object. */
export class GatewayGate {
	#recent: number[] = [];
	#inFlight = 0;

	/** Lets a request start, or says which cap it hit and when to try again, in seconds. */
	admit(now: number, limits: GatewayLimits): { refused: "rate_limited" | "too_many_concurrent"; retryAfter: number } | null {
		this.#recent = this.#recent.filter((at) => at > now - 60_000);
		if (this.#recent.length >= limits.requestsPerMinute) return { refused: "rate_limited", retryAfter: Math.max(1, Math.ceil((this.#recent[0]! + 60_000 - now) / 1000)) };
		if (this.#inFlight >= limits.concurrent) return { refused: "too_many_concurrent", retryAfter: 1 };
		this.#recent.push(now);
		this.#inFlight++;
		return null;
	}

	release(): void {
		this.#inFlight = Math.max(0, this.#inFlight - 1);
	}

	get inFlight(): number {
		return this.#inFlight;
	}
}

// Forwarding

export type ForwardInput = {
	readonly family: GatewayFamily;
	readonly api: GatewayApi;
	readonly path: string;
	readonly search: string;
	readonly request: Request;
	readonly body: Uint8Array;
	readonly credential: GatewayCredential;
	readonly fetch: typeof fetch;
	readonly limits: GatewayLimits;
	/** Called once, when the answer has ended however it ended: with what it reported when it was passed on whole or in part, or null when the provider refused or failed. */
	readonly settle: (answer: MeteredAnswer | null) => void;
};

class GatewayTimeout extends Error {
	override readonly name = "GatewayTimeout";
}

/** The most of a provider's error answer passed back. */
const MAX_ERROR_BYTES = 64 * 1024;

/**
 * Sends the request to the provider with the space's key and passes its
 * answer back. A successful answer's bytes go back unchanged as they arrive,
 * read by a `UsageMeter` on the way. One that stops for longer than the
 * idle limit, or breaks off, ends with the API's own error event. An error
 * answer is passed back with the
 * key taken out wherever the provider repeated it, and a refusal of the key
 * itself is the gateway's own error, since the CLI's token was fine.
 */
export async function forwardToProvider(input: ForwardInput): Promise<Response> {
	const { family, credential, limits } = input;
	const abort = new AbortController();
	let settled = false;
	const timers: ReturnType<typeof setTimeout>[] = [];
	const settle = (answer: MeteredAnswer | null) => {
		if (settled) return;
		settled = true;
		for (const timer of timers) clearTimeout(timer);
		input.settle(answer);
	};
	timers.push(setTimeout(() => abort.abort(new GatewayTimeout("total")), limits.totalTimeoutMs));
	const headersTimer = setTimeout(() => abort.abort(new GatewayTimeout("headers")), limits.headersTimeoutMs);
	timers.push(headersTimer);
	let upstream: Response;
	try {
		upstream = await input.fetch(`${new URL(credential.url).origin}${input.path}`, {
			method: "POST",
			headers: upstreamHeaders(family, input.request, credential.key),
			body: input.body,
			signal: abort.signal,
			// A redirect could lead anywhere, key and all.
			redirect: "manual",
		});
	} catch {
		settle(null);
		const timedOut = abort.signal.reason instanceof GatewayTimeout;
		return gatewayError(family, timedOut ? 504 : 502, timedOut ? "upstream_timeout" : "upstream_unreachable", timedOut ? "The model provider didn't answer in time" : "The model provider couldn't be reached");
	}
	clearTimeout(headersTimer);
	if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
		const text = await errorText(upstream);
		settle(null);
		if (upstream.status === 401 || upstream.status === 403) {
			return gatewayError(family, 502, "upstream_refused_key", `The model provider refused the space's ${family} key (HTTP ${upstream.status}): check it in Pim's Settings → Model`);
		}
		if (upstream.status >= 300 && upstream.status < 400) return gatewayError(family, 502, "upstream_unreachable", `The model provider answered with a redirect (HTTP ${upstream.status})`);
		return new Response(text.replaceAll(credential.key, "[redacted]"), { status: upstream.status, headers: downstreamHeaders(upstream.headers) });
	}
	const streamed = (upstream.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
	const meter = new UsageMeter(input.api, streamed);
	const reader = upstream.body.getReader();
	let idle: ReturnType<typeof setTimeout> | undefined;
	const nextChunk = () =>
		new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
			idle = setTimeout(() => {
				abort.abort(new GatewayTimeout("idle"));
				reject(new GatewayTimeout("The model provider stopped sending"));
			}, limits.idleTimeoutMs);
			timers.push(idle);
			reader.read().then(resolve, reject);
		}).finally(() => clearTimeout(idle));
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await nextChunk();
				if (next.done) {
					settle(meter.finish());
					controller.close();
					return;
				}
				meter.push(next.value);
				controller.enqueue(next.value);
			} catch (error) {
				abort.abort();
				settle(meter.finish());
				reader.cancel().catch(() => {});
				const message = error instanceof GatewayTimeout ? "The model provider stopped sending: the Pim model gateway gave up on the answer" : "The model provider's answer broke off";
				// A stream's own error event, which the CLI's SDK raises; an error would only reach it as the stream's end.
				if (!streamed) controller.error(new Error(message));
				else {
					controller.enqueue(encoder.encode(streamError(input.api, message)));
					controller.close();
				}
			}
		},
		cancel(reason) {
			abort.abort();
			settle(meter.finish());
			return reader.cancel(reason).catch(() => {});
		},
	});
	return new Response(body, { status: upstream.status, headers: downstreamHeaders(upstream.headers) });
}

/** A server-sent error event as the API's own streams send one when an answer fails part-way. */
function streamError(api: GatewayApi, message: string): string {
	if (api.startsWith("anthropic")) return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`;
	if (api === "openai-responses") return `event: error\ndata: ${JSON.stringify({ type: "error", code: "upstream_timeout", message, param: null })}\n\n`;
	return `data: ${JSON.stringify({ error: { message, type: "server_error", param: null, code: "upstream_timeout" } })}\n\n`;
}

async function errorText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < MAX_ERROR_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
		}
	} catch {}
	await reader.cancel().catch(() => {});
	const decoder = new TextDecoder();
	return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}

// The Worker's door

/**
 * The gateway as the Worker serves it, at `/api` + `path`: the token is
 * checked here first, so a request without a valid one never wakes a
 * thread's object, then the thread named in it answers.
 */
export async function serveModelGateway(request: Request, env: Env, path: string): Promise<Response> {
	const match = /^\/coding\/gateway\/(anthropic|openai)(\/.*)$/.exec(path);
	if (!match) return Response.json({ error: "Not found" }, { status: 404 });
	const family = match[1] as GatewayFamily;
	const token = presentedGatewayToken(request);
	const claims = token ? await verifyGatewayToken(await gatewayTokenKey(env), token) : null;
	if (!token || !claims) return gatewayError(family, 401, "invalid_token", "This needs a coding thread's model gateway token");
	return env.CodingThread.getByName(claims.threadId).gatewayRequest(token, family, match[2]!, request) as Promise<Response>;
}
