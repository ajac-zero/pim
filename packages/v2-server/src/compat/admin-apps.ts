/**
 * The web app's `/api/artifacts*`, `/api/shared-artifacts*` and `/api/published-artifacts*`, over the application's apps (`pim_app.artifacts`,
 * `artifact_versions`, `published_artifacts`). What the web app calls an artifact V2 calls an app, and its `hosted` kind is V2's `backend`.
 * Reads go through row-level security as the caller; every write goes through the `Apps` service, so its checks stay the only ones.
 */
import type { App } from "@pim/v2-app/app";
import type { Tx } from "@pim/v2-app/db";
import { BadRequestError, ConflictError, GoneError, NotFoundError, RefusedError } from "@pim/v2-app/errors";
import { route, type Reply, type Route } from "@pim/v2-app/http";
import type { Principal } from "@pim/v2-contracts/identity";
import { framePage } from "./app-frame.ts";
import { deleted, digestOf, type Files, ms, ok, sizeOf, typeOf } from "./admin-util.ts";

const MAIN: Record<string, string[]> = { html: ["index.html"], jsx: ["App.jsx", "App.tsx"], backend: ["pim.app.json"] };
const mainOf = (kind: string, files: Files) => (MAIN[kind] ?? []).find((m) => m in files) ?? Object.keys(files).sort()[0]!;
const kindOut = (kind: string) => (kind === "backend" ? "hosted" : kind);

const sourceOf = (message: string): { source: "agent" | "person" | "restore"; restoredFrom: number | null } => {
	const restored = /^Restored version (\d+)/.exec(message);
	return restored ? { source: "restore", restoredFrom: Number(restored[1]) } : { source: message === "person" ? "person" : "agent", restoredFrom: null };
};

type Latest = { id: string; owner_id: string; title: string; kind: string; latest_version: number; created_at: Date; updated_at: Date; access: string; circles: string[]; versions: number; files: Files };
const LATEST =
	"SELECT a.id, a.owner_id, a.title, a.kind, a.latest_version, a.created_at, a.updated_at, a.access, a.circles, (SELECT count(*)::int FROM pim_app.artifact_versions c WHERE c.owner_id = a.owner_id AND c.artifact_id = a.id) AS versions, v.files FROM pim_app.artifacts a JOIN pim_app.artifact_versions v ON v.owner_id = a.owner_id AND v.artifact_id = a.id AND v.version = a.latest_version";

/** An app as its latest version (`Artifact`). */
const artifactOf = (r: Latest) => ({ id: r.id, title: r.title, kind: kindOut(r.kind), session: null, version: r.latest_version, versions: r.versions, size: sizeOf(r.files), files: Object.keys(r.files).length, sha256: digestOf(r.files), createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) });

export const readable = (app: App, p: Principal) => app.identity.authz.enforce(p, "api:read");

/** One of the caller's own apps, as its latest version. */
async function ownLatest(tx: Tx, ownerId: string, id: string): Promise<Latest> {
	const r = (await tx.query(`${LATEST} WHERE a.owner_id = $1 AND a.id = $2`, [ownerId, id])).rows[0];
	if (!r) throw new NotFoundError("No such app");
	return r;
}

const latestOf = (app: App, p: Principal, id: string) => app.db.owner(p.ownerId, (tx) => ownLatest(tx, p.ownerId, id));

async function detail(app: App, p: Principal, id: string) {
	await readable(app, p);
	return app.db.owner(p.ownerId, async (tx) => {
		const r = await ownLatest(tx, p.ownerId, id);
		const history = (await tx.query("SELECT version, files, message, created_at FROM pim_app.artifact_versions WHERE owner_id = $1 AND artifact_id = $2 ORDER BY version DESC", [p.ownerId, id])).rows;
		return { ...artifactOf(r), circles: r.circles, history: history.map((h) => ({ version: h.version as number, sha256: digestOf(h.files), size: sizeOf(h.files), ...sourceOf(h.message), createdAt: ms(h.created_at) })) };
	});
}

type Version = { version: number; files: Files; message: string; created_at: Date };

