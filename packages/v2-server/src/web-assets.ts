/**
 * The web app's built files (`web/dist`), served by the Gate as the Cloudflare deployment's static assets were: a path the Worker answered
 * first (`run_worker_first` in `wrangler.jsonc`) goes to the application, anything else is a file of the build, and a path that names no
 * file is the single-page app's `index.html`. `PIM_WEB_DIR` names the directory; without it the Gate serves only the API.
 *
 * What a browser may keep, by what the file is:
 * - A content-hashed file under `/assets/` never changes under its name: `public, max-age=31536000, immutable`.
 * - The page, the service worker, the release manifest and every other file are asked about again each time (`no-cache`) and answer
 *   `304 Not Modified` to a matching `If-None-Match`, so a visit that changed nothing moves no body.
 * - A file that is not there is a 404 that is never stored (`no-store`), whatever its path: a missing script is not the page. The page
 *   stands in only for the paths of the single-page app's routes.
 *
 * `PIM_WEB_RELEASES` names a directory of releases (`web-release.ts`): the Gate then serves the release its `current` link names, found
 * again on each request, so a release can be switched or rolled back while every process keeps running; `PIM_WEB_DIR` is what serves until
 * the first release is activated. A missing `/assets/` file is looked for in the other releases still on disk before it is a 404, which keeps
 * a tab opened before a release loading the files it still needs.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { HttpHandler } from "./host.ts";
import { linked, readRelease } from "./web-release.ts";

/** What the application answers before the static files, as `run_worker_first` lists it, plus v2's own snapshot and coding paths. */
const APPLICATION = ["/api", "/install.sh", "/auth", "/health", "/mcp", "/oauth", "/.well-known", "/images", "/app-pages", "/hosted", "/p", "/snapshot", "/live"];
const applicationPath = (path: string) => APPLICATION.some((p) => path === p || path.startsWith(`${p}/`));

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
	".ts": "text/plain; charset=utf-8",
	".gz": "application/gzip",
};

/** Paths with these extensions name a file: when there is none, the answer is a 404, not the page the single-page app's routes get. */
const FILE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".map", ".woff", ".woff2", ".ttf", ".png", ".svg", ".ico", ".wasm", ".webmanifest", ".json", ".gz", ".ts"]);

/** The bundler's name for a built file: a name, a dash and eight or more characters of its content's hash, then the extension. */
const HASHED = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

export type WebAssetsOptions = {
	/** A directory of releases (`web-release.ts`); the release its `current` link names is served in place of `dir`. */
	releases?: string | undefined;
	/** How long the link and the list of older releases are remembered between requests. */
	refreshMs?: number;
	/** Told when the release being served changes (its id; undefined for the build in the image). */
	onRelease?: (release: string | undefined) => void;
};

type Served = { root: string; release?: string };

/** The first path of `candidates` that is a regular file inside its root. */
function fileIn(root: string, path: string): string | undefined {
	const file = normalize(join(root, path));
	if (!file.startsWith(root + sep)) return undefined;
	try {
		if (!statSync(file).isFile()) return undefined;
		// A link inside a release must not lead out of it.
		return realpathSync(file).startsWith(root + sep) ? file : undefined;
	} catch {
		return undefined;
	}
}

export function webAssets(dir: string | undefined, options: WebAssetsOptions = {}): HttpHandler | undefined {
	const releases = options.releases ? normalize(options.releases) : undefined;
	const base = dir && existsSync(join(dir, "index.html")) ? realpathSync(dir) : undefined;
	if (!base && !releases) return undefined;
	const refreshMs = options.refreshMs ?? 1000;

	let active: { at: number; served: Served | undefined } = { at: -Infinity, served: undefined };
	let older: { at: number; roots: string[] } = { at: -Infinity, roots: [] };
	/** The release being served, and the others on disk, looked for again once `refreshMs` has passed. */
	const serving = (): Served | undefined => {
		if (Date.now() - active.at >= refreshMs) {
			const id = releases ? linked(releases, "current") : undefined;
			const root = id && releases ? realpathSync(join(releases, "releases", id)) : base;
			const served: Served | undefined = root ? { root, ...(id ? { release: id } : {}) } : undefined;
			if (served?.root !== active.served?.root) options.onRelease?.(served?.release);
			active = { at: Date.now(), served };
		}
		return active.served;
	};
	const others = (current: string): string[] => {
		if (!releases) return [];
		if (Date.now() - older.at >= refreshMs) {
			const dirs = join(releases, "releases");
			const names = existsSync(dirs) ? readdirSync(dirs).filter((name) => !name.startsWith(".")) : [];
			older = { at: Date.now(), roots: names.map((name) => join(dirs, name)).flatMap((path) => (existsSync(join(path, "index.html")) ? [realpathSync(path)] : [])) };
		}
		return [...older.roots.filter((root) => root !== current), ...(base && base !== current ? [base] : [])];
	};

	/** What a file's body is called, for `If-None-Match`: a hash of its bytes for what is asked about again, its size and time for a built file. */
	const tags = new Map<string, { size: number; mtime: number; tag: string }>();
	const etagOf = (file: string, hashed: boolean): string => {
		const stat = statSync(file);
		if (hashed) return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
		const known = tags.get(file);
		if (known && known.size === stat.size && known.mtime === stat.mtimeMs) return known.tag;
		const tag = `"${createHash("sha256").update(readFileSync(file)).digest("base64url").slice(0, 22)}"`;
		tags.set(file, { size: stat.size, mtime: stat.mtimeMs, tag });
		return tag;
	};

	return (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") return false;
		let path: string;
		try {
			path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
		} catch {
			return false;
		}
		if (applicationPath(path) || path.startsWith("/_")) return false;
		const served = serving();
		if (!served) return false;
		const hashed = path.startsWith("/assets/") && HASHED.test(path);
		let file = path === "/" ? undefined : fileIn(served.root, path);
		// A built file the release being served does not have may belong to an older one: a page opened before the release asks for it.
		if (!file && path.startsWith("/assets/")) {
			for (const root of others(served.root)) {
				file = fileIn(root, path);
				if (file) break;
			}
		}
		const isFile = file !== undefined;
		if (!file && (path.startsWith("/assets/") || FILE_EXTENSIONS.has(extname(path).toLowerCase()))) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(req.method === "HEAD" ? undefined : "Not found");
			return true;
		}
		file ??= join(served.root, "index.html");
		const headers: Record<string, string> = { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff" };
		if (isFile && hashed) headers["cache-control"] = "public, max-age=31536000, immutable";
		else headers["cache-control"] = "no-cache";
		if (!isFile || file.endsWith(`${sep}index.html`)) {
			const id = served.release ?? readRelease(served.root)?.id;
			if (id) headers["x-pim-web-release"] = id;
		}
		if (path === "/authorize") Object.assign(headers, { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY", "cache-control": "no-store" });
		else headers.etag = etagOf(file, hashed && isFile);
		if (path.startsWith("/shared/")) Object.assign(headers, { "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
		const matches = (req.headers["if-none-match"] ?? "").split(",").map((tag) => tag.trim().replace(/^W\//, ""));
		if (headers.etag && matches.includes(headers.etag.replace(/^W\//, ""))) {
			res.writeHead(304, headers).end();
			return true;
		}
		headers["content-length"] = String(statSync(file).size);
		res.writeHead(200, headers);
		if (req.method === "HEAD") res.end();
		else createReadStream(file).pipe(res);
		return true;
	};
}
