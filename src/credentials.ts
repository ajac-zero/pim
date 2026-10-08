import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { PimStore } from "./store";

/**
 * pi-ai's credential store over Pim's SQLite. pi-ai refreshes OAuth tokens
 * inside `modify`, and some providers rotate the refresh token on every
 * refresh, so two refreshes must never overlap: each provider's writes run
 * one after another, even across the awaits inside them.
 */
export class SqlCredentialStore implements CredentialStore {
	readonly #store: PimStore;
	readonly #queues = new Map<string, Promise<unknown>>();

	constructor(store: PimStore) {
		this.#store = store;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		const json = this.#store.credential(providerId);
		return json === undefined ? undefined : (JSON.parse(json) as Credential);
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.#store.credentialProviders().map((providerId) => ({
			providerId,
			type: (JSON.parse(this.#store.credential(providerId)!) as Credential).type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#serialized(providerId, async () => {
			const current = await this.read(providerId);
			const next = await fn(current);
			if (next === undefined) return current;
			this.#store.putCredential(providerId, JSON.stringify(next));
			return next;
		});
	}

	delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		return this.#serialized(providerId, async () => this.#store.deleteCredential(providerId));
	}

	#serialized<T>(providerId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(providerId) ?? Promise.resolve();
		// A failed write must not block the next one.
		const result = previous.catch(() => undefined).then(work);
		this.#queues.set(providerId, result);
		return result;
	}
}
