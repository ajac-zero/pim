// The inert maintenance and export Worker, deployed in place of the legacy Worker for the cutover (docs/architecture/inventory/C-cutover-fence-entrypoints.md,
// step 6 option B). It is a separate entrypoint, not a mode of the product: nothing in the product reads a freeze flag.
//
// What it does:
//  - exports every Durable Object class the legacy Worker exports, under the same class names, so the bindings, migrations and containers
//    block of wrangler.jsonc stay as they are and no namespace or storage is deleted or rejected;
//  - makes every class a plain DurableObject that never runs `agents` `Lifecycle`: a job whose callback is missing is dropped as done
//    by that scheduler, so a class that used it without the callbacks would destroy schedule rows;
//  - consumes every alarm without re-arming it and without touching storage, so cf_agents_jobs, pi tables and trigger tables stay exactly as exported;
//  - answers every ordinary request with 503 Maintenance;
//  - behind a bearer token, exposes read-only dumps of every Durable Object's SQLite tables and key-value entries, the alarm each holds,
//    the R2 buckets' listings and objects, and OAUTH_KV, which `scripts/v2-migrate` turns into a snapshot.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { type Env, handleFetch } from "./routes.ts";

/** A Durable Object that does nothing on its own. */
class Inert extends DurableObject<Env> {
	/** Ordinary traffic reaches nothing here: every legacy method is gone, and the one entry is refused. */
	override async fetch(): Promise<Response> {
		return Response.json({ error: "Maintenance", message: "This Pim is being moved and answers nothing right now." }, { status: 503, headers: { "retry-after": "3600" } });
	}

	/** A due physical alarm lands here, is consumed by returning, and is never set again. Storage is not read or written. */
	override async alarm(): Promise<void> {}

	// The only RPC surface: authenticated read-only exports, called by the Worker's own fetch handler.
	fenceProbe() {
		return { alive: true, className: this.constructor.name, version: this.env.CF_VERSION_METADATA ?? null };
	}
	fenceAlarm(): Promise<number | null> {
		return this.ctx.storage.getAlarm();
	}
	fenceTables() {
		const sql = this.ctx.storage.sql;
		const tables = sql.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").toArray();
		return tables.map((t) => {
			const name = String(t.name);
			const info = sql.exec(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).toArray();
			const rows = Number(sql.exec(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).one().n);
			return { name, columns: info.map((c) => String(c.name)), pk: info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name)), withoutRowid: /WITHOUT\s+ROWID/i.test(String(t.sql)), rows };
		});
	}
	fenceRows(table: string, after: number, limit: number) {
		const sql = this.ctx.storage.sql;
		const known = this.fenceTables().find((t) => t.name === table);
		if (!known) throw new Error(`No such table: ${table}`);
		const quoted = `"${table.replace(/"/g, '""')}"`;
		const bounded = Math.max(1, Math.min(limit, 2000));
		// Tables with a rowid are paged by it; WITHOUT ROWID tables (cf_agents_jobs) are small and paged by offset over their key.
		const cursor = known.withoutRowid ? sql.exec(`SELECT * FROM ${quoted} ORDER BY ${known.pk.map((c) => `"${c}"`).join(", ")} LIMIT ? OFFSET ?`, bounded, after) : sql.exec(`SELECT rowid AS "__rowid", * FROM ${quoted} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, bounded);
		const rows: Record<string, unknown>[] = [];
		let last = after;
		for (const row of cursor) {
			const out: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(row)) {
				if (key === "__rowid") last = Number(value);
				else out[key] = value instanceof ArrayBuffer ? { $b64: toBase64(new Uint8Array(value)) } : value;
			}
			rows.push(out);
		}
		return { rows, next: known.withoutRowid ? after + rows.length : last, done: rows.length < bounded };
	}
	async fenceKv(startAfter: string | undefined, limit: number) {
		const entries = await this.ctx.storage.list({ limit, ...(startAfter === undefined ? {} : { startAfter }) });
		return { entries: [...entries].map(([key, value]) => ({ key, value: value as unknown })), done: entries.size < limit };
	}
	/** The one write the shell offers, off unless the deploy turns it on: stops a running container, as step 8 of the fence procedure asks. */
	fenceDestroyContainer(): { running: boolean; destroyed: boolean } {
		const container = (this.ctx as unknown as { container?: { running: boolean; destroy(): Promise<void> } }).container;
		if (!container) return { running: false, destroyed: false };
		const running = container.running;
		if (running) void container.destroy();
		return { running, destroyed: running };
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

// The legacy class names, exactly as wrangler.jsonc binds them (CodingSchedulerDO and CodingThreadDO are bound as CodingScheduler and CodingThread).
export class Pim extends Inert {}
export class Auth extends Inert {}
export class Directory extends Inert {}
export class Gallery extends Inert {}
export class CodingSchedulerDO extends Inert {}
export class CodingThreadDO extends Inert {}
export class HostOps extends Inert {}
export class WorkspaceContainer extends Inert {}
export class WorkspaceCatalog extends Inert {}

/** Containers call this for every outbound request; the shell denies all of them. */
export class ContainerEgress extends WorkerEntrypoint<Env> {
	override async fetch(): Promise<Response> {
		return new Response("Maintenance: outbound requests are not allowed", { status: 403 });
	}
}

export default {
	fetch: (request: Request, env: Env) => handleFetch(request, env),
} satisfies ExportedHandler<Env>;
