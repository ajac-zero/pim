/**
 * Side jobs ask a model every few seconds. When the ChatGPT plan fails them
 * with anything but its usage limit, which cools it down until the limit
 * resets (see ./provider-cooldowns.ts), they leave it alone for a minute and
 * use another provider instead.
 */

/** How long a plan is left alone after an error that isn't its usage limit. */
export const ERROR_COOLDOWN_MS = 60 * 1000;

/** Remembers, in memory, until when each provider is not to be asked. */
export class Cooldowns {
	readonly #until = new Map<string, number>();

	/** Leaves `provider` alone for a minute. */
	failed(provider: string, now = Date.now()): void {
		this.#until.set(provider, now + ERROR_COOLDOWN_MS);
	}

	blocked(provider: string, now = Date.now()): boolean {
		return (this.#until.get(provider) ?? 0) > now;
	}

	clear(provider: string): void {
		this.#until.delete(provider);
	}
}
