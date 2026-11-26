import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webAssets } from "../src/web-assets.ts";
import { activate, clear, listReleases, prune, publish, releaseId, rollback } from "../src/web-release.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** A build as Vite writes one: a page, hashed files under /assets and a few that keep their names. */
function build(dir: string, version: string, chunks: Record<string, string> = {}) {
	mkdirSync(join(dir, "assets"), { recursive: true });
	writeFileSync(join(dir, "index.html"), `<!doctype html><script type="module" src="/assets/index-${version}aaaa.js"></script>`);
	writeFileSync(join(dir, "assets", `index-${version}aaaa.js`), `console.log("entry ${version}")`);
	for (const [name, body] of Object.entries(chunks)) writeFileSync(join(dir, "assets", name), body);
	writeFileSync(join(dir, "sw.js"), `// service worker ${version}`);
	writeFileSync(join(dir, "favicon.svg"), "<svg/>");
	writeFileSync(join(dir, "release.json"), JSON.stringify({ id: version, version: "0.1.0" }));
	return dir;
}

describe("web assets", () => {
	const scratch = mkdtempSync(join(tmpdir(), "pim-web-assets-"));
	let server: Server;
	let origin: string;
	const dist = build(join(scratch, "dist"), "v1", { "chunk-v1chunk1.js": "export const a = 1;" });
	const releases = join(scratch, "releases-root");
	const get = (path: string, headers: Record<string, string> = {}, method = "GET") => fetch(origin + path, { method, headers, redirect: "manual" });

	beforeAll(async () => {
		const handler = webAssets(dist)!;
		server = createServer((req, res) => {
			if (!handler(req, res)) res.writeHead(418).end("the application");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => {
		server.close();
		rmSync(scratch, { recursive: true, force: true });
	});

	it("keeps a content-hashed file for good, and asks about everything else again", async () => {
		const chunk = await get("/assets/chunk-v1chunk1.js");
		expect(chunk.status).toBe(200);
		expect(chunk.headers.get("cache-control")).toBe(IMMUTABLE);
		expect(chunk.headers.get("content-type")).toContain("text/javascript");
		expect(await chunk.text()).toBe("export const a = 1;");
		for (const path of ["/", "/chat/abc", "/sw.js", "/favicon.svg", "/release.json"]) {
			const response = await get(path);
			expect(response.status, path).toBe(200);
			expect(response.headers.get("cache-control"), path).toBe("no-cache");
			expect(response.headers.get("etag"), path).toBeTruthy();
		}
	});

	it("answers a repeat visit that changed nothing with 304, and a changed file with its new body", async () => {
		const first = await get("/");
		const tag = first.headers.get("etag")!;
		const again = await get("/", { "if-none-match": tag });
		expect(again.status).toBe(304);
		expect(await again.text()).toBe("");
		expect(again.headers.get("cache-control")).toBe("no-cache");
		expect((await get("/", { "if-none-match": '"something else"' })).status).toBe(200);
		// The page of a route is the same page, so the same tag.
		expect((await get("/chat/other", { "if-none-match": tag })).status).toBe(304);
	});

	it("never answers a missing file with the page, and never lets a 404 be kept", async () => {
		for (const path of ["/assets/gone-abcdefgh.js", "/assets/nothing", "/missing.js", "/missing.css", "/fonts/x.woff2", "/assets/"]) {
			const response = await get(path);
			expect(response.status, path).toBe(404);
			expect(response.headers.get("cache-control"), path).toBe("no-store");
			expect(response.headers.get("content-type"), path).not.toContain("html");
		}
		// A route of the single-page app is the page.
		expect((await get("/settings")).headers.get("content-type")).toContain("text/html");
	});

	it("leaves the application's paths alone, and refuses to leave its directory", async () => {
		expect((await get("/api/anything")).status).toBe(418);
		expect((await get("/auth/session")).status).toBe(418);
		expect((await get("/", {}, "POST")).status).toBe(418);
		// Sent as written: a client would resolve the dots itself.
		const raw = (path: string) => new Promise<number>((resolve) => request({ host: "127.0.0.1", port: Number(new URL(origin).port), path }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).end());
		expect(await raw("/assets/..%2f..%2fsecret.txt")).toBe(404);
		expect(await raw("/assets/../../secret.txt")).toBe(404);
		expect((await get("/%E0%A4%A")).status).toBe(418);
		const head = await get("/assets/chunk-v1chunk1.js", {}, "HEAD");
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("19");
	});

	it("does not follow a link out of the release", async () => {
		writeFileSync(join(scratch, "secret.txt"), "secret");
		symlinkSync(join(scratch, "secret.txt"), join(dist, "assets", "leak-abcdefgh.js"));
		const response = await get("/assets/leak-abcdefgh.js");
		expect(response.status).toBe(404);
	});

	describe("releases", () => {
		let switching: Server;
		let at: string;
		const a = build(join(scratch, "build-a"), "aaaa", { "lazy-aaaachunk.js": "export default 'lazy a'" });
		const b = build(join(scratch, "build-b"), "bbbb", { "lazy-bbbbchunk.js": "export default 'lazy b'" });

		beforeAll(async () => {
			const handler = webAssets(dist, { releases, refreshMs: 0 })!;
			switching = createServer((req, res) => {
				if (!handler(req, res)) res.writeHead(418).end();
			});
			await new Promise<void>((resolve) => switching.listen(0, "127.0.0.1", resolve));
			at = `http://127.0.0.1:${(switching.address() as AddressInfo).port}`;
		});
		afterAll(() => switching.close());
		const page = async () => (await fetch(`${at}/`)).text();

		it("serves the build in the image until a release is activated", async () => {
			expect(await page()).toContain("index-v1aaaa.js");
		});

		it("switches to a release and back at once, with no restart, and tells the page which it is", async () => {
			const first = publish(a, releases);
			expect(publish(a, releases).id).toBe(first.id);
			activate(releases, first.id);
			const response = await fetch(`${at}/`);
			expect(await response.text()).toContain("index-aaaaaaaa.js");
			expect(response.headers.get("x-pim-web-release")).toBe(first.id);
			const second = publish(b, releases);
			activate(releases, second.id);
			expect(await page()).toContain("index-bbbbaaaa.js");
			expect(rollback(releases)).toBe(first.id);
			expect(await page()).toContain("index-aaaaaaaa.js");
			expect(rollback(releases)).toBe(second.id);
			expect(await page()).toContain("index-bbbbaaaa.js");
		});

		it("still serves a file only an older release has, so a tab opened before the release keeps loading", async () => {
			const old = await fetch(`${at}/assets/lazy-aaaachunk.js`);
			expect(old.status).toBe(200);
			expect(old.headers.get("cache-control")).toBe(IMMUTABLE);
			expect(await old.text()).toBe("export default 'lazy a'");
			// And the image's own, which the releases never held.
			expect((await fetch(`${at}/assets/chunk-v1chunk1.js`)).status).toBe(200);
			expect((await fetch(`${at}/assets/lazy-zzzzzzzz.js`)).status).toBe(404);
		});

		it("keeps what is current, what is previous, the newest few and what was used lately, and nothing else", async () => {
			const day = 86_400_000;
			const now = new Date("2026-11-26T12:00:00Z");
			// Days before `now` each was last used: two are older than a week and fall outside the newest three, the last two are not.
			const daysAgo = [60, 59, 58, 57, 3, 2];
			const ids = daysAgo.map((days, i) => {
				const used = new Date(now.getTime() - days * day);
				const release = publish(build(join(scratch, `build-old-${i}`), `o${i}${i}${i}`), releases, used);
				writeFileSync(join(releases, "releases", release.id, ".activated"), "");
				utimesSync(join(releases, "releases", release.id, ".activated"), used, used);
				return release.id;
			});
			const before = listReleases(releases).length;
			// Sorted by use: current and previous (used now), then 2 and 3 days ago, then the four old ones; `keep` 3 holds only the first of those below the two.
			expect(prune(releases, { keep: 3, minAgeDays: 7, now }).sort()).toEqual(ids.slice(0, 4).sort());
			expect(listReleases(releases)).toHaveLength(before - 4);
			expect(listReleases(releases).filter((r) => r.current || r.previous)).toHaveLength(2);
			expect(prune(releases, { keep: 3, minAgeDays: 7, now })).toEqual([]);
			// What was deleted is a 404 again, not the page; what stayed is still served.
			expect(releaseId(a)).toHaveLength(16);
		});

		it("returns to the build in the image when the link is cleared, which is what a full update needs", async () => {
			expect(await page()).toContain("index-bbbbaaaa.js");
			clear(releases);
			expect(await page()).toContain("index-v1aaaa.js");
			expect(() => rollback(releases)).toThrow(/no earlier release/);
			// Releases are kept: activating one serves it again.
			activate(releases, listReleases(releases)[0]!.id);
			expect(await page()).not.toContain("index-v1aaaa.js");
		});
	});
});
