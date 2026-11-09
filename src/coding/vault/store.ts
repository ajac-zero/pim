import { MAX_ARCHIVE_BYTES } from "./archive";
import { SEAL_OVERHEAD } from "./crypto";
import type { Harness } from "./harnesses";

/**
 * The vault's entries in a space's own database (the Pim Durable Object's,
 * where its other credentials are), one row per harness. A row holds only
 * the sealed blob, which this store never opens, and what can be said
 * without opening it: its version, size and when it changed.
 *
 * Each write names the version it read, and is refused when the row has
 * moved on since, so a workspace that read an older login can't overwrite a
 * newer one. Disconnecting keeps the row without its blob, so versions
 * never repeat and a write based on the deleted login is refused too.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_coding_vault (
	harness TEXT PRIMARY KEY,
	version INTEGER NOT NULL,
	sealed BLOB,
	byte_length INTEGER,
	updated_at INTEGER NOT NULL
)`;

/** The most a sealed blob may be. */
export const MAX_SEALED_BYTES = MAX_ARCHIVE_BYTES + SEAL_OVERHEAD;

/** What may be said of an entry without opening it. `byteLength` is the archive's size. */
export type VaultStatus = {
	readonly harness: Harness;
	readonly connected: boolean;
	readonly updatedAt: number | null;
	readonly byteLength: number | null;
	readonly version: number;
};

/** An entry as a workspace reads it: its version, and its sealed blob unless disconnected. */
export type VaultRecord = { readonly version: number; readonly sealed: Uint8Array | null };

export type VaultWriteResult = { readonly ok: true; readonly version: number } | { readonly ok: false; readonly version: number };

type Row = { version: number; sealed: ArrayBuffer | null; byte_length: number | null; updated_at: number };

export class VaultStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
	}

	#row(harness: Harness): Row | undefined {
		return this.#sql.exec<Row>("SELECT version, sealed, byte_length, updated_at FROM pim_coding_vault WHERE harness = ?", harness).toArray()[0];
	}

	status(harness: Harness): VaultStatus {
		const row = this.#row(harness);
		const connected = row?.sealed != null;
		return {
			harness,
			connected,
			updatedAt: row ? Number(row.updated_at) : null,
			byteLength: connected ? Number(row!.byte_length) : null,
			version: row ? Number(row.version) : 0,
		};
	}

	read(harness: Harness): VaultRecord {
		const row = this.#row(harness);
		return { version: row ? Number(row.version) : 0, sealed: row?.sealed != null ? new Uint8Array(row.sealed) : null };
	}

	/** Stores a sealed blob of an archive of `byteLength` bytes, if the entry is still at `expectedVersion`. */
	write(harness: Harness, sealed: Uint8Array, byteLength: number, expectedVersion: number, now: number): VaultWriteResult {
		if (!(sealed instanceof Uint8Array) || sealed.byteLength > MAX_SEALED_BYTES) throw new Error(`A vault entry holds at most ${MAX_SEALED_BYTES} bytes`);
		if (!Number.isInteger(byteLength) || byteLength < 0 || sealed.byteLength !== byteLength + SEAL_OVERHEAD) throw new Error("A vault entry's size doesn't match its blob");
		if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error("A vault write names the version it read");
		const current = this.#row(harness);
		const version = current ? Number(current.version) : 0;
		if (version !== expectedVersion) return { ok: false, version };
		const blob = sealed.slice().buffer;
		this.#sql.exec(
			"INSERT INTO pim_coding_vault (harness, version, sealed, byte_length, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (harness) DO UPDATE SET version = excluded.version, sealed = excluded.sealed, byte_length = excluded.byte_length, updated_at = excluded.updated_at",
			harness,
			version + 1,
			blob,
			byteLength,
			now,
		);
		return { ok: true, version: version + 1 };
	}

	/** Disconnects: drops the blob and moves the version on, so writes based on it are refused. */
	delete(harness: Harness, now: number): VaultStatus {
		const current = this.#row(harness);
		if (current?.sealed != null) {
			this.#sql.exec("UPDATE pim_coding_vault SET sealed = NULL, byte_length = NULL, version = version + 1, updated_at = ? WHERE harness = ?", now, harness);
		}
		return this.status(harness);
	}
}
