// `/api/coding/gateway/<anthropic|openai>/…`: a vendor CLI in a sandbox calls a model with a `pimgw_` token instead of a key. The token is checked against PostgreSQL on every request
// (the thread's nonce and state, the owner not suspended), the thread's budget and request caps are applied, the person's own key for that model family is added outside the sandbox, the answer is passed back as the provider sent it, and the usage it reports is charged to the thread.
import { ForbiddenError } from "../errors";
import { type ForgeStore } from "../store";
import { type Credentials } from "../tokens";
import { type Handler, json } from "./common";

export type GatewayFamily = "anthropic" | "openai";
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Dollars per million tokens. */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** A model family's key and base URL for this thread's person: their own provider, else a shared one. Null when there is none. */
export type GatewayKey = (thread: { threadId: string; ownerId: string }, family: GatewayFamily) => Promise<{ apiKey: string; baseUrl?: string } | null>;

/** What a model costs. A deployment passes its provider catalog's; the default prices every model as the family's dearest, so a new model never runs free. */
export type GatewayPrice = (family: GatewayFamily, model: string, usage: TokenUsage) => number | Promise<number>;

const DEAREST: Record<GatewayFamily, Price> = { anthropic: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, openai: { input: 10, output: 40, cacheRead: 2.5, cacheWrite: 0 } };
export const defaultPrice: GatewayPrice = (family, _model, u) => {
	const p = DEAREST[family];
	return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
};

/** `idleTimeoutMs` is how long an answer may go without a byte before the gateway gives up on the provider. */
export type GatewayLimits = { requestsPerMinute: number; concurrent: number; maxBodyBytes: number; idleTimeoutMs: number };
export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = { requestsPerMinute: 120, concurrent: 4, maxBodyBytes: 8 * 1024 * 1024, idleTimeoutMs: 5 * 60_000 };

const BASES: Record<GatewayFamily, string> = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com" };
const ROUTES: Record<string, { family: GatewayFamily; path: string; charged: boolean }> = {
	"anthropic/v1/messages": { family: "anthropic", path: "/v1/messages", charged: true },
	"anthropic/v1/messages/count_tokens": { family: "anthropic", path: "/v1/messages/count_tokens", charged: false },
	"openai/v1/responses": { family: "openai", path: "/v1/responses", charged: true },
	"openai/v1/chat/completions": { family: "openai", path: "/v1/chat/completions", charged: true },
};

export type GatewayDeps = { credentials: Credentials; store: ForgeStore; /** The store as one owner's requests see it (row-level security); the Gate's. */ scope?: (ownerId: string) => ForgeStore; key: GatewayKey; price?: GatewayPrice; fetch?: typeof fetch; now?: () => number; limits?: Partial<GatewayLimits> };

/** What a call used, read from the provider's answer: a JSON body, or the events of a stream. */
export function usageOf(text: string): { model: string | null; usage: TokenUsage | null } {
	let model: string | null = null;
	const u: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let seen = false;
	const take = (o: any) => {
		if (!o || typeof o !== "object") return;
		const x = o.response ?? o.message ?? o;
		if (typeof x.model === "string") model = x.model;
		const use = x.usage ?? o.usage;
		if (!use) return;
		seen = true;
		const pick = (n: unknown) => (typeof n === "number" ? n : 0);
		// Anthropic reports input at the start and output at the end; OpenAI everything at the end. Each field only ever grows.
		u.input = Math.max(u.input, pick(use.input_tokens ?? use.prompt_tokens));
		u.output = Math.max(u.output, pick(use.output_tokens ?? use.completion_tokens));
		u.cacheRead = Math.max(u.cacheRead, pick(use.cache_read_input_tokens ?? use.input_tokens_details?.cached_tokens ?? use.prompt_tokens_details?.cached_tokens));
		u.cacheWrite = Math.max(u.cacheWrite, pick(use.cache_creation_input_tokens));
	};
	const whole = text.trim();
	if (whole.startsWith("{")) {
		try {
			take(JSON.parse(whole));
			return { model, usage: seen ? u : null };
		} catch {}
	}
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			take(JSON.parse(line.slice(5).trim()));
		} catch {}
	}
	return { model, usage: seen ? u : null };
}

