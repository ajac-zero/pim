import { createHash } from "node:crypto";
import type { Principal } from "@pim/v2-contracts/identity";
import { Authorizer } from "./authz.ts";
import type { Db, Tx } from "./db.ts";
import { BadRequestError, ConflictError, GoneError, NotFoundError } from "./errors.ts";
import { compileJsxApp } from "./jsx.ts";
import { newId, secret } from "./ids.ts";
import type { SignIn } from "./signin.ts";

export const MANIFEST_FILE = "pim.app.json";
export const ACCESS_LEVELS = ["owner", "circles", "public"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];
export type AppKind = "html" | "jsx" | "backend";
export type AppFiles = Record<string, string>;
export type AppRef = { id: string; title: string; kind: AppKind; version: number; sha256: string; size: number };

const MAIN: Record<AppKind, string[]> = { html: ["index.html"], jsx: ["App.jsx", "App.tsx"], backend: [MANIFEST_FILE] };
const LIMITS = { files: 100, file: 1_000_000, total: 5_000_000, readChars: 60_000 };
export const HOSTED_TOKEN_MS = 12 * 3600_000;

/** The manifest of an app with a backend, as the Worker's `parseManifest` reads it: only "backend" and "access", and a field that does nothing is refused. */
export function parseManifest(text: string): { backend: { command: string; install?: string }; access: Access } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BadRequestError(`${MANIFEST_FILE} must be JSON.`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BadRequestError(`${MANIFEST_FILE} must be a JSON object.`);
	const { backend, access, ...rest } = parsed as Record<string, unknown>;
	if (Object.keys(rest).length) throw new BadRequestError(`${MANIFEST_FILE} has no ${Object.keys(rest).map((k) => `"${k}"`).join(" or ")} yet: only "backend" and "access" are supported.`);
	if (typeof backend !== "object" || backend === null || Array.isArray(backend)) throw new BadRequestError(`${MANIFEST_FILE} needs a "backend": { "command": "…" }.`);
	const { command, install, ...other } = backend as Record<string, unknown>;
	if (Object.keys(other).length) throw new BadRequestError(`"backend" has no ${Object.keys(other).map((k) => `"${k}"`).join(" or ")} yet: only "command" and "install" are supported. Pim picks the port and gives it as $PORT.`);
	for (const [name, value] of [["command", command], ["install", install]] as const) {
		if (value === undefined && name === "install") continue;
		if (typeof value !== "string" || !value.trim() || value.length > 1000) throw new BadRequestError(`"backend".${name} must be a shell command of at most 1000 characters.`);
	}
	if (access !== undefined && !ACCESS_LEVELS.includes(access as Access)) throw new BadRequestError(`"access" is one of ${ACCESS_LEVELS.join(", ")}.`);
	return { backend: { command: command as string, ...(install !== undefined ? { install: install as string } : {}) }, access: (access as Access | undefined) ?? "owner" };
}

const digestOf = (files: AppFiles) => createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))).digest("hex");
const sizeOf = (files: AppFiles) => Object.values(files).reduce((n, c) => n + Buffer.byteLength(c), 0);

/** The label an app has at its own address: its owner's id and its own, at most 58 characters, DNS-safe. */
export const appLabel = (ownerId: string, appId: string) => `${ownerId.replace(/^o_/, "")}-${appId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 58);

function checkFiles(kind: AppKind, files: AppFiles): void {
	const names = Object.keys(files);
	if (!MAIN[kind].some((m) => names.includes(m))) throw new BadRequestError(`A ${kind} app's main file is ${MAIN[kind].join(" or ")}`);
	if (names.length > LIMITS.files + 1) throw new BadRequestError(`An app has up to ${LIMITS.files} files besides its main one`);
	for (const [path, content] of Object.entries(files)) {
		if (!/^[\w.-]+(\/[\w.-]+)*$/.test(path) || path.split("/").includes("..")) throw new BadRequestError(`"${path}" is not a plain relative path`);
		if (typeof content !== "string" || Buffer.byteLength(content) > LIMITS.file) throw new BadRequestError(`${path} must be text of at most 1 MB`);
	}
	if (sizeOf(files) > LIMITS.total) throw new BadRequestError("An app is at most 5 MB");
	if (kind === "html" && !/<[a-z!]/i.test(files["index.html"] ?? "")) throw new BadRequestError("index.html is not a page");
	if (kind === "backend") parseManifest(files[MANIFEST_FILE]!);
	// A JSX app is compiled now, so the agent that wrote it gets the error to fix.
	if (kind === "jsx") compileJsxApp(files, MAIN.jsx.find((m) => m in files)!);
}

