import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { redact } from "./tools/output";

/** The most characters of a model failure that a thread's detail keeps. */
export const MODEL_ERROR_MAX = 500;

/** What a model provider said when it refused a request, as far as its words can be read. */
export type ModelFailure = {
	/** The HTTP status, such as 429. */
	readonly status?: number;
	/** The provider's error type, such as `rate_limit_error`. */
	readonly type?: string;
	/** The provider's error code, such as `insufficient_quota`. */
	readonly code?: string;
	readonly message: string;
};

/** Credentials that `redact` doesn't know: bearer tokens, key headers and parameters, and the "Incorrect API key provided" wording. */
const MORE_SECRETS: readonly (readonly [RegExp, string])[] = [
	[/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
	[/\b((?:proxy-)?authorization|x-api-key|api-key|x-goog-api-key|ocp-apim-subscription-key)(["']?\s*[:=]\s*["']?)[^\s"',;}]+(?:\s+[^\s"',;}]+)?/gi, "$1$2[REDACTED]"],
	[/([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"']+/gi, "$1[REDACTED]"],
	[/\b(api key(?: provided)?:?\s+)[^\s"',;}]+/gi, "$1[REDACTED]"],
];

/** `text` without anything that looks like a credential. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const [pattern, replacement] of MORE_SECRETS) out = out.replace(pattern, replacement);
	return redact(out);
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined);
const statusOf = (value: unknown): number | undefined => {
	const number = typeof value === "number" ? value : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : undefined;
	return number !== undefined && number >= 400 && number <= 599 ? number : undefined;
};

/** The provider's own error object inside `raw`, whether `raw` is JSON or text with JSON in it, such as `429 {"error":{...}}`. */
function jsonIn(raw: string): Record<string, unknown> | undefined {
	for (const start of [raw.indexOf("{"), raw.indexOf("{", raw.indexOf("{") + 1)]) {
		if (start < 0) continue;
		for (let end = raw.lastIndexOf("}"); end > start; end = raw.lastIndexOf("}", end - 1)) {
			try {
				const value: unknown = JSON.parse(raw.slice(start, end + 1));
				if (record(value)) return value;
			} catch {}
			if (end - start > 20_000) break;
		}
	}
	return undefined;
}

/** Reads what a provider's failure says: its HTTP status, error type and code, and message. Never throws; text with no structure is the message. */
export function parseModelFailure(raw: unknown): ModelFailure {
	const source = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : raw === undefined || raw === null ? "" : JSON.stringify(raw) ?? "";
	const trimmed = source.trim();
	let status = statusOf(raw instanceof Error ? (raw as { status?: unknown }).status : undefined);
	status ??= /^(?:HTTP\s*)?([45]\d\d)\b/i.exec(trimmed) ? statusOf(/^(?:HTTP\s*)?([45]\d\d)\b/i.exec(trimmed)![1]) : undefined;
	status ??= statusOf(/\b(?:HTTP(?:\s+status)?(?:\s+code)?|status(?:\s+code)?|statusCode)\b["']?\s*[:=]?\s*([45]\d\d)\b/i.exec(trimmed)?.[1]);
	const body = jsonIn(trimmed);
	if (!body) return { ...(status ? { status } : {}), message: trimmed };
	const inner = record(body.error) ? body.error : record(body.detail) ? body.detail : body;
	status ??= statusOf(body.status) ?? statusOf(body.statusCode) ?? statusOf(body.status_code) ?? statusOf(inner.status) ?? statusOf(inner.code);
	const type = text(inner.type) ?? text(body.type);
	const code = text(inner.code) ?? text(inner.status) ?? text(body.code);
	const message = text(inner.message) ?? text(body.message) ?? text(typeof body.error === "string" ? body.error : undefined) ?? text(typeof body.detail === "string" ? body.detail : undefined) ?? trimmed;
	return {
		...(status ? { status } : {}),
		...(type && type !== "error" ? { type } : {}),
		// A numeric code that is just the status says nothing more.
		...(code && code !== String(status) && code !== type ? { code } : {}),
		message,
	};
}

/**
 * What to tell a person of a failed model request: `HTTP 429 (rate_limit_error, code insufficient_quota): message`, with the parts the provider gave,
 * its credentials taken out and cut to `MODEL_ERROR_MAX`. A failure that said nothing says so, with `fallback` for what else is known.
 */
export function describeModelFailure(raw: unknown, fallback = ""): string {
	const failure = parseModelFailure(raw);
	const facts = [failure.type, failure.code ? `code ${failure.code}` : undefined].filter(Boolean).join(", ");
	const head = [failure.status ? `HTTP ${failure.status}` : undefined, facts ? `(${facts})` : undefined].filter(Boolean).join(" ");
	const said = failure.message || fallback || "the provider gave no error message";
	// A provider's own message that already begins with its status isn't repeated.
	const body = failure.status && new RegExp(`^(?:HTTP\\s*)?${failure.status}\\b\\s*`, "i").test(said) ? said.replace(new RegExp(`^(?:HTTP\\s*)?${failure.status}\\b[\\s:-]*`, "i"), "") || said : said;
	const out = redactSecrets(head ? `${head}: ${body}` : body).replace(/\s+/g, " ").trim();
	return out.length > MODEL_ERROR_MAX ? `${out.slice(0, MODEL_ERROR_MAX - 1)}…` : out;
}

/** Whether `raw` carries a provider's HTTP status or error type, so it is a model's refusal and not a CLI's own failure. */
export function isModelFailure(raw: unknown): boolean {
	const failure = parseModelFailure(raw);
	return failure.status !== undefined || failure.type !== undefined;
}

/**
 * `events` with a failed response's message made to say why it failed, so
 * pi records the provider's status, type, code and message and never an empty
 * detail. The original wording stays inside it, so what pi reads of it, to
 * retry or to see an overflow, is unchanged.
 */
export function explainFailures(events: AssistantMessageEventStream, model: Model<Api>): AssistantMessageEventStream {
	const explain = (message: AssistantMessage): AssistantMessage => {
		if (message.stopReason !== "error") return message;
		const raw = (message.errorMessage ?? "").trim();
		const said = redactSecrets(raw);
		const detailed = describeModelFailure(raw, `${model.provider} ${model.id} ended with no error message`);
		return { ...message, errorMessage: !said || detailed.includes(said) ? detailed : `${detailed} [${said.slice(0, 200)}]` };
	};
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of events) {
				if (event.type === "error") out.push({ ...event, error: explain(event.error) });
				else if (event.type === "done") out.push({ ...event, message: explain(event.message) });
				else out.push(event);
			}
			out.end(explain(await events.result()));
		} catch (error) {
			out.end(explain({ ...(await events.result().catch(() => ({}) as AssistantMessage)), stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) } as AssistantMessage));
		}
	})();
	return out;
}
