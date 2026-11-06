import { Buffer } from "node:buffer";
import { type Access, MANIFEST_FILE, parseManifest } from "./app-manifest";
import type { ArtifactStore } from "./artifacts";
import type { Computer } from "./computer";
import { HttpError } from "./http";

/**
 * Apps with a backend (the `hosted` kind of app). A version of one is the
 * files its manifest (`pim.app.json`, see ./app-manifest.ts) sits beside,
 * kept like any app's. Running a version copies its files to a folder of its
 * own on the person's computer, the release, and has `pim-computer` run its
 * backend from there: the release is never changed, so rolling back is
 * running an earlier one. What the backend keeps lives in a folder beside the
 * releases that no release replaces.
 *
 * Nothing reaches the backend directly. Its page is framed in the app like
 * any app's, but loads from `/hosted/<owner>/<id>/<token>/`, where the Worker
 * hands each request to this space, which checks the token and relays the
 * request to the computer over its connection (`app_http`), so the computer
 * needs no open port. The token is minted when the person opens the app and
 * lives in the address, because the page runs in an opaque origin, as every
 * app's does, and sends no cookies: it names the app and nothing else, so what
 * the page can do is reach its own backend, never Pim's API.
 *
 * Where the deployment has an apps origin (`PIM_APPS_ORIGIN`), an app also
 * has an origin of its own, `https://<label>.<apps origin's host>/`, where
 * its page is at the root, with cookies and storage of its own. Who may open
 * it there is the manifest's `access`: the owner; the people in the circles it
 * is shared with; or anyone. A visitor signs in to Pim first, which Pim's own
 * address does (`/hosted/enter`, in the gateway): the space then makes a
 * token for the app's address, which trades it for a cookie there, and the
 * space checks the cookie, and that its person may still open the app, on
 * every request. The backend is told who is asking in signed headers (see
 * `identity`).
 *
 * Responses are relayed whole, so there are no WebSockets or streaming, and an
 * app framed at its owner's address must use relative addresses, since it
 * isn't at the root of an origin there.
 */

/** Where the computer keeps an app's releases and data, under the person's files. */
const APPS_ROOT = "/workspace/.pim/apps";
/** The ports Pim gives backends, one each. */
const PORT_FROM = 18_000;
const PORT_TO = 18_999;
/** How long an address with a token opens the app. */
export const TOKEN_MS = 12 * 60 * 60 * 1000;
const KEY = "hosted_key";
/** The cookie that says who a visitor of an app's own address is; the app never sees it. */
export const SESSION_COOKIE = "__pim_app";
/** How long a token to enter an app lives, and how long what it is traded for does. */
const ENTER_MS = 60_000;
const SESSION_MS = 12 * 60 * 60 * 1000;
/** The most a request's body may be, and how long the backend may take to answer. */
const MAX_REQUEST_BYTES = 1_048_576;
const HTTP_CALL_MS = 65_000;
/** What starting may take: its install step may be five minutes, and it then waits for the backend to listen. */
const START_CALL_MS = 6 * 60_000 + 40_000;

/** What a folder's files leave out: what a release installs, and what a repository keeps. */
const EXCLUDED = ["**/node_modules", "**/.git"];

type Meta = { meta(key: string): string | undefined; setMeta(key: string, value: string): void };

export type BackendState = "starting" | "running" | "crashed" | "failed" | "stopped";
export type BackendStatus = { readonly state: BackendState; readonly restarts: number; readonly since: number | null };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_hosted_apps (
	artifact TEXT PRIMARY KEY,
	port INTEGER NOT NULL UNIQUE,
	version INTEGER NOT NULL,
	access TEXT NOT NULL DEFAULT 'owner'
);
`;

/** Whoever asks to open an app: a person on this Pim, by their owner id. */
export type Visitor = { readonly id: string; readonly name: string };

/** The subdomain an app is at: its owner's id and its own, with nothing to separate them, which fit in a DNS label. */
export const appLabel = (owner: string, id: string) => `${owner.slice(2)}${id.replaceAll("-", "")}`;

/** The address of an app's own origin under the deployment's apps origin, with a trailing slash. */
export function appAddress(appsOrigin: string, owner: string, id: string): string {
	const url = new URL(appsOrigin);
	return `${url.protocol}//${appLabel(owner, id)}.${url.host}/`;
}

