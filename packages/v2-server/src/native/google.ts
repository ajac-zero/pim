/** What Pim's Google connectors share: Google's scopes, API calls with the person's token, and the check that a sign-in granted exactly what the connector asks for. */
import { ApiError, call, json, TooLarge } from "./http.ts";
import type { ToolContext } from "./native.ts";

/** The scopes a Google connector may ask for: reading Gmail, and only the Drive files the person picks for Pim. */
export const GOOGLE_SCOPES = {
	gmailReadonly: "https://www.googleapis.com/auth/gmail.readonly",
	driveFile: "https://www.googleapis.com/auth/drive.file",
} as const;

/** Google's authorization parameters: a refresh token on every sign-in, and every scope the person granted the project shown in the answer. */
export const GOOGLE_AUTHORIZE_PARAMS = { access_type: "offline", prompt: "consent", include_granted_scopes: "true" } as const;

/** The check a Google connector's sign-in must pass: all it asks for granted, nothing else, and offline access. */
export const googleCheck = (name: string, scopes: readonly string[]) => (granted: readonly string[], refreshToken: string | undefined): string | null => {
	if (granted.some((scope) => !scopes.includes(scope))) return `Google granted more than ${name} asks for. Its OAuth client must be in a Google Cloud project of its own.`;
	if (!refreshToken) return "Google didn't grant offline access.";
	if (scopes.some((scope) => !granted.includes(scope))) return `Google didn't grant everything ${name} needs: connect it again and allow all it asks for.`;
	return null;
};

/** A Google API call at `base`'s origin (the configured API), as JSON. */
export const googleJson = <T>(context: ToolContext, base: string, url: string, request: Parameters<typeof json>[5] = {}) => json<T>("Google", context.fetch, context.bearer, url, base, request);
export const googleFetch = (context: ToolContext, base: string, url: string, request: Parameters<typeof call>[5] = {}) => call("Google", context.fetch, context.bearer, url, base, request);

export { ApiError as GoogleApiError, TooLarge as GoogleTooLarge };
