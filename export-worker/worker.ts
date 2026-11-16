import { DurableObject } from "cloudflare:workers";
import { listTables, readRows } from "../packages/core/src/migrate/export-api";

/**
 * The maintenance and export runtime: a version of the Worker that is inert, and the only thing deployed for the
 * cutover (docs/v2/cutover.md, steps 5 to 9). Every Durable Object class the product defines is exported here as a
 * shell that has no product code: it never starts an agent, runs no job, answers no request but the export's, and its
 * alarm() returns without re-arming. Storage is read, never written. The bindings, migrations and class names in
 * wrangler.export.jsonc are the product's own, so no namespace is deleted and no data is touched.
 *
 * Nothing here is deployed by this repository's CI or by merging this branch.
 */
interface Env {
	PIM_EXPORT_TOKEN: string;
	CF_VERSION_METADATA: { id: string };
	BLOBS: R2Bucket;
	ARTIFACTS: R2Bucket;
	Pim: DurableObjectNamespace<Shell>;
	Auth: DurableObjectNamespace<Shell>;
	Directory: DurableObjectNamespace<Shell>;
	Gallery: DurableObjectNamespace<Shell>;
	CodingScheduler: DurableObjectNamespace<Shell>;
	CodingThread: DurableObjectNamespace<Shell>;
	HostOps: DurableObjectNamespace<Shell>;
	WorkspaceCatalog: DurableObjectNamespace<Shell>;
}

const inert = () => new Response("This Pim is in maintenance.", { status: 503, headers: { "retry-after": "3600" } });

const constantTime = (a: string, b: string) => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

/** What every class is: a plain Durable Object with a read-only dump and nothing else. */
export class Shell extends DurableObject<Env> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/__export/tables") return Response.json(listTables(this.ctx.storage.sql));
		if (url.pathname === "/__export/rows") {
			try {
				return Response.json(readRows(this.ctx.storage.sql, url.searchParams.get("table") ?? "", Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 1000)));
			} catch (error) {
				return Response.json({ error: (error as Error).message }, { status: 400 });
			}
		}
		return inert();
	}

	/** Consumes the alarm and does not set another: an old alarm that fires here is neutralised, its rows left intact for the export. */
	override async alarm(): Promise<void> {}
}

export class Pim extends Shell {}
export class Auth extends Shell {}
export class Directory extends Shell {}
export class Gallery extends Shell {}
export class CodingSchedulerDO extends Shell {}
export class CodingThreadDO extends Shell {}
export class HostOps extends Shell {}
export class WorkspaceContainer extends Shell {}
export class WorkspaceCatalog extends Shell {}
/** The container egress entrypoint denies everything. */
export class ContainerEgress {
	fetch(): Response {
		return new Response("denied", { status: 403 });
	}
}

const NAMESPACES = { pim: "Pim", auth: "Auth", directory: "Directory", gallery: "Gallery", scheduler: "CodingScheduler", thread: "CodingThread", hostops: "HostOps", catalog: "WorkspaceCatalog" } as const;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/__maintenance/version") return Response.json({ version: env.CF_VERSION_METADATA.id, mode: "maintenance" });
		if (!url.pathname.startsWith("/__export/")) return inert();
		const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
		if (!env.PIM_EXPORT_TOKEN || !constantTime(token, env.PIM_EXPORT_TOKEN)) return new Response("unauthorized", { status: 401 });
		// /__export/do/<kind>/<name>/(tables|rows)
		const match = /^\/__export\/do\/([a-z]+)\/([^/]+)\/(tables|rows)$/.exec(url.pathname);
		if (match) {
			const binding = NAMESPACES[match[1] as keyof typeof NAMESPACES];
			if (!binding) return new Response("unknown kind", { status: 404 });
			const stub = env[binding].getByName(decodeURIComponent(match[2]!));
			return stub.fetch(`https://shell/__export/${match[3]}${url.search}`);
		}
		const blobs = /^\/__export\/r2\/(blobs|artifacts)$/.exec(url.pathname);
		if (blobs) {
			const bucket = blobs[1] === "blobs" ? env.BLOBS : env.ARTIFACTS;
			const listed = await bucket.list({ cursor: url.searchParams.get("cursor") ?? undefined, limit: 500 });
			return Response.json({ objects: listed.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag, contentType: o.httpMetadata?.contentType })), cursor: listed.truncated ? listed.cursor : null });
		}
		const object = /^\/__export\/r2\/(blobs|artifacts)\/(.+)$/.exec(url.pathname);
		if (object) {
			const body = await (object[1] === "blobs" ? env.BLOBS : env.ARTIFACTS).get(decodeURIComponent(object[2]!));
			return body ? new Response(body.body) : new Response("not found", { status: 404 });
		}
		return new Response("not found", { status: 404 });
	},
};
