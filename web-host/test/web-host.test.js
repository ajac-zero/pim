import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKEND_PATHS, isBackendPath } from "../src/routes.js";
import { startWebHost } from "../src/main.js";
import { activate, listReleases, prune, publish, releaseId } from "../src/release.js";

const IMMUTABLE = "public, max-age=31536000, immutable";
const scratch = mkdtempSync(join(tmpdir(), "pim-web-host-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A build as Vite writes one: a page, hashed files under /assets and a few that keep their names. */
function build(name, chunks = {}) {
	const dir = join(scratch, `build-${name}`);
	mkdirSync(join(dir, "assets"), { recursive: true });
	writeFileSync(join(dir, "index.html"), `<!doctype html><title>${name}</title><script type="module" src="/assets/index-${name}0000.js"></script>`);
	writeFileSync(join(dir, "assets", `index-${name}0000.js`), `console.log("entry ${name}")`);
	for (const [file, body] of Object.entries(chunks)) writeFileSync(join(dir, "assets", file), body);
	writeFileSync(join(dir, "sw.js"), `// service worker ${name}`);
	writeFileSync(join(dir, "favicon.svg"), "<svg/>");
	writeFileSync(join(dir, "release.json"), JSON.stringify({ id: name, version: "0.1.0" }));
	return dir;
}

/** The raw status of a request path, sent as written (a client would resolve dots itself). */
const raw = (port, path) => new Promise((resolve) => request({ host: "127.0.0.1", port, path }, (res) => (res.resume(), resolve(res.statusCode))).end());

describe("the web host", () => {
	const root = join(scratch, "volume");
	let host;
	let origin;
	const get = (path, headers = {}, method = "GET") => fetch(origin + path, { method, headers, redirect: "manual" });
	const page = async () => (await get("/")).text();
	const start = async (source, options = {}) => {
		await host?.close();
		host = await startWebHost({ port: 0, releases: root, source, quiet: true, ...options });
		origin = `http://127.0.0.1:${host.port}`;
	};
	after(() => host?.close());

	it("is not ready, and serves no page, until a build is published", async () => {
		await start(undefined);
		assert.equal((await get("/readyz")).status, 503);
		assert.equal((await get("/")).status, 503);
		assert.equal((await get("/healthz")).status, 200);
	});

	it("keeps a content-hashed file for good, and asks about everything else again", async () => {
		await start(build("v1", { "chunk-v1chunk1.js": "export const a = 1;" }));
		assert.equal((await get("/readyz")).status, 200);
		const chunk = await get("/assets/chunk-v1chunk1.js");
		assert.equal(chunk.status, 200);
		assert.equal(chunk.headers.get("cache-control"), IMMUTABLE);
		assert.match(chunk.headers.get("content-type"), /text\/javascript/);
		assert.equal(await chunk.text(), "export const a = 1;");
		for (const path of ["/", "/chat/abc", "/sw.js", "/favicon.svg", "/release.json"]) {
			const response = await get(path);
			assert.equal(response.status, 200, path);
			assert.equal(response.headers.get("cache-control"), "no-cache", path);
			assert.ok(response.headers.get("etag"), path);
		}
	});

	it("answers a repeat visit that changed nothing with 304, and a changed file with its new body", async () => {
		const tag = (await get("/")).headers.get("etag");
		const again = await get("/", { "if-none-match": tag });
		assert.equal(again.status, 304);
		assert.equal(await again.text(), "");
		assert.equal(again.headers.get("cache-control"), "no-cache");
		assert.equal((await get("/", { "if-none-match": '"something else"' })).status, 200);
		assert.equal((await get("/chat/other", { "if-none-match": tag })).status, 304);
	});

	it("never answers a missing file with the page, and never lets a 404 be kept", async () => {
		for (const path of ["/assets/gone-abcdefgh.js", "/assets/nothing", "/missing.js", "/missing.css", "/fonts/x.woff2", "/assets/"]) {
			const response = await get(path);
			assert.equal(response.status, 404, path);
			assert.equal(response.headers.get("cache-control"), "no-store", path);
			assert.doesNotMatch(response.headers.get("content-type"), /html/, path);
		}
		assert.match((await get("/settings")).headers.get("content-type"), /text\/html/);
	});

	it("is never the backend: its paths are 404s, not the page, so a misrouted request is seen", async () => {
		for (const prefix of BACKEND_PATHS) {
			for (const path of [prefix, `${prefix}/anything`]) {
				const response = await get(path);
				assert.equal(response.status, 404, path);
				assert.doesNotMatch(response.headers.get("content-type"), /html/, path);
			}
		}
		assert.equal(isBackendPath("/pim-computer.ts"), true);
		assert.equal(isBackendPath("/people/ada"), false);
		assert.equal(isBackendPath("/p"), true);
		assert.equal(isBackendPath("/pricing"), false);
		assert.equal((await get("/", {}, "POST")).status, 405);
	});

	it("refuses to leave its directory, malformed paths, and links out of a release", async () => {
		assert.equal(await raw(host.port, "/assets/..%2f..%2fsecret.txt"), 404);
		assert.equal(await raw(host.port, "/assets/../../secret.txt"), 404);
		assert.equal(await raw(host.port, "/%E0%A4%A"), 400);
		const head = await get("/assets/chunk-v1chunk1.js", {}, "HEAD");
		assert.equal(head.status, 200);
		assert.equal(head.headers.get("content-length"), "19");
		writeFileSync(join(scratch, "secret.txt"), "secret");
		const release = listReleases(root).find((r) => r.current);
		symlinkSync(join(scratch, "secret.txt"), join(root, "releases", release.id, "assets", "leak-abcdefgh.js"));
		assert.equal((await get("/assets/leak-abcdefgh.js")).status, 404);
	});

	it("releases the interface by starting a new image: the new page is served, and the scripts of the page opened before it still are", async () => {
		const a = await (await get("/")).text();
		assert.match(a, /index-v10000\.js/);
		await start(build("v2", { "lazy-v2chunk22.js": "export default 'v2'" }));
		const b = await page();
		assert.match(b, /index-v20000\.js/);
		const response = await get("/");
		assert.equal(response.headers.get("x-pim-web-release"), listReleases(root).find((r) => r.current).id);
		// A tab opened on v1 asks for its own chunk after v2 is live: found in the release before, kept for good.
		const old = await get("/assets/chunk-v1chunk1.js");
		assert.equal(old.status, 200);
		assert.equal(old.headers.get("cache-control"), IMMUTABLE);
		assert.equal(await old.text(), "export const a = 1;");
		assert.equal((await get("/assets/lazy-zzzzzzzz.js")).status, 404);
		// The old page itself is not served: only history of files, never of the page.
		assert.doesNotMatch(await page(), /index-v10000\.js/);
	});

	it("rolls back by starting the older image again, and the newer one's scripts are kept", async () => {
		await start(build("v1", { "chunk-v1chunk1.js": "export const a = 1;" }));
		assert.match(await page(), /index-v10000\.js/);
		const list = listReleases(root);
		assert.equal(list.filter((r) => r.current).length, 1);
		assert.equal(list.filter((r) => r.previous).length, 1);
		assert.equal((await get("/assets/lazy-v2chunk22.js")).status, 200);
	});

	it("keeps what is current, what is previous, the newest few and what was used lately, and nothing else", () => {
		const day = 86_400_000;
		const now = new Date("2026-11-26T12:00:00Z");
		// Days before `now` each was last used: four are older than a week and outside the newest three, the last two are not.
		const daysAgo = [60, 59, 58, 57, 3, 2];
		const ids = daysAgo.map((days, i) => {
			const used = new Date(now.getTime() - days * day);
			const release = publish(build(`old${i}${i}${i}`), root, used);
			writeFileSync(join(root, "releases", release.id, ".activated"), "");
			utimesSync(join(root, "releases", release.id, ".activated"), used, used);
			return release.id;
		});
		const before = listReleases(root).length;
		// Sorted by use: the two served now, then 2 and 3 days ago, then the four old ones; `keep` 3 holds only the first of those below the two.
		assert.deepEqual(prune(root, { keep: 3, minAgeDays: 7, now }).sort(), ids.slice(0, 4).sort());
		assert.equal(listReleases(root).length, before - 4);
		assert.equal(listReleases(root).filter((r) => r.current || r.previous).length, 2);
		assert.deepEqual(prune(root, { keep: 3, minAgeDays: 7, now }), []);
		assert.equal(releaseId(build("v1")).length, 16);
	});

	it("publishes the same build once, and refuses a directory that is not a build", () => {
		const dir = build("same");
		assert.equal(publish(dir, root).id, publish(dir, root).id);
		assert.throws(() => publish(scratch, root), /no index.html/);
		assert.throws(() => activate(root, "nope"), /no release/);
	});
});
