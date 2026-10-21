/**
 * Files' bytes in R2, each stored once under its SHA-256, for a store in
 * the owner's Durable Object that lists them by hash in its own tables:
 * artifacts' versions (./artifacts.ts) and skills' (./skills.ts).
 *
 * - **Writing stores first, then lists.** `store` puts a write's new files
 *   in R2, then runs its `commit`, which checks and lists them with nothing
 *   awaited in between, or refuses.
 * - **Deleting frees what nothing lists.** `collect` deletes from R2 each
 *   file that no row lists. A write storing the same file at that moment
 *   has claimed it (the `pending` table), and work on one file waits for
 *   the work on it before, so a deletion can't take a file from under a
 *   write. A file a refused write stored is freed the same way.
 */

/** How long a write's claim on a file it is storing keeps it from being collected, should the write never finish. */
const PENDING_MS = 60 * 60 * 1000;

export type FileStoreOptions = {
	readonly bucket: R2Bucket;
	/** Where a file's bytes are in the bucket. */
	readonly key: (hash: string) => string;
	/** The table of claims by writes under way, which this makes. */
	readonly pending: string;
	/** Whether any row lists the file. */
	readonly listed: (hash: string) => boolean;
};

export class FileStore {
	readonly #sql: SqlStorage;
	readonly #options: FileStoreOptions;
	/** One chain of R2 work per file hash, so a file isn't collected while a write stores it again. */
	readonly #locks = new Map<string, Promise<void>>();

	constructor(sql: SqlStorage, options: FileStoreOptions) {
		this.#sql = sql;
		this.#options = options;
		this.#sql.exec(`CREATE TABLE IF NOT EXISTS ${options.pending} (
	sha256 TEXT NOT NULL,
	write TEXT NOT NULL,
	at INTEGER NOT NULL,
	PRIMARY KEY (sha256, write)
)`);
	}

	/**
	 * Stores the files among `hashes` that `bytes` has in R2, then runs
	 * `commit`, which must check what it needs and list them without
	 * awaiting. Whatever no row lists afterwards is collected.
	 */
	async store<T>(hashes: Iterable<string>, bytes: ReadonlyMap<string, Uint8Array>, commit: () => T): Promise<T> {
		const write = crypto.randomUUID();
		const stored = [...new Set(hashes)].filter((hash) => bytes.has(hash));
		const now = Date.now();
		for (const hash of stored) this.#sql.exec(`INSERT INTO ${this.#options.pending} (sha256, write, at) VALUES (?, ?, ?)`, hash, write, now);
		try {
			await Promise.all(
				stored.map((hash) =>
					this.#locked(hash, async () => {
						await this.#options.bucket.put(this.#options.key(hash), bytes.get(hash)!);
					}),
				),
			);
			return commit();
		} finally {
			this.#sql.exec(`DELETE FROM ${this.#options.pending} WHERE write = ?`, write);
			await this.collect(stored);
		}
	}

	/** Runs R2 work on one file hash after the work on it before. */
	#locked(hash: string, work: () => Promise<void>): Promise<void> {
		const before = this.#locks.get(hash) ?? Promise.resolve();
		const done = before.then(work, work);
		const settled = done.catch(() => undefined);
		this.#locks.set(hash, settled);
		void settled.then(() => {
			if (this.#locks.get(hash) === settled) this.#locks.delete(hash);
		});
		return done;
	}

	/** Deletes from R2 the files no row lists and no write is storing. */
	async collect(hashes: readonly string[]): Promise<void> {
		const { pending, listed, bucket, key } = this.#options;
		this.#sql.exec(`DELETE FROM ${pending} WHERE at < ?`, Date.now() - PENDING_MS);
		await Promise.all(
			hashes.map((hash) =>
				this.#locked(hash, async () => {
					// Checked here, just before deleting: a write that claims it later stores it again after.
					if (listed(hash) || this.#sql.exec(`SELECT 1 FROM ${pending} WHERE sha256 = ? LIMIT 1`, hash).toArray().length > 0) return;
					await bucket.delete(key(hash));
				}),
			),
		);
	}
}
