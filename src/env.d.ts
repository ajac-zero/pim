// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
interface PimSecrets {
	/** Optional bearer token for API clients other than the web app. */
	PIM_API_TOKEN?: string;
	/** Optional URL that receives notifications as JSON POSTs. */
	PIM_NOTIFY_WEBHOOK?: string;
}

interface Env extends PimSecrets {}

declare namespace Cloudflare {
	interface Env extends PimSecrets {}
}
