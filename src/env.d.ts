// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
interface PimSecrets {
	/** Optional bearer token for API clients other than the web app (self-hosted only). */
	PIM_API_TOKEN?: string;
	/** Optional URL that receives notifications as JSON POSTs. */
	PIM_NOTIFY_WEBHOOK?: string;
}

/**
 * The hosted service's bindings and variables (wrangler.hosted.jsonc). A
 * self-hosted deployment has none of them; `wrangler types` reads only
 * wrangler.jsonc, so they are declared here.
 */
interface PimlingBindings {
	/** Accounts: usernames, owner IDs and their status (src/hosted/directory.ts). */
	Directory?: DurableObjectNamespace<import("./hosted/directory").Directory>;
	/** The domain Pimlings are served under: `<username>.<PIMLING_DOMAIN>`. */
	PIMLING_DOMAIN?: string;
	/** `open`, `invite` (the default) or `closed`. */
	PIMLING_REGISTRATION?: string;
	/** Accounts allowed in all; empty for no cap. */
	PIMLING_MAX_ACCOUNTS?: string;
	/** Registrations one IP address may make in a day; default 3. */
	PIMLING_REGISTRATIONS_PER_ADDRESS?: string;
	/** Secret: the operator's admin API token. Without it the admin API is off. */
	PIMLING_ADMIN_TOKEN?: string;
	/** Per-address limit on sign-in, recovery and registration attempts. */
	AUTH_LIMITER?: RateLimit;
	/** Per-owner limit on API requests. */
	API_LIMITER?: RateLimit;
}

interface Env extends PimSecrets, PimlingBindings {}

declare namespace Cloudflare {
	interface Env extends PimSecrets, PimlingBindings {}
}