/**
 * Apps (called artifacts in the older API paths): static `html` and `jsx` apps, and `backend` apps whose `pim.app.json` says how to run them on
 * a personal computer. Versions are append-only; every write names the version it changed, and a stale one is refused with 409 so neither the agent
 * nor the person overwrites the other. Publishing pins one version at a `/p/pa_…` address anyone may open.
 */
export class Apps {
	constructor(private readonly db: Db, private readonly signin: SignIn, private readonly opts: { hideSuspended?: boolean } = {}, private readonly authz = new Authorizer(db)) {}

	async #ref(tx: Tx, id: string, version?: number): Promise<AppRef & { files: AppFiles; message: string }> {
		const a = (await tx.query("SELECT * FROM pim_app.artifacts WHERE id = $1", [id])).rows[0];
		if (!a) throw new NotFoundError("No such app");
		const v = (await tx.query("SELECT * FROM pim_app.artifact_versions WHERE artifact_id = $1 AND version = $2", [id, version ?? a.latest_version])).rows[0];
		if (!v) throw new NotFoundError("No such version");
		return { id, title: a.title, kind: a.kind, version: v.version, sha256: digestOf(v.files), size: sizeOf(v.files), files: v.files, message: v.message };
	}

	async create(p: Principal, input: { title: string; kind: AppKind | "hosted"; files: AppFiles; message?: string }): Promise<AppRef> {
		await this.authz.enforce(p, "api:write");
		const kind: AppKind = input.kind === "hosted" ? "backend" : input.kind;
		if (!input.title?.trim() || !MAIN[kind]) throw new BadRequestError("An app needs a title and a kind (html, jsx or backend)");
		checkFiles(kind, input.files ?? {});
		const id = newId("ar");
		return this.db.owner(p.ownerId, async (tx) => {
			await tx.query("INSERT INTO pim_app.artifacts (id, owner_id, title, kind, latest_version, label, access) VALUES ($1,$2,$3,$4,1,$5,'private')", [id, p.ownerId, input.title.trim(), kind, kind === "backend" ? appLabel(p.ownerId, id) : null]);
			await tx.query("INSERT INTO pim_app.artifact_versions (artifact_id, owner_id, version, files, message, manifest) VALUES ($1,$2,1,$3,$4,$5)", [id, p.ownerId, JSON.stringify(input.files), input.message ?? "", JSON.stringify(kind === "backend" ? parseManifest(input.files[MANIFEST_FILE]!) : {})]);
			return this.#ref(tx, id);
		});
	}

	/** `app_update`: a new version over `baseVersion`. Files not mentioned stay; the same files again make no version. A refused write changes nothing, not even the title. */
	async update(p: Principal, id: string, input: { baseVersion: number; title?: string; files?: AppFiles; deleteFiles?: string[]; edits?: { path?: string; find: string; replace: string }[]; message?: string }): Promise<AppRef & { changed: boolean }> {
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => {
			const a = (await tx.query("SELECT * FROM pim_app.artifacts WHERE id = $1 FOR UPDATE", [id])).rows[0];
			if (!a) throw new NotFoundError("No such app");
			if (a.latest_version !== input.baseVersion) throw new ConflictError(`The app is at version ${a.latest_version}, you changed version ${input.baseVersion}; read it again`, "version_conflict");
			const cur = await this.#ref(tx, id);
			const files: AppFiles = { ...cur.files, ...(input.files ?? {}) };
			for (const d of input.deleteFiles ?? []) delete files[d];
			for (const e of input.edits ?? []) {
				const path = e.path ?? MAIN[a.kind as AppKind].find((m) => m in files)!;
				const text = files[path];
				if (text === undefined) throw new BadRequestError(`No file ${path}`);
				if (text.split(e.find).length !== 2) throw new BadRequestError(`"${e.find}" must match exactly once in ${path}`);
				files[path] = text.replace(e.find, () => e.replace);
			}
			checkFiles(a.kind, files);
			const title = input.title?.trim() || a.title;
			if (digestOf(files) === cur.sha256 && title === a.title) return { ...cur, changed: false };
			if (digestOf(files) === cur.sha256) {
				await tx.query("UPDATE pim_app.artifacts SET title = $2, updated_at = now() WHERE id = $1", [id, title]);
				return { ...(await this.#ref(tx, id)), changed: false };
			}
			const next = a.latest_version + 1;
			await tx.query("INSERT INTO pim_app.artifact_versions (artifact_id, owner_id, version, files, message, manifest) VALUES ($1,$2,$3,$4,$5,$6)", [id, p.ownerId, next, JSON.stringify(files), input.message ?? "", JSON.stringify(a.kind === "backend" ? parseManifest(files[MANIFEST_FILE]!) : {})]);
			await tx.query("UPDATE pim_app.artifacts SET latest_version = $2, title = $3, updated_at = now() WHERE id = $1", [id, next, title]);
			return { ...(await this.#ref(tx, id)), changed: true };
		});
	}

	/** `app_read`: one file of the latest or a given version, 60,000 characters at a time, with the list of its files. */
	async read(p: Principal, id: string, opts: { version?: number; path?: string; offset?: number } = {}) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => {
			const ref = await this.#ref(tx, id, opts.version);
			const path = opts.path ?? MAIN[ref.kind].find((m) => m in ref.files)!;
			const text = ref.files[path];
			if (text === undefined) throw new NotFoundError(`No file ${path}`);
			const offset = opts.offset ?? 0;
			return { ...refOnly(ref), path, files: Object.keys(ref.files).sort(), content: text.slice(offset, offset + LIMITS.readChars), offset, nextOffset: offset + LIMITS.readChars < text.length ? offset + LIMITS.readChars : null };
		});
	}

	async list(p: Principal, query = "") {
		await this.authz.enforce(p, "api:read");
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		return this.db.owner(p.ownerId, async (tx) => {
			const rows = (await tx.query("SELECT a.id, a.title, a.kind, a.latest_version, a.access, a.updated_at, v.files FROM pim_app.artifacts a JOIN pim_app.artifact_versions v ON v.artifact_id = a.id AND v.version = a.latest_version ORDER BY a.updated_at DESC")).rows;
			return rows.filter((r) => words.every((w) => r.title.toLowerCase().includes(w))).map((r) => ({ id: r.id as string, title: r.title as string, kind: r.kind as AppKind, version: r.latest_version as number, size: sizeOf(r.files), files: Object.keys(r.files).length, access: r.access as string, updatedAt: r.updated_at as Date }));
		});
	}

	async versions(p: Principal, id: string) {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => {
			await this.#ref(tx, id);
			return (await tx.query("SELECT version, files, message, created_at FROM pim_app.artifact_versions WHERE artifact_id = $1 ORDER BY version", [id])).rows.map((r) => ({ version: r.version as number, sha256: digestOf(r.files), size: sizeOf(r.files), message: r.message as string, createdAt: r.created_at as Date }));
		});
	}

	/** Restoring adds a new version with the old content, so history only grows. */
	async restore(p: Principal, id: string, version: number): Promise<AppRef & { changed: boolean }> {
		await this.authz.enforce(p, "api:write");
		const [old, latest] = await this.db.owner(p.ownerId, async (tx) => [await this.#ref(tx, id, version), await this.#ref(tx, id)] as const);
		return this.update(p, id, { baseVersion: latest.version, files: old.files, deleteFiles: Object.keys(latest.files).filter((f) => !(f in old.files)), message: `Restored version ${version}` });
	}

	async remove(p: Principal, id: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			await this.#ref(tx, id);
			await tx.query("DELETE FROM pim_app.published_artifacts WHERE artifact_id = $1", [id]);
			await tx.query("DELETE FROM pim_app.artifact_versions WHERE artifact_id = $1", [id]);
			await tx.query("DELETE FROM pim_app.artifacts WHERE id = $1", [id]);
		});
	}

	/** Who may open it at its own address: `owner`, `circles` (the circles it is shared with) or `public`. */
	async setAccess(p: Principal, id: string, access: Access, circles: string[] = []): Promise<void> {
		await this.authz.enforce(p, "api:write");
		if (!ACCESS_LEVELS.includes(access)) throw new BadRequestError(`access is one of ${ACCESS_LEVELS.join(", ")}`);
		await this.db.owner(p.ownerId, async (tx) => {
			await this.#ref(tx, id);
			const known = new Set((await tx.query("SELECT id FROM pim_app.circles WHERE id = ANY($1)", [circles])).rows.map((r) => r.id));
			if (circles.some((c) => !known.has(c))) throw new BadRequestError("circles must be your own circles");
			await tx.query("UPDATE pim_app.artifacts SET access = $2, circles = $3, updated_at = now() WHERE id = $1", [id, access === "owner" ? "private" : access === "circles" ? "shared" : "public", access === "circles" ? circles : []]);
		});
	}

	// ---- publishing ----

	/** Pins a version at `/p/pa_…`. An app with a backend runs its owner's program, so it cannot be published. */
	async publish(p: Principal, id: string, version?: number): Promise<{ publicId: string; version: number }> {
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => {
			const ref = await this.#ref(tx, id, version);
			if (ref.kind === "backend") throw new BadRequestError("An app with a backend can't be published");
			await tx.query("UPDATE pim_app.published_artifacts SET unpublished_at = now() WHERE artifact_id = $1 AND unpublished_at IS NULL", [id]);
			const publicId = `pa_${secret(12)}`;
			await tx.query("INSERT INTO pim_app.published_artifacts (public_id, owner_id, artifact_id, version) VALUES ($1,$2,$3,$4)", [publicId, p.ownerId, id, ref.version]);
			return { publicId, version: ref.version };
		});
	}

	async unpublish(p: Principal, id: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.published_artifacts SET unpublished_at = now() WHERE artifact_id = $1 AND unpublished_at IS NULL", [id]));
	}

	/**
	 * `/p/pa_…`: the pinned version for anyone with the address. A deleted author's is gone (410); a suspended author's stays up unless the instance hides it.
	 * A page is served with a policy that lets it run its own script and style and reach nothing else.
	 */
	async servePublished(publicId: string, file?: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
		const pub = await this.db.lookup(publicId, async (tx) => (await tx.query("SELECT owner_id, artifact_id, version FROM pim_app.published_artifacts WHERE public_id = $1 AND unpublished_at IS NULL", [publicId])).rows[0]);
		if (!pub) throw new NotFoundError();
		const author = await this.authz.account(pub.owner_id);
		if (!author || author.status === "deleting" || author.status === "deleted") throw new GoneError("The author of this has deleted their account");
		if (author.status === "suspended" && this.opts.hideSuspended) throw new NotFoundError();
		const ref = await this.db.owner(pub.owner_id, (tx) => this.#ref(tx, pub.artifact_id, pub.version));
		return frame(ref, file);
	}

	// ---- hosted (backend) apps ----

	/** Opens an app with a backend for its owner: a token good for twelve hours that opens that app and nothing else, at `/hosted/<owner>/<id>/<token>/`. */
	async openHosted(p: Principal, id: string, now = new Date()): Promise<{ path: string; expiresAt: Date }> {
		await this.authz.enforce(p, "api:read");
		const kind = await this.db.owner(p.ownerId, async (tx) => (await this.#ref(tx, id)).kind);
		if (kind !== "backend") throw new BadRequestError("Only an app with a backend is opened this way");
		const token = await this.signin.startFlow("hosted", { owner: p.ownerId, app: id }, HOSTED_TOKEN_MS, now);
		return { path: `/hosted/${p.ownerId}/${id}/${token}/`, expiresAt: new Date(now.getTime() + HOSTED_TOKEN_MS) };
	}

	/** Checks a hosted token and the owner's account: a suspended owner's app does not run (403), a deleted one's is gone (410). */
	async authorizeHosted(ownerId: string, id: string, token: string, now = new Date()): Promise<{ manifest: { backend: { command: string }; access: Access } }> {
		const flow = await this.signin.flow<{ owner: string; app: string }>(token, "hosted", { now });
		if (!flow || flow.owner !== ownerId || flow.app !== id) throw new NotFoundError();
		return this.#runnable(ownerId, id);
	}

	async #runnable(ownerId: string, id: string) {
		await this.authz.requireLive(ownerId, "hosted:run");
		return this.db.owner(ownerId, async (tx) => {
			const ref = await this.#ref(tx, id);
			if (ref.kind !== "backend") throw new NotFoundError();
			return { manifest: parseManifest(ref.files[MANIFEST_FILE]!) };
		});
	}

	/** An app by its own label (`<label>.<apps-origin>`): who owns it and how it is shared. */
	async byLabel(label: string) {
		return this.db.lookup(label, async (tx) => {
			const a = (await tx.query("SELECT id, owner_id, access, circles FROM pim_app.artifacts WHERE label = $1", [label])).rows[0];
			return a ? { id: a.id as string, ownerId: a.owner_id as string, access: a.access as string, circles: a.circles as string[] } : null;
		});
	}

	/**
	 * Whether `visitor` (an owner id, or null for no one) may open the app at its own address. `public` is anyone; `circles` is the owner and the
	 * people in the circles it is shared with, signed in and not guests; otherwise only the owner. Taking someone out of a circle stops them at their next request.
	 */
	async mayOpen(app: { id: string; ownerId: string; access: string; circles: string[] }, visitor: string | null): Promise<boolean> {
		await this.authz.requireLive(app.ownerId, "hosted:run");
		if (app.access === "public") return true;
		if (!visitor) return false;
		if (visitor === app.ownerId) return true;
		if (app.access !== "shared") return false;
		const v = await this.authz.requireLive(visitor, "hosted:open").catch(() => null);
		if (!v || v.role === "guest") return false;
		return this.db.owner(app.ownerId, async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.circles WHERE id = ANY($1) AND $2 = ANY(members)", [app.circles, visitor])).rowCount);
	}

	/** `/hosted/enter`: a signed-in person asks to open an app at its own address; answers with a one-minute code the app's address trades for its cookie. */
	async enter(p: Principal, label: string, now = new Date()): Promise<string> {
		const app = await this.byLabel(label);
		if (!app || !(await this.mayOpen(app, p.ownerId))) throw new NotFoundError();
		return this.signin.startFlow("hosted_enter", { label, visitor: p.ownerId }, 60_000, now);
	}

	/** At the app's own address: trades the code for a cookie value good for twelve hours. */
	async exchangeEnter(label: string, code: string, now = new Date()): Promise<string> {
		const flow = await this.signin.flow<{ label: string; visitor: string }>(code, "hosted_enter", { consume: true, now });
		if (!flow || flow.label !== label) throw new NotFoundError();
		return this.signin.startFlow("hosted", { label, visitor: flow.visitor }, HOSTED_TOKEN_MS, now);
	}

	/** The visitor a cookie value at an app's own address names, if it is still good. */
	async cookieVisitor(label: string, value: string | undefined, now = new Date()): Promise<string | null> {
		const flow = await this.signin.flow<{ label?: string; visitor?: string }>(value, "hosted", { now });
		return flow?.label === label && flow.visitor ? flow.visitor : null;
	}
}

const refOnly = ({ id, title, kind, version, sha256, size }: AppRef): AppRef => ({ id, title, kind, version, sha256, size });

const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'; sandbox allow-scripts";

function frame(ref: AppRef & { files: AppFiles }, file?: string) {
	const headers = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
	if (ref.kind === "html") {
		const path = file ?? "index.html";
		const body = ref.files[path];
		if (body === undefined) throw new NotFoundError();
		const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".json") ? "application/json" : "text/html";
		return { status: 200, headers: { ...headers, "content-type": `${type}; charset=utf-8` }, body };
	}
	// A JSX app is compiled where it is shown; the server gives its source.
	return { status: 200, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ kind: ref.kind, version: ref.version, files: ref.files }) };
}
