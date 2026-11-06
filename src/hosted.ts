import { Buffer } from "node:buffer";
import { MANIFEST_FILE, parseManifest } from "./app-manifest";
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
 * Only the owner opens one so far. Responses are relayed whole, so there are
 * no WebSockets or streaming, and the page must use relative addresses,
 * since it isn't at the root of its own origin.
 */

/** Where the computer keeps an app's releases and data, under the person's files. */
const APPS_ROOT = "/workspace/.pim/apps";
/** The ports Pim gives backends, one each. */
const PORT_FROM = 18_000;
const PORT_TO = 18_999;
/** How long an address with a token opens the app. */
export const TOKEN_MS = 12 * 60 * 60 * 1000;
const KEY = "hosted_key";
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
	version INTEGER NOT NULL
);
`;

const base64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

export class HostedApps {
	readonly #sql: SqlStorage;
	readonly #computer: Computer;
	readonly #artifacts: ArtifactStore;
	readonly #meta: Meta;

	constructor(sql: SqlStorage, options: { computer: Computer; artifacts: ArtifactStore; meta: Meta }) {
		this.#sql = sql;
		this.#computer = options.computer;
		this.#artifacts = options.artifacts;
		this.#meta = options.meta;
		this.#sql.exec(SCHEMA);
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
		const { backend } = parseManifest(new TextDecoder().decode(main.bytes));
		const port = this.#port(id);
		const dir = await this.#release(id, version);
		await this.#computer.call(
			"app_start",
			{ id, dir, command: backend.command, ...(backend.install ? { install: backend.install } : {}), port, data: `${APPS_ROOT}/${id}/data` },
			START_CALL_MS,
		);
		this.#sql.exec("INSERT INTO pim_hosted_apps (artifact, port, version) VALUES (?, ?, ?) ON CONFLICT (artifact) DO UPDATE SET version = excluded.version", id, port, version);
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

	async #sign(payload: string): Promise<string> {
		const key = await crypto.subtle.importKey("raw", Buffer.from(this.#key(), "base64url"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
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
		const expected = await this.#sign(`${id}.${seconds}`);
		// Compared without stopping at the first difference: the signature is the one thing a stranger would guess at.
		if (expected.length !== signature.length) return false;
		let different = 0;
		for (let index = 0; index < expected.length; index++) different |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
		return different === 0;
	}

	/**
	 * Relays one request to the backend, which gets only what a page's own
	 * request needs: none of Pim's cookies or credentials, though the page's
	 * first load carries them. `path` is what follows the token, with its
	 * query; `prefix` is the address up to it, for the backend to build links.
	 */
	async relay(request: Request, id: string, path: string, prefix: string): Promise<Response> {
		if (request.headers.get("upgrade")) return plain(501, "WebSockets aren't relayed to an app's backend yet.");
		if (request.method === "OPTIONS") return ruled(new Response(null, { status: 204 }), true);
		const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
		if (body && body.byteLength > MAX_REQUEST_BYTES) return plain(413, `A request to an app's backend is at most ${MAX_REQUEST_BYTES} bytes.`);
		const headers: [string, string][] = [];
		for (const name of FORWARDED) {
			const value = request.headers.get(name);
			if (value !== null) headers.push([name, value]);
		}
		headers.push(["accept-encoding", "identity"], ["x-forwarded-prefix", prefix.replace(/\/$/, "")]);
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
			if (DROPPED.has(lower)) continue;
			// A redirect to a path on its own origin stays in the app's address.
			out.append(name, lower === "location" && value.startsWith("/") && !value.startsWith("//") ? `${prefix.replace(/\/$/, "")}${value}` : value);
		}
		const bytes = answer.status === 204 || answer.status === 304 ? null : Buffer.from(answer.body, "base64");
		return ruled(new Response(bytes, { status: answer.status, headers: out }), true);
	}
}

/** The headers of a page's request a backend gets; Pim's own cookies and credentials never go. */
const FORWARDED = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range", "user-agent", "x-requested-with"];

/** What a backend's response may not set: cookies would land on Pim's own address, and the page's rules are Pim's. */
const DROPPED = new Set([
	"set-cookie",
	"set-cookie2",
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options",
	"strict-transport-security",
	"content-length",
	"content-encoding",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"access-control-allow-origin",
	"access-control-allow-credentials",
	"cross-origin-resource-policy",
	"clear-site-data",
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
