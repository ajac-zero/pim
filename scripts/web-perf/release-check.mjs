#!/usr/bin/env node
// Switches the web app of a running Pim to another release and back while a page is open, and reports what a browser saw. For a Pim started with
// PIM_WEB_RELEASES (the development preview: `PIM_WEB_RELEASES=<dir> node scripts/v2-dev/preview.mjs`). It changes nothing but the releases directory.
//
//   BASE=http://localhost:8787 ROOT=<releases dir> NEXT=<a second build's dist> BACKEND_PID=<pid of the Pim process> node scripts/web-perf/release-check.mjs
//
// 1. a page opens on the release being served (A) and its Live socket connects; 2. NEXT is published and activated (B); 3. the old page moves to a route whose script it
// has not loaded yet: A's file must still be served, with no reload; 4. a reload gets B, moving only what changed; 5. rollback: a reload gets A.
// The Pim process (pid and start time), the page's socket and the session must be the same throughout.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";

const base = process.env.BASE ?? "http://localhost:8787";
const root = process.env.ROOT;
const next = process.env.NEXT;
const pid = process.env.BACKEND_PID;
if (!root || !next || !pid) throw new Error("ROOT, NEXT and BACKEND_PID are required");
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "v2-server");
const release = (...args) => execFileSync(process.execPath, ["--import", "tsx", "src/web-release.ts", ...args], { cwd: cli, encoding: "utf8" }).trim();
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
const published = release("publish", next, root, "--activate");
// The Gate looks at its `current` link at most once a second.
await sleep(1200);
const b = await header();
step("B published and active", { output: published.split("\n"), release: b, switched: b !== a });

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
const rolled = release("rollback", root);
await sleep(1200);
const after = await header();
page.reset();
await page.send("Page.navigate", { url: `${base}/` });
await page.waitFor(ready);
await sleep(1500);
step("rolled back", { output: rolled, release: (documents()[0]?.headers ?? {})["x-pim-web-release"], rolledBackTo: after, isA: after === a });

// The backend and the session did not move.
const session = await page.evalJs(`fetch('/auth/session').then(r => r.json()).then(s => s.signedIn)`);
step("backend", { before: backend, after: { pid, started: started() }, unchanged: started() === backend.started, signedIn: session });
console.log(JSON.stringify(report, null, 2));
await page.close();
process.exit(0);
