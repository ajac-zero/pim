// Pulls a complete legacy snapshot out of the inert fence worker's authenticated read-only routes. It uses web APIs only (fetch, WebCrypto),
// so it runs in Node for the real cutover and inside workerd in tests; where the bytes go is a sink (a directory in the CLI, memory in tests).
import type { DoDump, ObjectEntry, SnapshotManifest } from "./snapshot.ts";

export type ExportSink = {
	dump(dump: DoDump): Promise<void>;
	object(bucket: string, key: string, bytes: Uint8Array, contentType: string | null): Promise<void>;
	oauthKv(entries: { key: string; value: unknown }[]): Promise<void>;
	finish(manifest: Omit<SnapshotManifest, "files" | "format">): Promise<unknown>;
};

export type ExportOptions = {
	readonly baseUrl: string;
	readonly token: string;
	readonly sink: ExportSink;
	readonly fetch?: (request: Request) => Promise<Response>;
	/** The instant the fence was verified (step 9 of the fence procedure). Defaults to now: pass the verified time. */
	readonly cutoverAt?: number;
	readonly keyMaterial?: SnapshotManifest["keyMaterial"];
	readonly onProgress?: (line: string) => void;
};

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export class FenceExporter {
	readonly #o: ExportOptions;
	constructor(options: ExportOptions) {
		this.#o = options;
	}

	async #get<T>(path: string): Promise<T> {
		const response = await (this.#o.fetch ?? ((r) => fetch(r)))(new Request(new URL(`/fence/v1/${path}`, this.#o.baseUrl), { headers: { authorization: `Bearer ${this.#o.token}` } }));
		if (!response.ok) throw new Error(`Export ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
		return (await response.json()) as T;
	}

	/** Dumps one Durable Object completely: every table row, every key-value entry and its pending alarm. */
	async dumpObject(binding: string, name: string): Promise<DoDump> {
		const base = `do/${binding}/${encodeURIComponent(name)}`;
		const tables = await this.#get<{ name: string; columns: string[]; rows: number }[]>(`${base}/tables`);
		const out: Record<string, { columns: string[]; rows: DoDump["tables"][string]["rows"][number][] }> = {};
		for (const table of tables) {
			const rows: DoDump["tables"][string]["rows"][number][] = [];
			for (let after = 0, done = false; !done; ) {
				const page = await this.#get<{ rows: typeof rows; next: number; done: boolean }>(`${base}/rows?table=${encodeURIComponent(table.name)}&after=${after}&limit=1000`);
				rows.push(...page.rows);
				after = page.next;
				done = page.done;
			}
			if (rows.length !== table.rows) throw new Error(`${binding}/${name} ${table.name}: exported ${rows.length} rows, the table has ${table.rows}`);
			out[table.name] = { columns: table.columns, rows };
		}
		const kv: { key: string; value: unknown }[] = [];
		for (let after: string | undefined, done = false; !done; ) {
			const page: { entries: { key: string; value: unknown }[]; done: boolean } = await this.#get(`${base}/kv?limit=500${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`);
			kv.push(...page.entries);
			after = page.entries.at(-1)?.key;
			done = page.done;
		}
		const { alarm } = await this.#get<{ alarm: number | null }>(`${base}/alarm`);
		return { class: binding, name, tables: out, kv, alarm };
	}

	async #dumpAndWrite(binding: string, name: string): Promise<DoDump> {
		const dump = await this.dumpObject(binding, name);
		await this.#o.sink.dump(dump);
		this.#o.onProgress?.(`${binding}/${name}: ${Object.values(dump.tables).reduce((n, t) => n + t.rows.length, 0)} rows, ${dump.kv.length} kv`);
		return dump;
	}

	/**
	 * The whole legacy deployment: the Directory (which names every space), then per space its Auth, Pim and CodingScheduler objects, every coding thread
	 * the scheduler indexes, and the deployment-wide Gallery, HostOps and WorkspaceCatalog; then both R2 buckets (SHA-256 measured here) and OAUTH_KV.
	 */
	async run(): Promise<{ objects: ObjectEntry[]; spaces: string[] }> {
		const directory = await this.#dumpAndWrite("Directory", "directory");
		const spaces = (directory.tables.accounts?.rows ?? []).map((row) => String(row.owner_id));
		const threads = new Set<string>();
		for (const owner of spaces) {
			await this.#dumpAndWrite("Auth", owner);
			await this.#dumpAndWrite("Pim", owner);
			const scheduler = await this.#dumpAndWrite("CodingScheduler", owner);
			for (const row of scheduler.tables.pim_coding_threads?.rows ?? []) threads.add(String(row.thread_id));
		}
		for (const id of [...threads].sort()) await this.#dumpAndWrite("CodingThread", id);
		for (const [binding, name] of [["Gallery", "gallery"], ["HostOps", "hostops"], ["WorkspaceCatalog", "workspaces"]] as const) await this.#dumpAndWrite(binding, name);
		const catalog = await this.dumpObject("WorkspaceCatalog", "workspaces");
		for (const entry of catalog.kv) if (entry.key.startsWith("session:")) await this.#dumpAndWrite("WorkspaceContainer", entry.key.slice("session:".length));

		const objects: ObjectEntry[] = [];
		for (const bucket of ["ARTIFACTS", "BLOBS"] as const) {
			for (let cursor: string | null = null, more = true; more; ) {
				const page: { objects: { key: string; size: number; contentType: string | null }[]; truncated: boolean; cursor: string | null } = await this.#get(`r2/${bucket}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
				for (const object of page.objects) {
					const response = await (this.#o.fetch ?? ((r) => fetch(r)))(new Request(new URL(`/fence/v1/r2/${bucket}/object?key=${encodeURIComponent(object.key)}`, this.#o.baseUrl), { headers: { authorization: `Bearer ${this.#o.token}` } }));
					if (!response.ok) throw new Error(`Object ${bucket}/${object.key} answered ${response.status}`);
					const bytes = new Uint8Array(await response.arrayBuffer());
					if (bytes.length !== object.size) throw new Error(`Object ${bucket}/${object.key}: read ${bytes.length} bytes, the listing says ${object.size}`);
					await this.#o.sink.object(bucket, object.key, bytes, object.contentType);
					objects.push({ bucket, key: object.key, size: bytes.length, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)), contentType: object.contentType });
				}
				cursor = page.cursor;
				more = page.truncated;
			}
		}
		const oauth: { key: string; value: unknown }[] = [];
		for (let cursor: string | null = null, more = true; more; ) {
			const page: { keys: { name: string }[]; done: boolean; cursor: string | null } = await this.#get(`kv/OAUTH_KV${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
			for (const key of page.keys) {
				const { value } = await this.#get<{ value: string | null }>(`kv/OAUTH_KV?key=${encodeURIComponent(key.name)}`);
				oauth.push({ key: key.name, value: value === null ? null : safeJson(value) });
			}
			cursor = page.cursor;
			more = !page.done;
		}
		await this.#o.sink.oauthKv(oauth);
		const now = Date.now();
		await this.#o.sink.finish({ cutoverAt: this.#o.cutoverAt ?? now, exportedAt: now, source: new URL(this.#o.baseUrl).host, keyMaterial: this.#o.keyMaterial ?? [] });
		return { objects, spaces };
	}
}

const safeJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};