/** A server-sent error event as the API's own streams send one when an answer fails part-way, which the CLI's SDK raises (an error would only reach it as the stream's end). */
function streamError(path: string, message: string): string {
	if (path.startsWith("/v1/messages")) return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`;
	if (path === "/v1/responses") return `event: error\ndata: ${JSON.stringify({ type: "error", code: "upstream_timeout", message, param: null })}\n\n`;
	return `data: ${JSON.stringify({ error: { message, type: "server_error", param: null, code: "upstream_timeout" } })}\n\n`;
}

class IdleTimeout extends Error {}

const refuse = (status: number, type: string, message: string, headers: Record<string, string> = {}) => json(status, { error: { type, message } }, headers);

export function modelGateway(d: GatewayDeps): Handler {
	const doFetch = d.fetch ?? fetch;
	const now = d.now ?? Date.now;
	const limits = { ...DEFAULT_GATEWAY_LIMITS, ...d.limits };
	const price = d.price ?? defaultPrice;
	const gates = new Map<string, { recent: number[]; inFlight: number }>();
	return async (req) => {
		const url = new URL(req.url);
		const prefix = "/api/coding/gateway/";
		if (!url.pathname.startsWith(prefix)) return null;
		const route = ROUTES[url.pathname.slice(prefix.length)];
		if (!route || req.method !== "POST") return refuse(404, "not_found", "No such gateway route");
		for (const k of url.searchParams.keys()) if (k !== "beta") return refuse(400, "invalid_request", "Unsupported query");
		const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
		const token = req.headers.get("x-api-key") ?? bearer;
		if (!token) return refuse(401, "invalid_token", "Missing gateway token");
		let who;
		try {
			who = await d.credentials.verifyGateway(token, route.family);
		} catch (e) {
			if (e instanceof ForbiddenError) return /family/.test(e.reason) ? refuse(403, "forbidden", e.reason) : refuse(401, "invalid_token", "This gateway token isn't valid");
			throw e;
		}
		const store = d.scope?.(who.ownerId) ?? d.store;
		const thread = (await store.get(who.threadId))!;
		if (route.charged && thread.budgetUsd !== null && thread.spentUsd >= thread.budgetUsd) return refuse(402, "budget_exhausted", `This coding thread has spent its $${thread.budgetUsd} budget`);
		if (Number(req.headers.get("content-length") ?? 0) > limits.maxBodyBytes) return refuse(413, "request_too_large", "The request is too big");
		const gate = gates.get(thread.threadId) ?? { recent: [], inFlight: 0 };
		gates.set(thread.threadId, gate);
		gate.recent = gate.recent.filter((at) => at > now() - 60_000);
		if (gate.recent.length >= limits.requestsPerMinute) return refuse(429, "rate_limited", "Too many requests", { "retry-after": String(Math.max(1, Math.ceil((gate.recent[0]! + 60_000 - now()) / 1000))) });
		if (gate.inFlight >= limits.concurrent) return refuse(429, "too_many_concurrent", "Too many requests at once", { "retry-after": "1" });
		const cred = await d.key(thread, route.family);
		if (!cred) return refuse(403, "no_credential", `This Pim has no ${route.family} key for you`);
		let body: Uint8Array = new Uint8Array(await req.arrayBuffer());
		if (body.length > limits.maxBodyBytes) return refuse(413, "request_too_large", "The request is too big");
		// A streamed Chat Completions answer reports its usage only when asked to, and the thread's budget needs it: any other body is sent on byte for byte.
		if (route.path === "/v1/chat/completions") {
			try {
				const asked = JSON.parse(new TextDecoder().decode(body));
				if (asked && typeof asked === "object" && !Array.isArray(asked) && asked.stream === true && asked.stream_options?.include_usage !== true) {
					const options = asked.stream_options && typeof asked.stream_options === "object" ? asked.stream_options : {};
					body = new TextEncoder().encode(JSON.stringify({ ...asked, stream_options: { ...options, include_usage: true } }));
				}
			} catch {}
		}
		gate.recent.push(now());
		gate.inFlight++;
		let released = false;
		const release = () => {
			if (!released) {
				released = true;
				gate.inFlight = Math.max(0, gate.inFlight - 1);
			}
		};
		try {
			const headers = new Headers({ "content-type": req.headers.get("content-type") ?? "application/json" });
			if (route.family === "anthropic") {
				headers.set("x-api-key", cred.apiKey);
				headers.set("anthropic-version", req.headers.get("anthropic-version") ?? "2023-06-01");
				if (req.headers.get("anthropic-beta")) headers.set("anthropic-beta", req.headers.get("anthropic-beta")!);
			} else headers.set("authorization", `Bearer ${cred.apiKey}`);
			const upstream = await doFetch(`${(cred.baseUrl ?? BASES[route.family]).replace(/\/$/, "")}${route.path}${url.search}`, { method: "POST", headers, body: body as BodyInit, redirect: "manual" });
			const out = new Headers();
			for (const h of ["content-type", "cache-control", "retry-after", "request-id", "x-request-id"]) if (upstream.headers.get(h)) out.set(h, upstream.headers.get(h)!);
			if (!route.charged || !upstream.ok || !upstream.body) {
				release();
				return new Response(upstream.body, { status: upstream.status, headers: out });
			}
			// Passed through as it arrives; what it reported is read from a copy and charged when it ends.
			let copy = "";
			const decoder = new TextDecoder();
			let charged = false;
			const charge = async () => {
				if (charged) return;
				charged = true;
				release();
				const read = usageOf(copy);
				// An answer that reported nothing is charged an estimate that overcounts rather than lets it go free.
				const usage = read.usage ?? { input: Math.ceil(body.length / 4), output: Math.ceil(copy.length / 4), cacheRead: 0, cacheWrite: 0 };
				const model = read.model ?? "unknown";
				const costUsd = await price(route.family, model, usage);
				await store.locked(thread.threadId, (q) => store.appendEvent(q, thread.threadId, { kind: "model_call", costUsd, tokensIn: usage.input, tokensOut: usage.output, data: { via: "gateway", api: route.path, family: route.family, model, estimated: read.usage === null } })).catch(() => {});
			};
			const reader = upstream.body.getReader();
			const streamed = (upstream.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
			// An answer that stops sending is given up on, after what the provider sent: a stream ends with the API's own error event, and what it reported is charged.
			const answer = new ReadableStream<Uint8Array>({
				async pull(controller) {
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new IdleTimeout()), limits.idleTimeoutMs)))]);
						if (next.done) {
							await charge();
							controller.close();
							return;
						}
						if (copy.length < 8 * 1024 * 1024) copy += decoder.decode(next.value, { stream: true });
						controller.enqueue(next.value);
					} catch (error) {
						reader.cancel().catch(() => {});
						await charge();
						const message = "The model provider stopped sending: the Pim model gateway gave up on the answer";
						if (error instanceof IdleTimeout && streamed) {
							controller.enqueue(new TextEncoder().encode(streamError(route.path, message)));
							controller.close();
						} else controller.error(error instanceof IdleTimeout ? new Error(message) : error);
					} finally {
						clearTimeout(timer);
					}
				},
				cancel(reason) {
					void charge();
					return reader.cancel(reason).catch(() => {});
				},
			});
			return new Response(answer, { status: upstream.status, headers: out });
		} catch (e) {
			release();
			throw e;
		}
	};
}
