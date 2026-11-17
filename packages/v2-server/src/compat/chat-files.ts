/**
 * `/api/files` and `/api/files/content`: the person's files screen, over V2's objects. A file at `/workspace/notes/a.md` is the object
 * `<owner>/files/workspace/notes/a.md` (purpose `file`, private), so it is stored, sized and read like every other object, and a folder is only
 * what the paths under it say.
 */
import { createHash } from "node:crypto";
import { BadRequestError, ConflictError, NotFoundError, PimError } from "@pim/v2-app/errors";
import { ok, type Reply, type Route, route } from "@pim/v2-app/http";

const FILES_ROOT = "/workspace";
const MAX_UPLOAD_BYTES = 25_000_000;
const MAX_LISTED = 1000;

/** `path` resolved (`.`, `..`, repeated and trailing slashes), or a 400 when it isn't absolute or leaves the files root. */
function filesPath(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) throw new BadRequestError("path must be absolute, under /workspace");
	const parts: string[] = [];
	for (const part of value.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	const path = `/${parts.join("/")}`;
	if (path !== FILES_ROOT && !path.startsWith(`${FILES_ROOT}/`)) throw new BadRequestError("path must be under /workspace");
	return path;
}
const keyOf = (ownerId: string, path: string) => `${ownerId}/files${path}`;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const TYPES: Record<string, string> = {
	txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", json: "application/json", csv: "text/csv; charset=utf-8", html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", ts: "text/plain; charset=utf-8", tsx: "text/plain; charset=utf-8", py: "text/plain; charset=utf-8", xml: "application/xml",
	svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
};
const typeOf = (name: string) => TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

