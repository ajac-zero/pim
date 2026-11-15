/**
 * The Gitea connection in the Directory's database (../../directory.ts),
 * which is the deployment's own: one row per Gitea instance, holding only
 * the sealed tokens (./gitea-connection.ts seals and opens them; this store
 * never does) and what can be said without opening them. Beside it are the
 * sign-in attempts in flight: a hash of each random `state`, the person it
 * is bound to, and when it lapses.
 *
 * Every write to the connection names the version it read and is refused
 * when the row has moved on, so two refreshes can never both store tokens;
 * Gitea rotates the refresh token, so the loser's would be dead anyway. A
 * refresh also takes a short lease first, so that only one request at a
 * time spends the refresh token. Disconnecting keeps the row, without its
 * tokens, so versions never repeat.
 */

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS gitea_connection (
		instance TEXT PRIMARY KEY,
		version INTEGER NOT NULL,
		sealed BLOB,
		login TEXT,
		needs_reconnect INTEGER NOT NULL DEFAULT 0,
		lease_until INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS gitea_oauth_state (
		hash TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
];

/** The connection as a request sees it: its version, its sealed tokens unless there are none, and who it is. */
export type GiteaRecord = { readonly version: number; readonly sealed: Uint8Array | null; readonly login: string | null; readonly needsReconnect: boolean };

export type GiteaWriteResult = { readonly ok: boolean; readonly version: number };

type Row = { version: number; sealed: ArrayBuffer | null; login: string | null; needs_reconnect: number; lease_until: number };

export class GiteaStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		for (const statement of SCHEMA) sql.exec(statement);
	}

	#row(instance: string): Row | undefined {
		return this.#sql.exec<Row>("SELECT version, sealed, login, needs_reconnect, lease_until FROM gitea_connection WHERE instance = ?", instance).toArray()[0];
	}

	read(instance: string): GiteaRecord {
		const row = this.#row(instance);
		return {
			version: row ? Number(row.version) : 0,
			sealed: row?.sealed != null ? new Uint8Array(row.sealed) : null,
			login: row?.login ?? null,
			needsReconnect: row ? Number(row.needs_reconnect) === 1 : false,
		};
	}

	/** Stores tokens, if the connection is still at `expectedVersion`; this ends any lease and clears `needsReconnect`. */
	write(instance: string, sealed: Uint8Array, login: string, expectedVersion: number, now: number): GiteaWriteResult {
		const current = this.read(instance);
		if (current.version !== expectedVersion) return { ok: false, version: current.version };
		const version = expectedVersion + 1;
		this.#sql.exec(
			"INSERT OR REPLACE INTO gitea_connection (instance, version, sealed, login, needs_reconnect, lease_until, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
			instance,
			version,
			sealed,
			login,
			now,
		);
		return { ok: true, version };
	}

	/** Takes the right to refresh the tokens at `version` until `until`, unless someone holds it or the connection has moved on. */
	claimRefresh(instance: string, version: number, now: number, until: number): boolean {
		const row = this.#row(instance);
		if (!row || Number(row.version) !== version || row.sealed === null || Number(row.lease_until) > now) return false;
		this.#sql.exec("UPDATE gitea_connection SET lease_until = ? WHERE instance = ?", until, instance);
		return true;
	}

	/** Gives the lease back after a refresh that failed for a reason that says nothing about the tokens. */
	releaseRefresh(instance: string, version: number): void {
		this.#sql.exec("UPDATE gitea_connection SET lease_until = 0 WHERE instance = ? AND version = ?", instance, version);
	}

	/** Drops the tokens that no longer work, keeping who they were for, if the connection is still at `expectedVersion`. */
	markNeedsReconnect(instance: string, expectedVersion: number, now: number): GiteaWriteResult {
		const current = this.read(instance);
		if (current.version !== expectedVersion) return { ok: false, version: current.version };
		const version = expectedVersion + 1;
		this.#sql.exec("UPDATE gitea_connection SET version = ?, sealed = NULL, needs_reconnect = 1, lease_until = 0, updated_at = ? WHERE instance = ?", version, now, instance);
		return { ok: true, version };
	}

	/** Forgets the tokens and who they were for. */
	disconnect(instance: string, now: number): void {
		const current = this.read(instance);
		this.#sql.exec(
			"INSERT OR REPLACE INTO gitea_connection (instance, version, sealed, login, needs_reconnect, lease_until, updated_at) VALUES (?, ?, NULL, NULL, 0, 0, ?)",
			instance,
			current.version + 1,
			now,
		);
	}

	/** Records a sign-in attempt, and forgets the ones that lapsed. */
	createState(hash: string, ownerId: string, expiresAt: number, now: number): void {
		this.#sql.exec("DELETE FROM gitea_oauth_state WHERE expires_at <= ?", now);
		this.#sql.exec("INSERT INTO gitea_oauth_state (hash, owner_id, expires_at) VALUES (?, ?, ?)", hash, ownerId, expiresAt);
	}

	/** Whose attempt a state is, if it is one still open; it is used up either way, so no state works twice. */
	consumeState(hash: string, now: number): string | null {
		const row = this.#sql.exec<{ owner_id: string; expires_at: number }>("SELECT owner_id, expires_at FROM gitea_oauth_state WHERE hash = ?", hash).toArray()[0];
		if (!row) return null;
		this.#sql.exec("DELETE FROM gitea_oauth_state WHERE hash = ?", hash);
		return Number(row.expires_at) > now ? row.owner_id : null;
	}
}
