import type { ExtensionData } from "./define";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_extension_data (
	extension TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (extension, key)
);
`;

const MAX_KEY = 512;

/**
 * Extensions' data in a person's Pim: each extension sees only its own
 * keys. It goes with the person's export, and with their account.
 */
export class ExtensionDataStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec(SCHEMA);
	}

	for(extension: string): ExtensionData {
		const sql = this.#sql;
		return {
			get: <T>(key: string) => {
				const [row] = sql.exec("SELECT value FROM pim_extension_data WHERE extension = ? AND key = ?", extension, key).toArray();
				return row ? (JSON.parse(String(row.value)) as T) : undefined;
			},
			put: (key, value) => {
				if (key === "" || key.length > MAX_KEY) throw new Error(`An extension's key is 1 to ${MAX_KEY} characters`);
				const json = JSON.stringify(value);
				if (json === undefined) throw new Error(`${extension} can't store ${String(value)}: it isn't JSON`);
				sql.exec(
					"INSERT INTO pim_extension_data (extension, key, value) VALUES (?, ?, ?) ON CONFLICT (extension, key) DO UPDATE SET value = excluded.value",
					extension,
					key,
					json,
				);
			},
			delete: (key) => sql.exec("DELETE FROM pim_extension_data WHERE extension = ? AND key = ?", extension, key).rowsWritten > 0,
			list: <T>(prefix = "") =>
				sql
					// substr, not LIKE: a key may hold % or _.
					.exec(
						"SELECT key, value FROM pim_extension_data WHERE extension = ? AND substr(key, 1, ?) = ? ORDER BY key",
						extension,
						prefix.length,
						prefix,
					)
					.toArray()
					.map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) as T })),
		};
	}

	/** Everything, by extension, for the person's export. */
	export(): Record<string, Record<string, unknown>> {
		const all: Record<string, Record<string, unknown>> = {};
		for (const row of this.#sql.exec("SELECT extension, key, value FROM pim_extension_data ORDER BY extension, key")) {
			(all[String(row.extension)] ??= {})[String(row.key)] = JSON.parse(String(row.value));
		}
		return all;
	}
}
