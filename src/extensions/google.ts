import {
	type AppCategory,
	type AppCredential,
	type AppSecrets,
	type AppTool,
	type AppToolContext,
	definePimExtension,
	type NativeAppDefinition,
	oauth2,
	type PimExtension,
	ReconnectRequired,
} from "./define";

/**
 * What Pim's Google apps share: Google's OAuth sign-in and its APIs, for
 * apps such as Gmail and Google Drive that each connect on their own (see
 * "Google apps" in docs/extensions.md).
 *
 * Each app has an OAuth client of its own, in the Worker's secrets, made
 * in a Google Cloud project of its own: Google keeps a person's grant per
 * project, and revoking it revokes every client's tokens in that project.
 * So a person's grant to Gmail is apart from their grant to Drive, and
 * disconnecting Gmail, which revokes its grant at Google, leaves Drive
 * connected. Apps may ask only for the narrow scopes in `GOOGLE_SCOPES`.
 * A sign-in asks Google to show every scope the person granted the
 * project, so one that grants less than the app asked for, or more (the
 * project is shared with something else), is refused. Their credentials are kept encrypted (`encrypted`), so they are
 * offered only once the deployment sets `APP_CREDENTIALS_KEY` too.
 */

/** The scopes a Google app may ask for: reading Gmail, and only the Drive files the person picks for Pim. */
export const GOOGLE_SCOPES = {
	gmailReadonly: "https://www.googleapis.com/auth/gmail.readonly",
	driveFile: "https://www.googleapis.com/auth/drive.file",
} as const;
export type GoogleScope = (typeof GOOGLE_SCOPES)[keyof typeof GOOGLE_SCOPES];

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** A person's sign-in to a Google app, as Pim keeps it. */
export type GoogleCredential = AppCredential & {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly expiresAt: number;
	/** The scopes Google granted, space-separated. */
	readonly scope: string;
};

export type GoogleAppOptions = {
	/** Unique in the Google extension, and stored in people's agents: don't rename it. */
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly icon?: string;
	readonly category?: AppCategory;
	/** The Worker secrets holding this app's own OAuth client, such as `GOOGLE_GMAIL_CLIENT_ID`: one in a Google Cloud project no other app's client is in. */
	readonly client: { readonly id: string; readonly secret: string };
	readonly scopes: readonly GoogleScope[];
	/** Other Worker secrets the app needs, such as the Drive Picker's API key; nobody is offered it until they are set. */
	readonly secrets?: readonly string[];
	readonly tools: readonly AppTool[];
	readonly actions?: NativeAppDefinition["actions"];
	readonly page?: NativeAppDefinition["page"];
};

const allowed = new Set<string>(Object.values(GOOGLE_SCOPES));

/**
 * A Google app: Google's sign-in, with offline access and its consent screen
 * every time, so each sign-in has a refresh token; renewal; revocation when
 * the person disconnects; and the app's tools, which call Google with
 * `googleFetch`.
 */
