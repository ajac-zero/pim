// What leaves the process in a span, a metric label or a log line. The default is to say nothing about content: prompts, tool bodies, tokens,
// cookies and keys never appear, whatever a caller attaches. An operator may opt in to message content (`captureContent`), which still
// removes every credential pattern: content capture is about what people said, never about what unlocks their accounts.

export const REDACTED = "[redacted]";

/** Attribute and field names whose values are content or credentials, matched on the whole name or on a token of it. */
const CONTENT_KEYS = /(^|[._\-])(prompt|prompts|messages?|completion|completions|input|output|instructions?|system[._-]?prompt|content|body|args|arguments|result|tool[._-]?(input|output|args|result|call[._-]?(arguments|result)))($|[._\-])/i;
const SECRET_KEYS = /(^|[._\-])(authorization|cookie|set[._-]?cookie|password|passwd|secret|token|tokens|api[._-]?key|apikey|private[._-]?key|credential|credentials|bearer|session|passkey|signature|salt|kek|dek|cookie[._-]?key|app[._-]?credentials[._-]?key)($|[._\-])/i;

/** Credential shapes found inside free text. Each pattern names what it removes. */
const TOKEN_PATTERNS: readonly RegExp[] = [
	/\bpim(?:git|gw|hostops|c|h)?_[A-Za-z0-9_\-]{8,}/g, // pim_<owner>_<secret>, pimgit_, pimgw_, pimhostops_, pimc_, pimh_
	/\bsgamp_[A-Za-z0-9_\-]{8,}/g, // sgamp_ tokens
	/\bBearer\s+[A-Za-z0-9._~+/=\-]{8,}/gi,
	/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
	/\bsk-[A-Za-z0-9_\-]{12,}/g, // provider API keys
	/\bsk-ant-[A-Za-z0-9_\-]{8,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bya29\.[A-Za-z0-9_\-]{10,}/g,
	/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, // JWTs
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
	/\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
	/\b((?:APP_CREDENTIALS_KEY|cookie_key|PIM_INGRESS_SECRET|PIM_KEK_[A-Za-z0-9_]*|[A-Z_]*(?:SECRET|PASSWORD|TOKEN|API_KEY)[A-Z_]*)\s*[=:]\s*)[^\s,;"']+/g,
	/\b(session|pim_session|__Host-[A-Za-z0-9_\-]+)=[A-Za-z0-9._~%+/=\-]{16,}/g,
];

export type RedactOptions = {
	/** Keep prompt and message content (still without credentials). Off by default. */
	readonly captureContent?: boolean;
	readonly maxStringLength?: number;
};

/** Removes credential patterns from a string. */
export function redactText(text: string): string {
	let out = text;
	for (const pattern of TOKEN_PATTERNS) {
		out = out.replace(pattern, (...m: string[]) => (typeof m[1] === "string" && pattern.source.startsWith("\\b((?:APP_CRED") ? `${m[1]}${REDACTED}` : REDACTED));
	}
	return out;
}

const isSecretKey = (key: string) => SECRET_KEYS.test(key);
const isContentKey = (key: string) => CONTENT_KEYS.test(key);

/** A value safe to emit: recursive over objects and arrays, key-aware, credential-scrubbed. */
export function redactValue(value: unknown, options: RedactOptions = {}, key = "", depth = 0): unknown {
	// Numbers and booleans carry no content or credential, so counts such as gen_ai.usage.input_tokens stay.
	if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
	if (isSecretKey(key)) return REDACTED;
	if (!options.captureContent && isContentKey(key)) return REDACTED;
	if (typeof value === "string") {
		const clean = redactText(value);
		const max = options.maxStringLength ?? 2048;
		return clean.length > max ? `${clean.slice(0, max)}…` : clean;
	}
	if (depth > 8) return REDACTED;
	if (Array.isArray(value)) return value.map((item) => redactValue(item, options, key, depth + 1));
	if (value instanceof Error) return redactText(`${value.name}: ${value.message}`);
	if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, options, k, depth + 1)]));
	return REDACTED;
}

/** Span or event attributes: flat key to value, with arrays of primitives allowed. */
export function redactAttributes<T extends Record<string, unknown> | undefined>(attributes: T, options: RedactOptions = {}): T {
	if (!attributes) return attributes;
	return Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, redactValue(v, options, k)])) as T;
}

/** A log record as one JSON line: its fields redacted, never stringified raw. */
export function redactedLogLine(fields: Record<string, unknown>, options: RedactOptions = {}): string {
	return JSON.stringify(redactValue(fields, options));
}