/** One version of an app, with the text of one of its files (`ArtifactVersion`). */
function versionOf(head: { id: string; title: string; kind: string; latest: number }, v: Version, path: string | undefined) {
	const chosen = path ?? mainOf(head.kind, v.files);
	if (!(chosen in v.files)) throw new NotFoundError(`Version ${v.version} has no file ${chosen}`);
	return {
		id: head.id, title: head.title, kind: kindOut(head.kind), latest: head.latest, version: v.version, sha256: digestOf(v.files), size: sizeOf(v.files), ...sourceOf(v.message), createdAt: ms(v.created_at),
		files: Object.entries(v.files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, c]) => ({ path: p, sha256: digestOf({ [p]: c }), size: Buffer.byteLength(c), type: typeOf(p) })),
		path: chosen, content: v.files[chosen]!,
	};
}

export async function ownVersion(tx: Tx, ownerId: string, id: string, version: number) {
	const head = (await tx.query("SELECT id, title, kind, latest_version FROM pim_app.artifacts WHERE owner_id = $1 AND id = $2", [ownerId, id])).rows[0];
	if (!head) throw new NotFoundError("No such app");
	const v = (await tx.query("SELECT version, files, message, created_at FROM pim_app.artifact_versions WHERE owner_id = $1 AND artifact_id = $2 AND version = $3", [ownerId, id, version])).rows[0] as Version | undefined;
	if (!v) throw new NotFoundError("No such version");
	return { head: { id: head.id as string, title: head.title as string, kind: head.kind as string, latest: head.latest_version as number }, v };
}

export const num = (s: string | undefined) => (Number.isInteger(Number(s)) ? Number(s) : Number.NaN);

function downloadReply(files: Files, path: string | undefined): Reply {
	const chosen = path ?? "";
	if (!(chosen in files)) throw new NotFoundError(`No file ${chosen}`);
	const name = chosen.split("/").pop()!.replace(/[^\w.-]/g, "_");
	return { status: 200, headers: { "content-type": `${typeOf(chosen)}; charset=utf-8`, "content-disposition": `attachment; filename="${name}"`, "x-content-type-options": "nosniff", "cache-control": "no-store" }, raw: files[chosen]! };
}

// ---- someone else's: shared with a circle you are in, or published to everyone ----

