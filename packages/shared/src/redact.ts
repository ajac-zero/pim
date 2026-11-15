// Taking credentials out of text before it reaches a model, a log or the web app.

/** Credentials in the shapes they usually take in files, command output and environment listings. */
const SECRETS: [RegExp, string][] = [
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
	[/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED]"],
	[/\b(?:sk|rk)-(?:[A-Za-z]+-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
	[/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
	// Google's API keys, which a gateway in front of Gemini may echo in an error.
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
	[/\b(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, "$1[REDACTED]"],
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@"],
	// An upper-case setting named like a credential, given a literal value; not one read from elsewhere, such as `process.env.API_KEY`.
	[/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*["']?\s*[=:]\s*)("[^"\n]+"|'[^'\n]+'|[^\s"',;$(){}.]{4,}(?=[\s"',;]|$))/g, "$1[REDACTED]"],
];

/** `text` with every credential-shaped part replaced by a marker. */
export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
	return out;
}

/** Credentials that `redact` doesn't know, as a model provider's error may hold them: bearer tokens, key headers and parameters, and the "Incorrect API key provided" wording. */
const MORE_SECRETS: readonly (readonly [RegExp, string])[] = [
	[/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
	[/\b((?:proxy-)?authorization|x-api-key|api-key|x-goog-api-key|ocp-apim-subscription-key)(["']?\s*[:=]\s*["']?)[^\s"',;}]+(?:\s+[^\s"',;}]+)?/gi, "$1$2[REDACTED]"],
	[/([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"']+/gi, "$1[REDACTED]"],
	[/\b(api key(?: provided)?:?\s+)[^\s"',;}]+/gi, "$1[REDACTED]"],
];

/** `text` without anything that looks like a credential, the way a model provider's error may carry one; the rest of its words stay. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const [pattern, replacement] of MORE_SECRETS) out = out.replace(pattern, replacement);
	return redact(out);
}