export function googleApp(options: GoogleAppOptions): NativeAppDefinition {
	if (options.scopes.length === 0 || options.scopes.some((scope) => !allowed.has(scope))) {
		throw new Error(`${options.name} may ask Google only for ${[...allowed].join(", ")}`);
	}
	const { client, scopes, secrets = [], ...identity } = options;
	const base = oauth2({
		authorizeUrl: AUTHORIZE_URL,
		tokenUrl: TOKEN_URL,
		scopes,
		clientId: client.id,
		clientSecret: client.secret,
		// A refresh token on every sign-in. The token lists every scope the person granted the project,
		// including through other clients in it, so a project shared with something else shows.
		authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
	});
	/** Says which secrets are missing, instead of sending Google an empty client. */
	const configured = (secrets: AppSecrets) => {
		const missing = [client.id, client.secret].filter((name) => !secrets[name]);
		if (missing.length > 0) throw new Error(`This Pim isn't set up for ${options.name}: its admin must set ${missing.join(" and ")}.`);
	};
	return {
		...identity,
		secrets: [client.id, client.secret, ...secrets],
		encrypted: true,
		async signIn(context) {
			configured(context.secrets);
			return base.signIn(context);
		},
		async callback(context) {
			configured(context.secrets);
			const credential = await base.callback(context);
			const granted = new Set(String(credential.scope ?? "").split(/\s+/).filter(Boolean));
			const extra = [...granted].filter((scope) => !(scopes as readonly string[]).includes(scope));
			if (extra.length > 0) {
				// The project's grant has more in it than this app: revoking it would end someone else's, so it is left alone.
				throw new Error(`Google granted more than ${options.name} asks for. Its OAuth client must be in a Google Cloud project of its own.`);
			}
			const problem =
				typeof credential.refreshToken !== "string"
					? "Google didn't grant offline access."
					: scopes.some((scope) => !granted.has(scope))
						? `Google didn't grant everything ${options.name} needs: connect it again and allow all it asks for.`
						: null;
			if (problem) {
				// The grant has only this app's scopes in it: nothing is kept of it, at Google either.
				await revokeGoogle(credential).catch(() => undefined);
				throw new Error(problem);
			}
			return { ...credential, scope: [...granted].sort().join(" ") };
		},
		async refresh(credential, context) {
			configured(context.secrets);
			return base.refresh!(credential, context);
		},
		async revoke(credential) {
			await revokeGoogle(credential);
		},
		tools: options.tools,
	};
}

/**
 * Revokes the grant a credential belongs to. Revoking the refresh token
 * ends the person's whole grant to this app's OAuth client, and its access
 * tokens with it; a token Google no longer knows is already revoked.
 */
async function revokeGoogle(credential: AppCredential): Promise<void> {
	const token = typeof credential.refreshToken === "string" ? credential.refreshToken : credential.accessToken;
	if (typeof token !== "string") return;
	const response = await fetch(REVOKE_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token }),
		signal: AbortSignal.timeout(10_000),
	});
	if (response.ok) return;
	const answer = (await response.json().catch(() => ({}))) as { error?: string };
	if (answer.error === "invalid_token") return;
	throw new Error(`Google answered ${response.status}${answer.error ? ` (${answer.error})` : ""}`);
}

/** The Google extension, with the Google apps this deployment offers (`pim.config.ts`). Its apps are `google/<app>`. */
export function googleExtension(apps: readonly NativeAppDefinition[]): PimExtension {
	return definePimExtension({ id: "google", name: "Google", description: "Google's apps, each connected on its own.", apps });
}

/** A Google API's refusal: its HTTP status, Google's reason, and its message. Never the request's token. */
export class GoogleApiError extends Error {
	override readonly name = "GoogleApiError";
	constructor(
		readonly status: number,
		readonly reason: string | null,
		message: string,
	) {
		super(message);
	}
}

export type GoogleRequest = {
	readonly method?: string;
	/** Added to the URL's query; arrays repeat the parameter. */
	readonly query?: Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>;
	readonly headers?: Readonly<Record<string, string>>;
	/** A string, so a retry can send it again. */
	readonly body?: string;
	/** Whether sending it twice does no harm: GET, HEAD, PUT and DELETE are; others are retried only when this says so. */
	readonly idempotent?: boolean;
	/** For `googleJson`: the most bytes of answer it reads (default 2 MiB); a longer one throws `GoogleTooLarge`. */
	readonly maxBytes?: number;
};

/** An answer longer than the caller reads. */
export class GoogleTooLarge extends Error {
	override readonly name = "GoogleTooLarge";
	constructor(readonly maxBytes: number) {
		super(`Google's answer is larger than ${maxBytes} bytes.`);
	}
}

/** At most `maxBytes` of a response's body, and whether there was more; the rest is never read. */
export async function readGoogleBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const declared = Number(response.headers.get("content-length"));
	const reader = response.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(), truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = Number.isFinite(declared) && declared > maxBytes;
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

/** How many times a request is sent, at most, when Google is busy or unreachable; a refused token is renewed once besides. */
export const GOOGLE_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 20_000;
const BACKOFF_MS = 250;
const MAX_WAIT_MS = 5_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);

