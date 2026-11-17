/**
 * The web app's built files (`web/dist`), served by the Gate as the Cloudflare deployment's static assets were: a path the Worker answered
 * first (`run_worker_first` in `wrangler.jsonc`) goes to the application, anything else is a file of the build, and a path that names no
 * file is the single-page app's `index.html`. `PIM_WEB_DIR` names the directory; without it the Gate serves only the API.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { HttpHandler } from "./host.ts";

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
	".woff2": "font/woff2",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
	".ts": "text/plain; charset=utf-8",
	".gz": "application/gzip",
};

export function webAssets(dir: string | undefined): HttpHandler | undefined {
	if (!dir || !existsSync(join(dir, "index.html"))) return undefined;
	const root = normalize(dir);
	return (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") return false;
		const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
		if (applicationPath(path) || path.startsWith("/_")) return false;
		let file = normalize(join(root, path));
		if (!file.startsWith(root + sep) && file !== root) return false;
		const isFile = existsSync(file) && statSync(file).isFile();
		if (!isFile) file = join(root, "index.html");
		const headers: Record<string, string> = { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff" };
		// Built files are named by their content, so a browser keeps them; the page and the service worker are always asked for again.
		if (isFile && path.startsWith("/assets/")) headers["cache-control"] = "public, max-age=31536000, immutable";
		else headers["cache-control"] = "no-cache";
		if (path === "/authorize") Object.assign(headers, { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY", "cache-control": "no-store" });
		if (path.startsWith("/shared/")) Object.assign(headers, { "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
		res.writeHead(200, headers);
		if (req.method === "HEAD") res.end();
		else createReadStream(file).pipe(res);
		return true;
	};
}
