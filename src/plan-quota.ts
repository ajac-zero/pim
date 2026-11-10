/**
 * A subscription plan that has run out of quota answers every request with an
 * error. Side jobs ask again every few seconds, so once it has said so they
 * leave the plan alone for a while and use another provider instead.
 */

const QUOTA = /quota|usage[ _-]?limit|rate[ _-]?limit|too many requests|\b429\b|exceeded|insufficient|billing|limit reached|hit your|usage_limit_reached|try again (in|later)/i;

/** Whether an error message says the plan is out of quota or throttled, rather than the request being wrong. */
export function isQuotaError(message: string | undefined): boolean {
	return message !== undefined && QUOTA.test(message);
}

/** How long a plan is left alone after it ran out of quota, and after any other error. */
export const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
export const ERROR_COOLDOWN_MS = 60 * 1000;

/** Remembers, in memory, until when each provider is not to be asked. */
export class Cooldowns {
	readonly #until = new Map<string, number>();

	/** Leaves `provider` alone for the time `message` calls for. */
	failed(provider: string, message: string | undefined, now = Date.now()): void {
		this.#until.set(provider, now + (isQuotaError(message) ? QUOTA_COOLDOWN_MS : ERROR_COOLDOWN_MS));
	}

	blocked(provider: string, now = Date.now()): boolean {
		return (this.#until.get(provider) ?? 0) > now;
	}

	clear(provider: string): void {
		this.#until.delete(provider);
	}
}