/** The newest credential each tool call has, once it renewed one, so its next request uses it. */
const renewed = new WeakMap<AppToolContext, AppCredential>();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Google's error as JSON: `{ error: { code, message, status, errors: [{ reason }], details: [{ reason }] } }`. */
async function refusal(response: Response): Promise<GoogleApiError> {
	const body = (await response.json().catch(() => ({}))) as {
		error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } | string;
		error_description?: string;
	};
	const error = typeof body.error === "object" ? body.error : undefined;
	const reason = error?.errors?.[0]?.reason ?? error?.details?.find((detail) => detail.reason)?.reason ?? error?.status ?? (typeof body.error === "string" ? body.error : null);
	const text = (error?.message ?? body.error_description ?? response.statusText) || `HTTP ${response.status}`;
	return new GoogleApiError(response.status, reason ?? null, `Google: ${text.slice(0, 300)}`);
}

/**
 * A request to a Google API (https, on googleapis.com) with the person's
 * credential. It sends the request at most `GOOGLE_ATTEMPTS` times, waiting
 * longer each time (or as Google's Retry-After says, up to 5 s), when Google
 * answers 429, a 5xx, or a rate-limit 403, or can't be reached; requests that
 * aren't idempotent are sent once. When Google refuses the token (401) it
 * renews it once and sends the request again; refused again, the person must
 * connect the app again (`ReconnectRequired`). Any other refusal throws a
 * `GoogleApiError`. Answers the successful response.
 */
export async function googleFetch(context: AppToolContext, url: string, request: GoogleRequest = {}): Promise<Response> {
	const target = new URL(url);
	if (target.protocol !== "https:" || !target.hostname.endsWith(".googleapis.com")) throw new Error(`Google apps only call Google's APIs, not ${target.origin}`);
	for (const [name, value] of Object.entries(request.query ?? {})) {
		if (value === undefined) continue;
		for (const one of Array.isArray(value) ? value : [value]) target.searchParams.append(name, String(one));
	}
	const method = (request.method ?? "GET").toUpperCase();
	const idempotent = request.idempotent ?? ["GET", "HEAD", "PUT", "DELETE"].includes(method);
	let renewedToken = false;
	for (let attempt = 1; ; attempt++) {
		const credential = renewed.get(context) ?? context.credential;
		let response: Response;
		try {
			response = await fetch(target, {
				method,
				headers: { accept: "application/json", ...request.headers, authorization: `Bearer ${String(credential.accessToken)}` },
				...(request.body === undefined ? {} : { body: request.body }),
				// A redirect could take the token elsewhere.
				redirect: "manual",
				signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
			});
		} catch (error) {
			if (!idempotent || attempt >= GOOGLE_ATTEMPTS) throw new Error(`Google couldn't be reached: ${error instanceof Error ? error.message : String(error)}`);
			await wait(BACKOFF_MS * 2 ** (attempt - 1) * (1 + Math.random()));
			continue;
		}
		if (response.ok) return response;
		if (response.status === 401) {
			await response.body?.cancel();
			if (renewedToken) throw new ReconnectRequired("Google no longer accepts this sign-in.");
			renewedToken = true;
			renewed.set(context, await context.renew());
			attempt--;
			continue;
		}
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new GoogleApiError(response.status, null, `Google: unexpected redirect (${response.status})`);
		}
		const error = await refusal(response);
		const busy = RETRY_STATUSES.has(response.status) || (response.status === 403 && error.reason !== null && RETRY_REASONS.has(error.reason));
		if (!busy || !idempotent || attempt >= GOOGLE_ATTEMPTS) throw error;
		const after = Number(response.headers.get("retry-after"));
		await wait(Math.min(MAX_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : BACKOFF_MS * 2 ** (attempt - 1) * (1 + Math.random())));
	}
}

/** `googleFetch`'s answer as JSON, read up to `maxBytes`; null for an empty one. */
export async function googleJson<T>(context: AppToolContext, url: string, request: GoogleRequest = {}): Promise<T | null> {
	const maxBytes = request.maxBytes ?? 2 * 1024 * 1024;
	const { bytes, truncated } = await readGoogleBytes(await googleFetch(context, url, request), maxBytes);
	if (truncated) throw new GoogleTooLarge(maxBytes);
	const text = new TextDecoder().decode(bytes);
	return text === "" ? null : (JSON.parse(text) as T);
}
