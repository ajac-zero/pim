// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
interface PimSecrets {
	/** Bearer token every API request must carry. */
	PIM_API_TOKEN?: string;
	/** Optional URL that receives notifications as JSON POSTs. */
	PIM_NOTIFY_WEBHOOK?: string;
}

interface Env extends PimSecrets {}

declare namespace Cloudflare {
	interface Env extends PimSecrets {}
}
