#!/usr/bin/env node
// Releases a second web build on a running development preview while a page is open on the first, and again to go back, and reports what the browser saw. The web host is its own
// process (web-host/): a release is replacing it, as a new web image is in a deployment, and the preview does that when the host is stopped (scripts/v2-dev/preview.mjs: it starts it
// again with the build named in <state>/web-source). Nothing else is restarted, so the Pim process, the page's Live socket and its session must be the same throughout.
//
//   BASE=http://localhost:8787 STATE=.wrangler/state-v2-dev NEXT=<a second build's dist> BACKEND_PID=<pid of the Pim process> node scripts/web-perf/release-check.mjs
//
// 1. a page opens on the release being served (A) and its Live socket connects; 2. the web host is replaced by one carrying NEXT (B); 3. the old page moves to a route whose script it
// has not loaded yet: A's file must still be served, with no reload; 4. a reload reaches B; 5. the web host with A's build is started again (the rollback): a reload gets A.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";

const base = process.env.BASE ?? "http://localhost:8787";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const state = process.env.STATE ? join(process.cwd(), process.env.STATE) : join(repo, ".wrangler", "state-v2-dev");
const root = join(state, "web-releases");
const next = process.env.NEXT;
const pid = process.env.BACKEND_PID;
if (!next || !pid) throw new Error("NEXT and BACKEND_PID are required");
const original = join(repo, "web", "dist");
/** Replaces the web host with one carrying `source`, and waits until the page it serves is the new one's. */
async function replaceWebHost(source) {
	writeFileSync(join(state, "web-source"), source);
	const old = Number(readFileSync(join(state, "web.pid"), "utf8"));
	process.kill(old, "SIGTERM");
	for (let i = 0; i < 100; i++) {
		await sleep(100);
		const now = Number(readFileSync(join(state, "web.pid"), "utf8"));
		if (now !== old && (await fetch(`${base}/`).then((r) => r.ok, () => false))) return;
	}
	throw new Error("the web host did not come back");
}
const started = () => execFileSync("ps", ["-o", "lstart=", "-p", pid], { encoding: "utf8" }).trim();
const header = async () => (await fetch(`${base}/`)).headers.get("x-pim-web-release");

const report = { base, steps: [] };
const step = (name, data) => {
	report.steps.push({ name, ...data });
	console.error(`- ${name}`, JSON.stringify(data));
};
const backend = { pid, started: started() };
const page = await launch({ base, user: process.env.USER_NAME ?? "perf", throttle: null });
const ready = `document.querySelectorAll('a[href^="/chat/"]').length >= 5`;

// 1. Open on A.
const a = await header();
await page.send("Page.navigate", { url: `${base}/` });
await page.waitFor(ready);
await page.evalJs("window.__oldTab = 'same document'");
await sleep(1500);
const documents = () => page.requests().filter((r) => r.type === "Document");
step("page opened on A", { release: a, liveSockets: page.sockets.created, scripts: page.requests().filter((r) => r.url.endsWith(".js")).length });

// 2. Publish and activate B.
const socketsBefore = { ...page.sockets };
await replaceWebHost(next);
const b = await header();
step("web host replaced by one carrying B", { release: b, switched: b !== a, backendPid: pid });

// 3. The old page loads a route's script it has not asked for yet: through the router, as a click would.
const aAssets = readdirSync(join(root, "releases", a, "assets"));
const wanted = aAssets.find((f) => f.startsWith("people._username-"));
page.reset();
await page.evalJs(`history.pushState({}, '', '/people/perf'); dispatchEvent(new PopStateEvent('popstate')); 0`);
await page.waitFor(`location.pathname === '/people/perf'`);
await sleep(1500);
const chunk = page.requests().find((r) => r.url.includes("/assets/people._username-"));
step("old page navigates to a route not loaded before", {
	asked: chunk ? chunk.url.replace(base, "") : null,
	expectedFromA: wanted,
	status: chunk?.status,
	cacheControl: chunk?.headers?.["cache-control"],
	sameDocument: (await page.evalJs("window.__oldTab")) === "same document",
	reloads: documents().length,
	liveSocketBefore: socketsBefore,
	liveSocketAfter: { ...page.sockets },
	liveSocketStayedOpen: page.sockets.closed === socketsBefore.closed,
});

// 4. Reload. The service worker opens the page it kept (A) at once and finds B meanwhile; a page that has just opened then reloads into it (web/src/lib/push.ts).
const entry = (id) => /src="\/assets\/(index-[^"]+\.js)"/.exec(readFileSync(join(root, "releases", id, "index.html"), "utf8"))[1];
page.reset();
await page.send("Page.navigate", { url: `${base}/` });
const arrived = await page.waitFor(`document.querySelector('script[type=module][src*="/assets/"]')?.src.endsWith('${entry(b)}') && ${ready}`, 20_000);
await sleep(1500);
const files = page.requests().filter((r) => r.url.includes("/assets/"));
step("reload reaches B", {
	msToB: arrived,
	entryA: entry(a),
	entryB: entry(b),
	documents: documents().map((r) => ({ status: r.status, fromServiceWorker: r.fromSW ?? false, release: r.headers?.["x-pim-web-release"] })),
	assetRequests: files.length,
	assetsThatMovedBytes: files.filter((r) => r.bytes > 0 && !r.cached && r.status === 200).map((r) => `${r.bytes}B ${r.url.replace(base, "")}`),
});

// 5. Roll back.
await replaceWebHost(original);
const after = await header();
page.reset();
await page.send("Page.navigate", { url: `${base}/` });
await page.waitFor(ready);
await sleep(1500);
step("rolled back", { release: (documents()[0]?.headers ?? {})["x-pim-web-release"], rolledBackTo: after, isA: after === a });

// The backend and the session did not move.
const session = await page.evalJs(`fetch('/auth/session').then(r => r.json()).then(s => s.signedIn)`);
step("backend", { before: backend, after: { pid, started: started() }, unchanged: started() === backend.started, signedIn: session });
console.log(JSON.stringify(report, null, 2));
await page.close();
process.exit(0);