/** The latest version of an app a circle shares with the caller, by its host's username; row-level security decides whether they may see it. */
export async function sharedLatest(app: App, p: Principal, host: string, id: string) {
	await readable(app, p);
	if ((await app.identity.authz.account(p.ownerId))?.role === "guest") throw new RefusedError("Guests cannot open shared apps.", "guest");
	const owner = (await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1 AND status = 'active'", [host.toLowerCase()])).rows[0]))?.owner_id as string | undefined;
	if (!owner) throw new NotFoundError();
	const r = await app.db.owner(p.ownerId, async (tx) => (await tx.query(`${LATEST} WHERE a.owner_id = $1 AND a.id = $2`, [owner, id])).rows[0] as Latest | undefined);
	if (!r) throw new NotFoundError();
	return r;
}

const sharedOf = (host: string, r: Latest) => {
	const { session: _session, ...artifact } = artifactOf(r);
	return { ...artifact, host, address: null };
};

type Published = { public_id: string; owner_id: string; artifact_id: string; version: number; published_at: Date; uses: number; username: string; status: string; display_name: string | null };

/** The pinned copy a published app is: its row, then its author's version of it, read as the author as the published address does. */
export async function publishedCopy(app: App, publicId: string) {
	const pub = (await app.db.lookup(publicId, async (tx) => (await tx.query("SELECT p.public_id, p.owner_id, p.artifact_id, p.version, p.published_at, p.uses, a.username, a.status, pr.display_name FROM pim_app.published_artifacts p JOIN pim_app.accounts a ON a.owner_id = p.owner_id LEFT JOIN pim_app.profiles pr ON pr.owner_id = p.owner_id AND pr.published WHERE p.public_id = $1 AND p.unpublished_at IS NULL", [publicId])).rows[0])) as Published | undefined;
	if (!pub) throw new NotFoundError();
	if (pub.status === "deleting" || pub.status === "deleted") throw new GoneError("The author of this has deleted their account");
	const found = await app.db.owner(pub.owner_id, async (tx) => {
		const head = (await tx.query("SELECT title, kind FROM pim_app.artifacts WHERE owner_id = $1 AND id = $2", [pub.owner_id, pub.artifact_id])).rows[0];
		const v = (await tx.query("SELECT version, files, message, created_at FROM pim_app.artifact_versions WHERE owner_id = $1 AND artifact_id = $2 AND version = $3", [pub.owner_id, pub.artifact_id, pub.version])).rows[0] as Version | undefined;
		return head && v ? { head, v } : null;
	});
	if (!found) throw new NotFoundError();
	return { pub, title: found.head.title as string, kind: found.head.kind as string, v: found.v };
}

const publishedOf = (c: Awaited<ReturnType<typeof publishedCopy>>) => ({ id: c.pub.public_id, author: c.pub.username, authorName: c.pub.display_name, artifactId: c.pub.artifact_id, version: c.pub.version, title: c.title, kind: kindOut(c.kind), sha256: digestOf(c.v.files), size: sizeOf(c.v.files), publishedAt: ms(c.pub.published_at), uses: c.pub.uses, public: true });

export function artifactRoutes(): Route[] {
	const publication = async (app: App, p: Principal, origin: string, id: string) => {
		const row = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT public_id FROM pim_app.published_artifacts WHERE owner_id = $1 AND artifact_id = $2 AND unpublished_at IS NULL", [p.ownerId, id])).rows[0]);
		if (!row) return null;
		return { ...publishedOf(await publishedCopy(app, row.public_id)), linkable: true, link: `${origin}/p/${row.public_id}` };
	};

	return [
		// ---- your own ----
		route("GET", "/api/artifacts", async ({ app, principal }) => {
			const p = await principal();
			await readable(app, p);
			return app.db.owner(p.ownerId, async (tx) => {
				const rows = (await tx.query(`${LATEST} WHERE a.owner_id = $1 ORDER BY a.updated_at DESC`, [p.ownerId])).rows as Latest[];
				const stored = (await tx.query("SELECT files FROM pim_app.artifact_versions WHERE owner_id = $1", [p.ownerId])).rows;
				return ok({ artifacts: rows.map(artifactOf), bytes: stored.reduce((n, r) => n + sizeOf(r.files), 0) });
			});
		}),
		route("GET", "/api/artifacts/:id", async ({ app, principal, params }) => ok(await detail(app, await principal(), params[0]!))),
		route("PUT", "/api/artifacts/:id", async ({ app, principal, params, json }) => {
			const p = await principal();
			const b = await json();
			if (typeof b.title !== "string") throw new BadRequestError("title is required");
			await app.apps.update(p, params[0]!, { baseVersion: (await latestOf(app, p, params[0]!)).latest_version, title: b.title });
			return ok(artifactOf(await latestOf(app, p, params[0]!)));
		}),
		route("DELETE", "/api/artifacts/:id", async ({ app, principal, params }) => (await app.apps.remove(await principal(), params[0]!), deleted())),
		route("GET", "/api/artifacts/:id/versions/:version", async ({ app, principal, params, url }) => {
			const p = await principal();
			await readable(app, p);
			const { head, v } = await app.db.owner(p.ownerId, (tx) => ownVersion(tx, p.ownerId, params[0]!, num(params[1])));
			return ok(versionOf(head, v, url.searchParams.get("path") ?? undefined));
		}),
		route("GET", "/api/artifacts/:id/versions/:version/frame", async ({ app, principal, params, origin, url }) => {
			const p = await principal();
			await readable(app, p);
			const { head, v } = await app.db.owner(p.ownerId, (tx) => ownVersion(tx, p.ownerId, params[0]!, num(params[1])));
			return framePage(head.kind, v.files, origin, { thumbnail: url.searchParams.has("thumbnail") });
		}),
		route("GET", "/api/artifacts/:id/versions/:version/download", async ({ app, principal, params, url }) => {
			const p = await principal();
			await readable(app, p);
			const { v } = await app.db.owner(p.ownerId, (tx) => ownVersion(tx, p.ownerId, params[0]!, num(params[1])));
			return downloadReply(v.files, url.searchParams.get("path") ?? undefined);
		}),
		// A person's edit of one file, as a new version over the one they were looking at.
		route("POST", "/api/artifacts/:id/versions", async ({ app, principal, params, json }) => {
			const p = await principal();
			const b = await json();
			if (typeof b.content !== "string" || typeof b.baseVersion !== "number") throw new BadRequestError("baseVersion and content are required");
			const cur = await latestOf(app, p, params[0]!);
			const path = typeof b.path === "string" && b.path ? b.path : mainOf(cur.kind, cur.files);
			const saved = await app.apps.update(p, params[0]!, { baseVersion: b.baseVersion, files: { [path]: b.content }, message: "person" });
			return ok({ ...artifactOf(await latestOf(app, p, params[0]!)), saved: saved.version, changed: saved.changed });
		}),
		route("POST", "/api/artifacts/:id/restore", async ({ app, principal, params, json }) => {
			const p = await principal();
			const b = await json();
			const latest = (await latestOf(app, p, params[0]!)).latest_version;
			if (typeof b.baseVersion === "number" && b.baseVersion !== latest) throw new ConflictError(`The app is at version ${latest}, you changed version ${b.baseVersion}; read it again`, "version_conflict");
			await app.apps.restore(p, params[0]!, Number(b.version));
			return ok({ ...artifactOf(await latestOf(app, p, params[0]!)), restored: Number(b.version) });
		}),
		route("PUT", "/api/artifacts/:id/circles", async ({ app, principal, params, json }) => {
			const p = await principal();
			const circles = (await json()).circles;
			if (!Array.isArray(circles) || circles.some((c) => typeof c !== "string")) throw new BadRequestError("circles is a list of circle ids");
			await app.apps.setAccess(p, params[0]!, circles.length ? "circles" : "owner", circles);
			return ok(await detail(app, p, params[0]!));
		}),
		// Publishing pins a version at /p/pa_…, open to anyone with the link; there is no "everyone on this Pim but not the web" tier here.
		route("GET", "/api/artifacts/:id/publish", async ({ app, principal, params, origin }) => {
			const p = await principal();
			await readable(app, p);
			const found = await publication(app, p, origin, params[0]!);
			if (!found) throw new NotFoundError("Not published");
			return ok(found);
		}),
		route("POST", "/api/artifacts/:id/publish", async ({ app, principal, params, origin }) => {
			const p = await principal();
			await app.apps.publish(p, params[0]!);
			return ok(await publication(app, p, origin, params[0]!), 201);
		}),
		route("DELETE", "/api/artifacts/:id/publish", async ({ app, principal, params }) => (await app.apps.unpublish(await principal(), params[0]!), deleted())),

		// An app's backend runs on a personal computer, which this deployment has none of yet: it reads as an app with no computer.
		route("GET", "/api/artifacts/:id/backend", async ({ app, principal, params }) => {
			const r = await latestOf(app, await principal(), params[0]!);
			return ok({ version: null, status: null, computer: "none", access: r.access === "public" ? "public" : r.access === "shared" ? "circles" : "owner", address: null });
		}),
		route("GET", "/api/artifacts/:id/backend/logs", async ({ app, principal, params }) => (await latestOf(app, await principal(), params[0]!), ok({ text: "" }))),
		route("POST", "/api/artifacts/:id/backend/stop", async ({ app, principal, params }) => (await latestOf(app, await principal(), params[0]!), ok({ stopped: false }))),
		route("POST", "/api/artifacts/:id/backend/run", async ({ app, principal, params }) => (await latestOf(app, await principal(), params[0]!), { status: 409, body: { error: "no_computer", message: "Pair a computer to run an app's backend." } })),

		// ---- shared with you ----
		route("GET", "/api/shared-artifacts", async ({ app, principal }) => {
			const p = await principal();
			await readable(app, p);
			if ((await app.identity.authz.account(p.ownerId))?.role === "guest") return ok({ artifacts: [] });
			return app.db.owner(p.ownerId, async (tx) => {
				const rows = (await tx.query(`SELECT l.*, ac.username FROM (${LATEST} WHERE a.owner_id <> $1) l JOIN pim_app.accounts ac ON ac.owner_id = l.owner_id WHERE ac.status = 'active' ORDER BY l.updated_at DESC LIMIT 200`, [p.ownerId])).rows;
				return ok({ artifacts: rows.map((r) => sharedOf(r.username, r)) });
			});
		}),
		route("GET", "/api/shared-artifacts/:host/:id", async ({ app, principal, params }) => ok(sharedOf(params[0]!, await sharedLatest(app, await principal(), params[0]!, params[1]!)))),
		route("GET", "/api/shared-artifacts/:host/:id/versions/:version", async ({ app, principal, params, url }) => {
			const r = await sharedLatest(app, await principal(), params[0]!, params[1]!);
			if (num(params[2]) !== r.latest_version) throw new NotFoundError("No such version");
			return ok(versionOf({ id: r.id, title: r.title, kind: r.kind, latest: r.latest_version }, { version: r.latest_version, files: r.files, message: "", created_at: r.updated_at }, url.searchParams.get("path") ?? undefined));
		}),
		route("GET", "/api/shared-artifacts/:host/:id/versions/:version/frame", async ({ app, principal, params, origin, url }) => {
			const r = await sharedLatest(app, await principal(), params[0]!, params[1]!);
			if (num(params[2]) !== r.latest_version) throw new NotFoundError("No such version");
			return framePage(r.kind, r.files, origin, { thumbnail: url.searchParams.has("thumbnail") });
		}),
		route("GET", "/api/shared-artifacts/:host/:id/versions/:version/download", async ({ app, principal, params, url }) => {
			const r = await sharedLatest(app, await principal(), params[0]!, params[1]!);
			return downloadReply(r.files, url.searchParams.get("path") ?? undefined);
		}),

		// ---- published for everyone ----
		route("GET", "/api/published-artifacts", async ({ app, principal, url }) => {
			const p = await principal();
			await readable(app, p);
			const q = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const rows = await app.db.anonymous(async (tx) => (await tx.query("SELECT p.public_id FROM pim_app.published_artifacts p JOIN pim_app.accounts a ON a.owner_id = p.owner_id WHERE p.unpublished_at IS NULL AND a.status NOT IN ('deleting', 'deleted') ORDER BY p.published_at DESC LIMIT 100")).rows);
			const copies = (await Promise.all(rows.map((r) => publishedCopy(app, r.public_id).catch(() => null)))).filter((c) => c !== null);
			return ok({ artifacts: copies.filter((c) => q.every((w) => `${c.title} ${c.pub.username}`.toLowerCase().includes(w))).map(publishedOf) });
		}),
		route("GET", "/api/published-artifacts/:id", async ({ app, principal, params }) => (await readable(app, await principal()), ok(publishedOf(await publishedCopy(app, params[0]!))))),
		route("GET", "/api/published-artifacts/:id/versions/:version", async ({ app, principal, params, url }) => {
			await readable(app, await principal());
			const c = await publishedCopy(app, params[0]!);
			return ok(versionOf({ id: c.pub.public_id, title: c.title, kind: c.kind, latest: c.v.version }, c.v, url.searchParams.get("path") ?? undefined));
		}),
		route("GET", "/api/published-artifacts/:id/versions/:version/frame", async ({ app, principal, params, origin, url }) => {
			await readable(app, await principal());
			const c = await publishedCopy(app, params[0]!);
			return framePage(c.kind, c.v.files, origin, { thumbnail: url.searchParams.has("thumbnail") });
		}),
		route("GET", "/api/published-artifacts/:id/versions/:version/download", async ({ app, principal, params, url }) => {
			await readable(app, await principal());
			const c = await publishedCopy(app, params[0]!);
			return downloadReply(c.v.files, url.searchParams.get("path") ?? undefined);
		}),
		// Making a published app your own: a copy of that version, yours to change.
		route("POST", "/api/published-artifacts/:id/use", async ({ app, principal, params }) => {
			const p = await principal();
			const c = await publishedCopy(app, params[0]!);
			if (c.kind === "backend") throw new BadRequestError("An app with a backend can't be made your own");
			const made = await app.apps.create(p, { title: c.title, kind: c.kind as "html" | "jsx", files: c.v.files, message: `Made from ${c.pub.username}'s published app` });
			await app.db.lookup(c.pub.public_id, (tx) => tx.query("UPDATE pim_app.published_artifacts SET uses = uses + 1 WHERE public_id = $1", [c.pub.public_id]));
			return ok(artifactOf(await latestOf(app, p, made.id)), 201);
		}),
		// The admin takes a published app down, for everyone.
		route("DELETE", "/api/admin/published-artifacts/:id", async ({ app, principal, params }) => {
			await app.identity.authz.enforce(await principal(), "admin:content");
			const n = await app.db.lookup(params[0]!, async (tx) => (await tx.query("UPDATE pim_app.published_artifacts SET unpublished_at = now() WHERE public_id = $1 AND unpublished_at IS NULL", [params[0]!])).rowCount);
			if (!n) throw new NotFoundError();
			return deleted();
		}),
	];
}