function fileHeaders(name: string, download: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": typeOf(name), "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff", "cache-control": "no-store, private",
		"cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer",
	};
	if (download) {
		const utf8 = name.normalize("NFC").replace(/[\u0000-\u001f\u007f"\\]+/g, "_");
		const ascii = utf8.replace(/[^\x20-\x7e]+/g, "_").replace(/[;%]+/g, "_");
		headers["content-disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
	}
	return headers;
}

const etags = (header: string | string[] | undefined): string[] => (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",").map((t) => t.trim().replace(/^W\//, "").replace(/^"|"$/g, "")).filter(Boolean);
const entryOf = (path: string, size: number, at: Date) => ({ name: baseName(path), path, type: "file", size, updatedAt: at.toISOString() });

export function fileRoutes(): Route[] {
	const stat = async (app: Parameters<Route["run"]>[0]["app"], ownerId: string, path: string) =>
		app.db.owner(ownerId, async (tx) => (await tx.query("SELECT size, sha256, created_at FROM pim_app.objects WHERE key = $1 AND purpose = 'file' AND deleted_at IS NULL", [keyOf(ownerId, path)])).rows[0] as { size: string; sha256: string; created_at: Date } | undefined);
	return [
		route("GET", "/api/files", async ({ app, principal, url }): Promise<Reply> => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const dir = filesPath(url.searchParams.get("path") ?? FILES_ROOT);
			const prefix = `${keyOf(p.ownerId, dir)}/`;
			const rows = await app.db.owner(p.ownerId, async (tx) => (await tx.query(
				"SELECT key, size, created_at FROM pim_app.objects WHERE purpose = 'file' AND deleted_at IS NULL AND left(key, length($1)) = $1 LIMIT 50000", [prefix],
			)).rows);
			const entries = new Map<string, { name: string; path: string; type: "file" | "directory"; size: number; updatedAt: Date }>();
			for (const r of rows) {
				const rest = (r.key as string).slice(prefix.length);
				const [first, ...more] = rest.split("/");
				const path = `${dir}/${first}`;
				const at = r.created_at as Date;
				if (more.length === 0) entries.set(path, { name: first!, path, type: "file", size: Number(r.size), updatedAt: at });
				else {
					const known = entries.get(path);
					entries.set(path, { name: first!, path, type: "directory", size: 0, updatedAt: known && known.updatedAt > at ? known.updatedAt : at });
				}
			}
			const list = [...entries.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1)).slice(0, MAX_LISTED);
			return ok({ path: dir, entries: list.map((e) => ({ ...e, updatedAt: e.updatedAt.toISOString() })) }, 200, { "cache-control": "no-store, private" });
		}),
		route("GET", "/api/files/content", async ({ app, principal, url, req }): Promise<Reply> => {
			const p = await principal();
			const path = filesPath(url.searchParams.get("path"));
			const served = await app.objects.serve(p, keyOf(p.ownerId, path), req.headers.range);
			const sha = served.headers.etag?.replace(/"/g, "");
			const headers = { ...served.headers, ...fileHeaders(baseName(path), url.searchParams.has("download")), ...(sha ? { "x-file-sha256": sha } : {}) };
			if (sha && !req.headers.range && etags(req.headers["if-none-match"]).some((t) => t === "*" || t === sha)) return { status: 304, headers: { etag: `"${sha}"`, "x-file-sha256": sha }, raw: new Uint8Array() };
			return { status: served.status, headers, raw: served.body };
		}),
		// A file's validators without its bytes.
		route("HEAD", "/api/files/content", async ({ app, principal, url }): Promise<Reply> => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:read");
			const row = await stat(app, p.ownerId, filesPath(url.searchParams.get("path")));
			if (!row) throw new NotFoundError("No such file");
			return { status: 200, headers: { etag: `"${row.sha256}"`, "x-file-sha256": row.sha256, "x-file-size": String(row.size), "x-file-mtime": String(row.created_at.getTime()), "cache-control": "no-store, private" }, raw: new Uint8Array() };
		}),
		route("PUT", "/api/files/content", async ({ app, principal, url, req, bytes }): Promise<Reply> => {
			const p = await principal();
			const path = filesPath(url.searchParams.get("path"));
			if (path === FILES_ROOT) throw new BadRequestError("A file needs a name");
			if (Number(req.headers["content-length"] ?? 0) > MAX_UPLOAD_BYTES) throw new PimError(413, "too_large", `A file can be at most ${MAX_UPLOAD_BYTES} bytes`);
			const body = await bytes(MAX_UPLOAD_BYTES);
			// `If-Match` writes only over a file with that hash; `If-None-Match: *` only where there is none.
			const match = etags(req.headers["if-match"]);
			const none = etags(req.headers["if-none-match"]);
			if (match.length > 1 || (match.length === 1 && !/^[0-9a-f]{64}$/.test(match[0]!))) throw new BadRequestError("If-Match must be one file hash, as the ETag a read gave");
			if (none.length > 0 && !(none.length === 1 && none[0] === "*")) throw new BadRequestError("If-None-Match must be * on a write");
			if (match.length > 0 && none.length > 0) throw new BadRequestError("Send If-Match or If-None-Match, not both");
			const current = await stat(app, p.ownerId, path);
			if (match.length === 1 && current?.sha256 !== match[0]) throw new PimError(412, "precondition_failed", "The file changed since it was read");
			if (none.length === 1 && current) throw new PimError(412, "precondition_failed", "A file is already there");
			await app.objects.put(p, { bytes: body, contentType: typeOf(baseName(path)), purpose: "file", key: keyOf(p.ownerId, path) });
			const sha = createHash("sha256").update(body).digest("hex");
			return ok({ ...entryOf(path, body.length, new Date()), sha256: sha, mtime: Date.now() }, 200, { etag: `"${sha}"`, "cache-control": "no-store, private" });
		}),
		route("DELETE", "/api/files", async ({ app, principal, url }): Promise<Reply> => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const path = filesPath(url.searchParams.get("path"));
			if (path === FILES_ROOT) throw new ConflictError("The files folder itself cannot be deleted", "root");
			const key = keyOf(p.ownerId, path);
			const keys = (await app.db.owner(p.ownerId, async (tx) => (await tx.query(
				"SELECT key FROM pim_app.objects WHERE purpose = 'file' AND deleted_at IS NULL AND (key = $1 OR left(key, length($2)) = $2)", [key, `${key}/`],
			)).rows)).map((r) => r.key as string);
			if (keys.length === 0) throw new NotFoundError("No such file or folder");
			for (const k of keys) await app.objects.delete(p, k);
			return ok({ deleted: true }, 200, { "cache-control": "no-store, private" });
		}),
	];
}
