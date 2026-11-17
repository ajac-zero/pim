/** What the native connectors share when they call a service: bounded reads, a service's words as one line, and a request that retries what may be retried. */

/** A service refused the person's token. The caller renews it once and tries again; refused again, the person connects the connector again. */
export class AuthRefused extends Error {}

/** A service's refusal: its HTTP status and reason, and its message. Never the request's token. */
export class ApiError extends Error {
	override readonly name = "ApiError";
	constructor(readonly status: number, readonly reason: string | null, message: string) {
		super(message);
	}
}

/** An answer longer than the caller reads. */
export class TooLarge extends Error {
	override readonly name = "TooLarge";
	constructor(readonly maxBytes: number) {
		super(`The service's answer is larger than ${maxBytes} bytes.`);
	}
}

/** At most `maxBytes` of a response's body, and whether there was more; the rest is never read. */
export async function readBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(), truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	while (!truncated) {
		const { done, value } = await reader.read();
		if (done) break;
		const room = maxBytes - size;
		chunks.push(value.length > room ? value.subarray(0, room) : value);
		size += Math.min(value.length, room);
		if (value.length > room) truncated = true;
	}
	if (truncated) await reader.cancel().catch(() => undefined);
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return { bytes, truncated };
}

/** A small JSON object from a service, such as a token or an error: `{}` when it is longer than `maxBytes`, or isn't one. */
export async function readJsonObject(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
	try {
		const { bytes, truncated } = await readBody(response, maxBytes);
		if (truncated) return {};
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** A service's own words, such as its error description, as one short line. */
export const serviceText = (text: string) => text.slice(0, 1000).replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 300);

export type Request = {
	readonly method?: string;
	/** Added to the URL's query; arrays repeat the parameter. */
	readonly query?: Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	/** Whether sending it twice does no harm: GET, HEAD, PUT and DELETE are; others are retried only when this says so. */
	readonly idempotent?: boolean;
	/** For `json`: the most bytes of answer it reads (default 2 MiB); a longer one throws `TooLarge`. */
	readonly maxBytes?: number;
};

/** How many times a request is sent, at most, when the service is busy or unreachable. */
export const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 20_000;
const BACKOFF_MS = 250;
const MAX_WAIT_MS = 5_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);
const ERROR_BYTES = 16 * 1024;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The service's error as JSON: Google's `{ error: { code, message, status, errors: [{ reason }] } }` or Spotify's `{ error: { status, message } }`. */
async function refusal(who: string, response: Response): Promise<ApiError> {
	const body = (await readJsonObject(response, ERROR_BYTES)) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } | string; error_description?: string };
	const error = typeof body.error === "object" ? body.error : undefined;
	const reason = error?.errors?.[0]?.reason ?? error?.status ?? (typeof body.error === "string" ? body.error : null);
	const text = serviceText(String(error?.message ?? body.error_description ?? response.statusText ?? "")) || `HTTP ${response.status}`;
	return new ApiError(response.status, typeof reason === "string" ? reason.slice(0, 100) : null, `${who}: ${text}`);
}

/**
 * A request to a service's API at `allowedBase`'s origin, with the person's token. It is sent at most `ATTEMPTS` times, waiting longer each time (or as the service's Retry-After
 * says, up to 5 s), when the service answers 429, a 5xx, or a rate-limit 403, or cannot be reached; a request that is not idempotent is sent once. A refused token (401) throws
 * `AuthRefused`; any other refusal an `ApiError`. A redirect is never followed, since it could take the token elsewhere.
 */
export async function call(who: string, fetcher: typeof fetch, bearer: string, url: string, allowedBase: string, request: Request = {}): Promise<Response> {
	const target = new URL(url);
	if (target.origin !== new URL(allowedBase).origin) throw new Error(`${who}'s connector only calls ${who}'s API, not ${target.origin}`);
	for (const [name, value] of Object.entries(request.query ?? {})) {
		if (value === undefined) continue;
		for (const one of Array.isArray(value) ? value : [value]) target.searchParams.append(name, String(one));
	}
	const method = (request.method ?? "GET").toUpperCase();
	const idempotent = request.idempotent ?? ["GET", "HEAD", "PUT", "DELETE"].includes(method);
	for (let attempt = 1; ; attempt++) {
		let response: Response;
		try {
			response = await fetcher(target, { method, headers: { accept: "application/json", ...request.headers, authorization: `Bearer ${bearer}` }, ...(request.body === undefined ? {} : { body: request.body }), redirect: "manual", signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
		} catch (error) {
			if (!idempotent || attempt >= ATTEMPTS) throw new Error(`${who} couldn't be reached: ${error instanceof Error ? error.message : String(error)}`);
			await wait(BACKOFF_MS * 2 ** (attempt - 1) * (1 + Math.random()));
			continue;
		}
		if (response.ok) return response;
		if (response.status === 401) {
			await response.body?.cancel();
			throw new AuthRefused(`${who} no longer accepts this sign-in.`);
		}
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new ApiError(response.status, null, `${who}: unexpected redirect (${response.status})`);
		}
		const error = await refusal(who, response);
		const busy = RETRY_STATUSES.has(response.status) || (response.status === 403 && error.reason !== null && RETRY_REASONS.has(error.reason));
		if (!busy || !idempotent || attempt >= ATTEMPTS) throw error;
		const after = Number(response.headers.get("retry-after"));
		await wait(Math.min(MAX_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : BACKOFF_MS * 2 ** (attempt - 1) * (1 + Math.random())));
	}
}

/** `call`'s answer as JSON, read up to `maxBytes`; null for an empty one. */
export async function json<T>(who: string, fetcher: typeof fetch, bearer: string, url: string, allowedBase: string, request: Request = {}): Promise<T | null> {
	const maxBytes = request.maxBytes ?? 2 * 1024 * 1024;
	const response = await call(who, fetcher, bearer, url, allowedBase, request);
	if (Number(response.headers.get("content-length")) > maxBytes) {
		await response.body?.cancel();
		throw new TooLarge(maxBytes);
	}
	const { bytes, truncated } = await readBody(response, maxBytes);
	if (truncated) throw new TooLarge(maxBytes);
	const text = new TextDecoder().decode(bytes);
	return text === "" ? null : (JSON.parse(text) as T);
}
