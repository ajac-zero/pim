/**
 * Where the time of one model call went, kept with the call (./model-calls.ts)
 * so a slow or failed one says whether it waited to be sent, waited for the
 * provider's headers, waited for its first bytes, or stalled in the stream.
 * It watches the call's own `fetch`, which pi-ai hands to the provider's SDK,
 * and the first event the provider's stream parsed.
 *
 * What it keeps is facts about the transport: times, status codes, the names
 * of the headers sent, the values of the protocol-version ones, a short list
 * of the response headers that identify a request to whoever runs the
 * gateway, and sizes. Never a credential, an address or any content.
 */

/** The response headers worth keeping: they identify the request or the hop that answered it. */
const RESPONSE_HEADERS = ["cf-ray", "cf-cache-status", "content-type", "x-request-id", "anthropic-request-id", "request-id", "retry-after", "server", "via", "x-envoy-upstream-service-time", "cf-aig-cache-status", "cf-aig-step"];
/** The request headers whose values are protocol versions and feature flags, not secrets. */
const REQUEST_HEADER_VALUES = ["anthropic-beta", "anthropic-version", "content-type", "accept"];
/** Attempts kept; a call that made more is counted by `httpAttempts` all the same. */
const MAX_ATTEMPTS = 6;

type Attempt = {
	attempt: number;
	status: number | null;
	/** From the call's start to the request being handed to `fetch`. */
	sentMs: number;
	/** From the request being sent to its response headers arriving. */
	headersMs: number | null;
	/** From the headers to the first chunk of the body. */
	firstByteMs: number | null;
	/** From the headers to the body's end, or to the call's end if it never ended. */
	bodyMs: number | null;
	cfRay?: string;
	contentType?: string;
	error?: string;
};

export type ModelPhases = {
	/** From the call's start to the first request being sent: Pim's own preparation of it (catalog, images, schemas) and the SDK's. */
	preFetchMs: number | null;
	httpAttempts: number;
	/** Of the last attempt: time waiting for the response headers. */
	headersMs: number | null;
	/** Of the last attempt: from the headers to the first body chunk. */
	firstByteMs: number | null;
	/** From the last attempt's headers to the first event its provider's stream parsed, where the provider reports them. */
	firstEventMs: number | null;
	/** Of the last attempt: from its first body chunk to the end of the call. */
	streamMs: number | null;
	totalMs: number;
	attempts: Attempt[];
	/** What the last request was, by its facts alone. */
	wire?: { method?: string; headerNames: string[]; headers: Record<string, string>; bodyBytes: number | null };
	response?: Record<string, string>;
};

type Fetch = (input: any, init?: any) => Promise<Response>;

export class CallPhases {
	readonly #attempts: Attempt[] = [];
	#count = 0;
	#wire: ModelPhases["wire"];
	#response: Record<string, string> | undefined;
	/** Time (clock) the last attempt's headers arrived, its body began to be read, its first event came. */
	#headersAt: number | null = null;
	#firstByteAt: number | null = null;
	#firstEventAt: number | null = null;
	#firstSentAt: number | null = null;

	constructor(
		readonly started: number,
		readonly now: () => number = Date.now,
	) {}

	/** `inner`, or the global `fetch`, watched. */
	fetch(inner?: Fetch): Fetch {
		return async (input, init) => {
			const sentAt = this.now();
			this.#firstSentAt ??= sentAt;
			const count = ++this.#count;
			const record: Attempt = { attempt: count, status: null, sentMs: sentAt - this.started, headersMs: null, firstByteMs: null, bodyMs: null };
			if (this.#attempts.length < MAX_ATTEMPTS) this.#attempts.push(record);
			this.#headersAt = this.#firstByteAt = this.#firstEventAt = null;
			this.#wire = describeRequest(init);
			let response: Response;
			try {
				response = await (inner ?? ((i, n) => globalThis.fetch(i, n)))(input, init);
			} catch (error) {
				record.error = error instanceof Error ? error.name : "Error";
				record.headersMs = this.now() - sentAt;
				throw error;
			}
			const headersAt = this.now();
			this.#headersAt = headersAt;
			record.status = response.status;
			record.headersMs = headersAt - sentAt;
			const interesting: Record<string, string> = {};
			for (const name of RESPONSE_HEADERS) {
				const value = response.headers.get(name);
				if (value) interesting[name] = value.slice(0, 100);
			}
			this.#response = interesting;
			if (interesting["cf-ray"]) record.cfRay = interesting["cf-ray"];
			if (interesting["content-type"]) record.contentType = interesting["content-type"];
			if (!response.body) return response;
			const tracker = this;
			const body = response.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						if (record.firstByteMs === null) {
							const at = tracker.now();
							record.firstByteMs = at - headersAt;
							tracker.#firstByteAt = at;
						}
						controller.enqueue(chunk);
					},
					flush() {
						record.bodyMs = tracker.now() - headersAt;
					},
				}),
			);
			return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
		};
	}

	/** The provider's stream parsed an event. */
	event(): void {
		if (this.#headersAt !== null && this.#firstEventAt === null) this.#firstEventAt = this.now();
	}

	/** The call's phases, as they stand when it settles. */
	finish(): ModelPhases {
		const end = this.now();
		const last = this.#attempts.at(-1);
		// A body that never ended is as long as the call was.
		for (const attempt of this.#attempts) if (attempt.status !== null && attempt.bodyMs === null && attempt === last && this.#headersAt !== null) attempt.bodyMs = end - this.#headersAt;
		return {
			preFetchMs: this.#firstSentAt === null ? null : this.#firstSentAt - this.started,
			httpAttempts: this.#count,
			headersMs: last?.headersMs ?? null,
			firstByteMs: last?.firstByteMs ?? null,
			firstEventMs: this.#headersAt !== null && this.#firstEventAt !== null ? this.#firstEventAt - this.#headersAt : null,
			streamMs: this.#firstByteAt === null ? null : end - this.#firstByteAt,
			totalMs: end - this.started,
			attempts: this.#attempts,
			...(this.#wire ? { wire: this.#wire } : {}),
			...(this.#response ? { response: this.#response } : {}),
		};
	}
}

/** What a request was, without its content or credentials: the names of its headers, the protocol ones' values, and its size. */
function describeRequest(init: { method?: string; headers?: unknown; body?: unknown } | undefined): ModelPhases["wire"] {
	let names: string[] = [];
	const headers: Record<string, string> = {};
	try {
		const all = new Headers(init?.headers as HeadersInit | undefined);
		names = [...all.keys()].sort();
		for (const name of REQUEST_HEADER_VALUES) {
			const value = all.get(name);
			if (value) headers[name] = value.slice(0, 300);
		}
	} catch {
		// A header set that can't be read is left out.
	}
	const body = init?.body;
	const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body instanceof Uint8Array || body instanceof ArrayBuffer ? body.byteLength : null;
	return { ...(init?.method ? { method: init.method } : {}), headerNames: names, headers, bodyBytes };
}
