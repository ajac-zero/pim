/**
 * The web app's files, served from the release the `current` link names (`release.js`): a path that names a file is that file, and a path that names none is
 * the single-page app's `index.html`. This process serves nothing else, and it holds nothing private: the backend (the Gate, Live and the rest) answers `/api`, `/auth`
 * and the other paths of `routes.js`, and the proxy in front sends them there, so a request for one that reaches this process is a 404, never the page.
 *
 * What a browser may keep, by what the file is:
 * - A content-hashed file under `/assets/` never changes under its name: `public, max-age=31536000, immutable`.
 * - The page, the service worker, the release manifest and every other file are asked about again each time (`no-cache`) and answer
 *   `304 Not Modified` to a matching `If-None-Match`, so a visit that changed nothing moves no body.
 * - A file that is not there is a 404 that is never stored (`no-store`): a missing script is not the page. The page stands in only for the paths
 *   of the single-page app's routes.
 *
 * A missing `/assets/` file is looked for in the other releases still on disk before it is a 404, which keeps a tab opened before a release loading the scripts
 * it still needs. That is the whole of the history kept: no older release is ever served as the page.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { isBackendPath } from "./routes.js";
import { linked, readRelease } from "./release.js";

const TYPES = {
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
};

/** Paths with these extensions name a file: when there is none, the answer is a 404, not the page the single-page app's routes get. */
const FILE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".map", ".woff", ".woff2", ".ttf", ".png", ".svg", ".ico", ".wasm", ".webmanifest", ".json", ".txt"]);

/** The bundler's name for a built file: a name, a dash and eight or more characters of its content's hash, then the extension. */
const HASHED = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

/** The path of `path` inside `root` if it is a regular file there, and no link leads out of the root. */
function fileIn(root, path) {
	const file = normalize(join(root, path));
	if (!file.startsWith(root + sep)) return undefined;
	try {
		if (!statSync(file).isFile()) return undefined;
		return realpathSync(file).startsWith(root + sep) ? file : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param {string} releases the directory of releases
 * @param {{ refreshMs?: number, onRelease?: (release: string | undefined) => void }} [options] `refreshMs`: how long the link and the list of older releases are remembered between requests
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => boolean}
 */
export function webAssets(releases, options = {}) {
	releases = normalize(releases);
	const refreshMs = options.refreshMs ?? 1000;
	let active = { at: -Infinity, served: undefined };
	let older = { at: -Infinity, roots: [] };
	/** The release being served, looked for again once `refreshMs` has passed. */
	const serving = () => {
		if (Date.now() - active.at >= refreshMs) {
			const id = linked(releases, "current");
			const served = id ? { root: realpathSync(join(releases, "releases", id)), release: id } : undefined;
			if (served?.release !== active.served?.release) options.onRelease?.(served?.release);
			active = { at: Date.now(), served };
		}
		return active.served;
	};
	const others = (current) => {
		if (Date.now() - older.at >= refreshMs) {
			const dirs = join(releases, "releases");
			const names = existsSync(dirs) ? readdirSync(dirs).filter((name) => !name.startsWith(".")) : [];
			older = { at: Date.now(), roots: names.map((name) => join(dirs, name)).flatMap((path) => (existsSync(join(path, "index.html")) ? [realpathSync(path)] : [])) };
		}
		return older.roots.filter((root) => root !== current);
	};

	/** What a file's body is called, for `If-None-Match`: a hash of its bytes for what is asked about again, its size and time for a built file. */
	const tags = new Map();
	const etagOf = (file, hashed) => {
		const stat = statSync(file);
		if (hashed) return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
		const known = tags.get(file);
		if (known && known.size === stat.size && known.mtime === stat.mtimeMs) return known.tag;
		const tag = `"${createHash("sha256").update(readFileSync(file)).digest("base64url").slice(0, 22)}"`;
		tags.set(file, { size: stat.size, mtime: stat.mtimeMs, tag });
		return tag;
	};

	const notFound = (req, res) => {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(req.method === "HEAD" ? undefined : "Not found");
		return true;
	};

	return (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
			return true;
		}
		let path;
		try {
			path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
		} catch {
			res.writeHead(400, { "cache-control": "no-store" }).end();
			return true;
		}
		// The backend's paths are never the page: a proxy that sent one here is misrouted, and says so.
		if (isBackendPath(path)) return notFound(req, res);
		const served = serving();
		if (!served) {
			res.writeHead(503, { "cache-control": "no-store", "retry-after": "5" }).end();
			return true;
		}
		const hashed = path.startsWith("/assets/") && HASHED.test(path);
		let file = path === "/" ? undefined : fileIn(served.root, path);
		if (!file && path.startsWith("/assets/")) {
			for (const root of others(served.root)) {
				file = fileIn(root, path);
				if (file) break;
			}
		}
		const isFile = file !== undefined;
		if (!file && (path.startsWith("/assets/") || FILE_EXTENSIONS.has(extname(path).toLowerCase()))) return notFound(req, res);
		file ??= join(served.root, "index.html");
		const headers = { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff" };
		headers["cache-control"] = isFile && hashed ? "public, max-age=31536000, immutable" : "no-cache";
		if (!isFile || file.endsWith(`${sep}index.html`)) {
			const id = served.release ?? readRelease(served.root)?.id;
			if (id) headers["x-pim-web-release"] = id;
		}
		if (path === "/authorize") Object.assign(headers, { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY", "cache-control": "no-store" });
		else headers.etag = etagOf(file, hashed && isFile);
		if (path.startsWith("/shared/")) Object.assign(headers, { "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
		const matches = String(req.headers["if-none-match"] ?? "").split(",").map((tag) => tag.trim().replace(/^W\//, ""));
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
