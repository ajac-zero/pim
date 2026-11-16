import type { CodingVaultKey, Harness } from "@pim/shared/harnesses";
import type { VaultBackend } from "./vault";
import type { VaultRecord } from "./store";

/** How long a sealed entry read from a person's space is reused before it is read again. */
export const VAULT_READ_TTL_MS = 30_000;
/** How many entries are kept, across everyone this isolate serves; the least recently used go first. */
export const VAULT_READ_MAX_ENTRIES = 256;

type Cached = { readonly record: VaultRecord; readonly at: number };

/**
 * A `VaultBackend` that reads each person's entry from their space once in
 * a short while, instead of on every call. A coding thread asks for its
 * person's Amp key on every poll, and each ask is a call into the one
 * Durable Object that also runs their chats; made often enough they queue
 * there until the platform refuses them as overload.
 *
 * What is kept is the sealed entry, ciphertext as the space holds it, never
 * the key it opens to, and each entry is kept under its person and harness
 * alone. An entry is reused only for `ttlMs`, and is forgotten at once
 * when this isolate writes or deletes it, or `invalidate` is called, such
 * as when the harness it opened for turned out to be rejected. Another
 * isolate's write is seen within the TTL. An entry that holds nothing is
 * never kept, so connecting is seen at once. Reads of the same entry at
 * the same moment share one call.
 */
export class CachingVaultBackend implements VaultBackend {
	readonly #entries = new Map<string, Cached>();
	readonly #reading = new Map<string, Promise<VaultRecord>>();
	/** Counts forgettings, so a read that began before one doesn't keep what it read. */
	#epoch = 0;

	constructor(
		public inner: VaultBackend,
		readonly ttlMs: number = VAULT_READ_TTL_MS,
		readonly maxEntries: number = VAULT_READ_MAX_ENTRIES,
		readonly now: () => number = Date.now,
	) {}

	status(userId: string) {
		return this.inner.status(userId);
	}

	read(userId: string, harness: CodingVaultKey, options?: { fresh?: boolean }): Promise<VaultRecord> {
		const key = cacheKey(userId, harness);
		if (!options?.fresh) {
			const cached = this.#entries.get(key);
			if (cached && this.now() - cached.at < this.ttlMs) {
				// Used now, so last to go.
				this.#entries.delete(key);
				this.#entries.set(key, cached);
				return Promise.resolve(cached.record);
			}
			this.#entries.delete(key);
			const inflight = this.#reading.get(key);
			if (inflight) return inflight;
		}
		const epoch = this.#epoch;
		const read = this.inner.read(userId, harness, options).then((record) => {
			if (epoch === this.#epoch && record.sealed !== null) this.#keep(key, record);
			return record;
		});
		if (options?.fresh) return read;
		this.#reading.set(key, read);
		const done = () => {
			if (this.#reading.get(key) === read) this.#reading.delete(key);
		};
		read.then(done, done);
		return read;
	}

	async write(userId: string, harness: CodingVaultKey, sealed: Uint8Array, byteLength: number, expectedVersion: number) {
		this.invalidate(userId, harness);
		try {
			return await this.inner.write(userId, harness, sealed, byteLength, expectedVersion);
		} finally {
			this.invalidate(userId, harness);
		}
	}

	async delete(userId: string, harness: Harness) {
		this.invalidate(userId, harness);
		try {
			return await this.inner.delete(userId, harness);
		} finally {
			this.invalidate(userId, harness);
		}
	}

	/** Forgets what is kept of the person's `harness`, and every harness of theirs when none is named. */
	invalidate(userId: string, harness?: Harness | CodingVaultKey): void {
		this.#epoch++;
		const prefix = harness === undefined ? `${userId}\0` : cacheKey(userId, harness);
		for (const key of [...this.#entries.keys()]) if (harness === undefined ? key.startsWith(prefix) : key === prefix) this.#entries.delete(key);
		for (const key of [...this.#reading.keys()]) if (harness === undefined ? key.startsWith(prefix) : key === prefix) this.#reading.delete(key);
	}

	clear(): void {
		this.#epoch++;
		this.#entries.clear();
		this.#reading.clear();
	}

	get size(): number {
		return this.#entries.size;
	}

	#keep(key: string, record: VaultRecord): void {
		this.#entries.delete(key);
		this.#entries.set(key, { record, at: this.now() });
		while (this.#entries.size > this.maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
	}
}

const cacheKey = (userId: string, harness: string): string => `${userId}\0${harness}`;