/** The same for a subdomain's label alone. */
export function appOfLabel(label: string): { owner: string; id: string } | null {
	const found = /^([0-9a-z]{26})([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(label.toLowerCase());
	return found ? { owner: `o_${found[1]}`, id: found.slice(2).join("-") } : null;
}

/** Whose app a host is, when it is a subdomain of the apps origin that names one. */
export function appOfHost(appsOrigin: string, host: string): { owner: string; id: string } | null {
	const base = new URL(appsOrigin).host;
	const lower = host.toLowerCase();
	return lower.endsWith(`.${base}`) ? appOfLabel(lower.slice(0, -base.length - 1)) : null;
}

/** Whether two strings are the same, compared without stopping at the first difference: a signature is what a stranger would guess at. */
function same(expected: string, given: string): boolean {
	if (expected.length !== given.length) return false;
	let different = 0;
	for (let index = 0; index < expected.length; index++) different |= expected.charCodeAt(index) ^ given.charCodeAt(index);
	return different === 0;
}

const base64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

export class HostedApps {
	readonly #sql: SqlStorage;
	readonly #computer: Computer;
	readonly #artifacts: ArtifactStore;
	readonly #meta: Meta;
	readonly #appsOrigin: () => string | null;

	constructor(sql: SqlStorage, options: { computer: Computer; artifacts: ArtifactStore; meta: Meta; appsOrigin: () => string | null }) {
		this.#sql = sql;
		this.#computer = options.computer;
		this.#artifacts = options.artifacts;
		this.#meta = options.meta;
		this.#appsOrigin = options.appsOrigin;
		this.#sql.exec(SCHEMA);
		// Apps run before they had a say in who opens them are for their owner alone.
		const columns = this.#sql.exec("PRAGMA table_info(pim_hosted_apps)").toArray().map((row) => String(row.name));
		if (!columns.includes("access")) this.#sql.exec("ALTER TABLE pim_hosted_apps ADD COLUMN access TEXT NOT NULL DEFAULT 'owner'");
	}

	/** Who may open the app at its own address, as the version run last says. */
	access(id: string): Access {
		const [row] = this.#sql.exec("SELECT access FROM pim_hosted_apps WHERE artifact = ?", id).toArray();
		return (row?.access as Access | undefined) ?? "owner";
	}

	/** The address of the app's own origin, or null where the deployment has none. */
	origin(owner: string, id: string): string | null {
		const apps = this.#appsOrigin();
		return apps === null ? null : appAddress(apps, owner, id);
	}

	/** The version whose backend was run last, or undefined for an app never run. */
	version(id: string): number | undefined {
		const [row] = this.#sql.exec("SELECT version FROM pim_hosted_apps WHERE artifact = ?", id).toArray();
		return row ? Number(row.version) : undefined;
	}

	/** The port Pim gives the app's backend, the same for as long as the app exists. */
	#port(id: string): number {
		const [known] = this.#sql.exec("SELECT port FROM pim_hosted_apps WHERE artifact = ?", id).toArray();
		if (known) return Number(known.port);
		const used = new Set(this.#sql.exec("SELECT port FROM pim_hosted_apps").toArray().map((row) => Number(row.port)));
		for (let port = PORT_FROM; port <= PORT_TO; port++) if (!used.has(port)) return port;
		throw new HttpError(429, "This space runs as many backends as it has ports for. Delete one first.");
	}

	/** Where a version's files are on the computer, as the computer's file calls name it. */
	static releasePath(id: string, version: number): string {
		return `${APPS_ROOT}/${id}/v${version}`;
	}

	/** Copies a version's files to its release folder, unless it's there already. */
	async #release(id: string, version: number): Promise<string> {
		const release = HostedApps.releasePath(id, version);
		const exists = await this.#computer.fs.stat(release).then(
			(stat) => stat.isDirectory,
			() => false,
		);
		if (exists) return release;
		const files = await this.#artifacts.read(id, version);
		// Written beside the release and moved into place, so a release is whole or isn't there.
		const draft = `${release}.${crypto.randomUUID().slice(0, 8)}`;
		try {
			await this.#computer.fs.mkdir(draft, { recursive: true });
			for (const [path, file] of files) {
				const slash = path.lastIndexOf("/");
				if (slash > 0) await this.#computer.fs.mkdir(`${draft}/${path.slice(0, slash)}`, { recursive: true });
				await this.#computer.fs.writeFile(`${draft}/${path}`, file.bytes);
			}
			await this.#computer.call("rename", { from: draft, to: release });
		} catch (error) {
			await this.#computer.fs.rm(draft, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
		return release;
	}

	/**
	 * Runs a version: its release is put on the computer, its backend started
	 * there in place of any running one, and it is the version the app's
	 * address opens from now on. Fails with what the backend said when it
	 * doesn't come up.
	 */
	async run(id: string, version: number): Promise<void> {
		const found = this.#artifacts.get(id);
		if (!found || found.kind !== "hosted") throw new HttpError(404, `No app with a backend ${id}`);
		const files = await this.#artifacts.read(id, version);
		const main = files.get(MANIFEST_FILE);
		if (!main) throw new HttpError(404, `No version ${version} of app ${id}`);
		const { backend, access } = parseManifest(new TextDecoder().decode(main.bytes));
		if (access !== "owner" && this.#appsOrigin() === null) {
			throw new HttpError(400, `"access": "${access}" needs an address of the app's own, which this Pim doesn't have: its admin sets PIM_APPS_ORIGIN. Only "owner" works here.`);
		}
		const port = this.#port(id);
		const dir = await this.#release(id, version);
		await this.#computer.call(
			"app_start",
			{
				id,
				dir,
				command: backend.command,
				...(backend.install ? { install: backend.install } : {}),
				port,
				data: `${APPS_ROOT}/${id}/data`,
				env: { PIM_APP_SECRET: await this.secret(id) },
			},
			START_CALL_MS,
		);
		this.#sql.exec(
			"INSERT INTO pim_hosted_apps (artifact, port, version, access) VALUES (?, ?, ?, ?) ON CONFLICT (artifact) DO UPDATE SET version = excluded.version, access = excluded.access",
			id,
			port,
			version,
			access,
		);
	}

	/** Stops the backend; the app keeps its versions and its data, and runs again when told to. */
	async stop(id: string): Promise<void> {
		await this.#computer.call("app_stop", { id });
	}

	/** What the computer says of the backend, or null while it can't say (offline, or never run). */
	async status(id: string): Promise<BackendStatus | null> {
		if (this.version(id) === undefined) return null;
		try {
			const { apps } = await this.#computer.call<{ apps: { id: string; state: BackendState; restarts: number; since: number }[] }>("app_status", { id });
			const mine = apps.find((app) => app.id === id);
			return mine ? { state: mine.state, restarts: mine.restarts, since: mine.since } : { state: "stopped", restarts: 0, since: null };
		} catch {
			return null;
		}
	}

	/** The end of what the backend printed. */
	async logs(id: string, bytes?: number): Promise<string> {
		return (await this.#computer.call<{ text: string }>("app_logs", { id, ...(bytes ? { bytes } : {}) })).text;
	}

	/** The app is gone: its port is free, and its backend stops, as far as the computer is there to hear it. */
	async forget(id: string): Promise<void> {
		if (this.version(id) === undefined) return;
		this.#sql.exec("DELETE FROM pim_hosted_apps WHERE artifact = ?", id);
		await this.stop(id).catch(() => undefined);
	}

	/** The key tokens are signed with, made the first time one is wanted. */
	#key(): string {
		let key = this.#meta.meta(KEY);
		if (key === undefined) {
			key = base64url(crypto.getRandomValues(new Uint8Array(32)));
			this.#meta.setMeta(KEY, key);
		}
		return key;
	}

	async #sign(payload: string, key = this.#key()): Promise<string> {
		const imported = await crypto.subtle.importKey("raw", Buffer.from(key, "base64url"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		return base64url(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(payload)));
	}

	/** Claims signed with the space's key, to be read back by it: nobody else can make or change one. */
	async #seal(claims: Record<string, unknown>): Promise<string> {
		const body = base64url(new TextEncoder().encode(JSON.stringify(claims)));
		return `${body}.${await this.#sign(body)}`;
	}

	async #open(token: string): Promise<Record<string, unknown> | null> {
		const [body, signature] = token.split(".");
		if (!body || !signature || !same(await this.#sign(body), signature)) return null;
		try {
			return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	/** What a visitor of the app's own address is told to enter with: good for a minute, for that app and that person. */
	enterToken(id: string, visitor: Visitor, now = Date.now()): Promise<string> {
		return this.#seal({ k: "enter", a: id, u: visitor.id, n: visitor.name, e: now + ENTER_MS });
	}

	/** Trades an entry token for the cookie the app's address keeps, or null for one that isn't good. */
	async session(id: string, enter: string, now = Date.now()): Promise<{ cookie: string; maxAge: number } | null> {
		const claims = await this.#open(enter);
		if (!claims || claims.k !== "enter" || claims.a !== id || typeof claims.u !== "string" || typeof claims.n !== "string" || Number(claims.e) < now) return null;
		return { cookie: await this.#seal({ k: "session", a: id, u: claims.u, n: claims.n, e: now + SESSION_MS }), maxAge: SESSION_MS / 1000 };
	}

	/** Who the app's cookie says is asking, if it is good: whether they may still open the app is for the space to say. */
	async visitor(id: string, cookie: string, now = Date.now()): Promise<Visitor | null> {
		const claims = await this.#open(cookie);
		if (!claims || claims.k !== "session" || claims.a !== id || typeof claims.u !== "string" || typeof claims.n !== "string" || Number(claims.e) < now) return null;
		return { id: claims.u, name: claims.n };
	}

	/**
	 * What the app's backend checks the headers that say who is asking against
	 * (`PIM_APP_SECRET`): its own, made from the space's key, so no other app's
	 * backend can pass itself off as Pim to it.
	 */
	secret(id: string): Promise<string> {
		return this.#sign(`app-secret:${id}`);
	}

	/** Who is asking, signed: `x-pim-signature` is the base64url HMAC-SHA256, keyed by `PIM_APP_SECRET`, of `<user id>.<time>`. */
	async #identity(id: string, visitor: Visitor, now: number): Promise<[string, string][]> {
		const time = String(now);
		return [
			["x-pim-user", visitor.name],
			["x-pim-user-id", visitor.id],
			["x-pim-time", time],
			["x-pim-signature", await this.#sign(`${visitor.id}.${time}`, await this.secret(id))],
		];
	}

	/** The path of the app's page, with a token that opens it for a while. */
	async address(owner: string, id: string, now = Date.now()): Promise<string> {
		const expires = Math.floor((now + TOKEN_MS) / 1000);
		const token = `${expires.toString(36)}.${await this.#sign(`${id}.${expires}`)}`;
		return `/hosted/${owner}/${id}/${token}/`;
	}

	/** Whether a token opens the app now. */
	async allows(id: string, token: string, now = Date.now()): Promise<boolean> {
		const [expires, signature] = token.split(".");
		if (!expires || !signature || !/^[0-9a-z]{1,10}$/.test(expires)) return false;
		const seconds = Number.parseInt(expires, 36);
		if (seconds * 1000 < now) return false;
		return same(await this.#sign(`${id}.${seconds}`), signature);
	}

	/**
	 * Relays one request to the backend. `path` is what follows the address,
	 * with its query. Framed at its owner's address (`prefix`, the address up to
	 * the path, for the backend to build links), the backend gets only what a
	 * page's request needs, none of Pim's cookies or credentials, though the
	 * page's first load carries them, and Pim's rules (see `ruled`) apply to
	 * what it serves. At its own origin (`own`) it is a site of its own: it gets
	 * its own cookies and headers, and the signed headers that say who is
	 * asking, and serves what it likes, but for the cookie that is Pim's.
	 */
	async relay(
		request: Request,
		id: string,
		path: string,
		how: { prefix: string } | { own: { host: string; proto: string; visitor: Visitor | null } },
	): Promise<Response> {
		const own = "own" in how ? how.own : null;
		if (request.headers.get("upgrade")) return plain(501, "WebSockets aren't relayed to an app's backend yet.");
		if (!own && request.method === "OPTIONS") return ruled(new Response(null, { status: 204 }), true);
		const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
		if (body && body.byteLength > MAX_REQUEST_BYTES) return plain(413, `A request to an app's backend is at most ${MAX_REQUEST_BYTES} bytes.`);
		const headers: [string, string][] = [];
		for (const name of own ? [...FORWARDED, "authorization", "origin", "referer"] : FORWARDED) {
			const value = request.headers.get(name);
			if (value !== null) headers.push([name, value]);
		}
		headers.push(["accept-encoding", "identity"]);
		if (own) {
			// Its own cookies, not the one that says who the visitor is: the backend gets that as signed headers instead.
			const cookies = (request.headers.get("cookie") ?? "")
				.split(";")
				.map((cookie) => cookie.trim())
				.filter((cookie) => cookie !== "" && !cookie.startsWith(`${SESSION_COOKIE}=`));
			if (cookies.length > 0) headers.push(["cookie", cookies.join("; ")]);
			headers.push(["x-forwarded-host", own.host], ["x-forwarded-proto", own.proto]);
			if (own.visitor) headers.push(...(await this.#identity(id, own.visitor, Date.now())));
		} else headers.push(["x-forwarded-prefix", (how as { prefix: string }).prefix.replace(/\/$/, "")]);
		let answer: { status: number; headers: [string, string][]; body: string };
		try {
			answer = await this.#computer.call(
				"app_http",
				{ id, method: request.method, path, headers, ...(body?.byteLength ? { body: Buffer.from(body).toString("base64") } : {}) },
				HTTP_CALL_MS,
			);
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			const message = error instanceof Error ? error.message : String(error);
			if (code === "ENOTRUNNING" || code === "ECONNREFUSED") return plain(503, `This app's backend isn't running. ${code === "ENOTRUNNING" ? message : "It isn't answering."}`);
			return plain(error instanceof HttpError ? error.status : 502, message);
		}
		if (answer.status < 200 || answer.status > 599) return plain(502, "The backend answered with a status Pim can't pass on.");
		const out = new Headers();
		for (const [name, value] of answer.headers) {
			const lower = name.toLowerCase();
			if (own) {
				if (ALWAYS_DROPPED.has(lower)) continue;
				// A cookie belongs to the app's own address alone: not to a parent domain, where it would reach other apps and Pim, and not the one Pim keeps there.
				if (lower === "set-cookie") {
					if (value.trimStart().toLowerCase().startsWith(`${SESSION_COOKIE}=`)) continue;
					out.append(name, value.replace(/;\s*domain=[^;]*/gi, ""));
				} else out.append(name, value);
				continue;
			}
			if (DROPPED.has(lower)) continue;
			// A redirect to a path on its own origin stays in the app's address.
			const prefix = (how as { prefix: string }).prefix;
			out.append(name, lower === "location" && value.startsWith("/") && !value.startsWith("//") ? `${prefix.replace(/\/$/, "")}${value}` : value);
		}
		const bytes = answer.status === 204 || answer.status === 304 ? null : Buffer.from(answer.body, "base64");
		const response = new Response(bytes, { status: answer.status, headers: out });
		return own ? response : ruled(response, true);
	}
}

/** The headers of a page's request a backend gets; Pim's own cookies and credentials never go. */
const FORWARDED = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range", "user-agent", "x-requested-with"];

/** What no backend's response sets, wherever it is served: what describes how Pim relayed the body, and what would bind the host's other sites. */
const ALWAYS_DROPPED = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive", "strict-transport-security", "clear-site-data"]);

/** What a backend's response may not set when its page is framed at Pim's own address: cookies would land there, and the page's rules are Pim's. */
const DROPPED = new Set([
	...ALWAYS_DROPPED,
	"set-cookie",
	"set-cookie2",
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options",
	"access-control-allow-origin",
	"access-control-allow-credentials",
	"cross-origin-resource-policy",
]);

function plain(status: number, message: string): Response {
	return ruled(new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } }), false);
}

/**
 * Pim's rules for what a backend serves, which the backend can't loosen: the
 * page is sandboxed with no origin of its own and may load and call only the
 * address it came from, so it can use its backend and nothing else of Pim's.
 * The address has the token in it, so anyone who has it may call it: its
 * answers allow any origin, with no credentials.
 */
function ruled(response: Response, cors: boolean): Response {
	const headers = new Headers(response.headers);
	headers.set(
		"content-security-policy",
		[
			"sandbox allow-scripts allow-forms",
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob:",
			"font-src 'self' data:",
			"media-src 'self' data: blob:",
			"connect-src 'self'",
			"form-action 'self'",
			"frame-ancestors 'self'",
		].join("; "),
	);
	headers.set("cache-control", "no-store, private");
	headers.set("x-content-type-options", "nosniff");
	headers.set("referrer-policy", "no-referrer");
	headers.set("cross-origin-resource-policy", "cross-origin");
	headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=(), publickey-credentials-get=(), publickey-credentials-create=()");
	if (cors) {
		headers.set("access-control-allow-origin", "*");
		headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE");
		headers.set("access-control-allow-headers", "content-type, x-requested-with, range, if-none-match");
	}
	return new Response(response.body, { status: response.status, headers });
}

/**
 * The files of a folder on the computer, as an app's version holds them:
 * paths relative to the folder, without what a release installs or a
 * repository keeps. Refused past `limit` files, with what to do.
 */
export async function readFolder(computer: Computer, folder: string, limit: number): Promise<Map<string, Uint8Array>> {
	const found = await computer.fs.find(folder, "**", { limit: limit + 1, exclude: EXCLUDED });
	const paths = found.filter((entry) => entry.type === "file").map((entry) => entry.path);
	if (paths.length > limit) {
		throw new HttpError(400, `${folder} has more than ${limit} files, the most an app holds. Leave out what's built or installed there: a release installs its own, with "backend".install.`);
	}
	const files = new Map<string, Uint8Array>();
	const prefix = `${folder.replace(/\/$/, "")}/`;
	for (const path of paths) {
		if (!path.startsWith(prefix)) continue;
		const chunks: Uint8Array[] = [];
		const reader = (await computer.fs.readFile(path)).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		files.set(path.slice(prefix.length), Buffer.concat(chunks));
	}
	return files;
}
