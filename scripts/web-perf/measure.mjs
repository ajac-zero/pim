#!/usr/bin/env node
// Cold, warm and chat-revisit loads of a running Pim, in a fresh Chrome profile with synthetic network throttling (default 60 ms round trip, 20 Mbps down).
// It measures one Pim from one machine: a synthetic setup, not production. Seed the account first (a few dozen chats named "Seed chat N" with messages "hello N.m"); see
// docs/v2-operations.md, "Measuring how the web app loads".
//
//   BASE=http://localhost:8787 USER_NAME=perf LABEL=after node scripts/web-perf/measure.mjs > after.json
//   THROTTLE=0 turns the throttle off; SW=0 bypasses the service worker, so the browser's HTTP cache alone answers the warm load; VERBOSE=1 lists every request that moved bytes.
import { launch } from "./cdp.mjs";

const base = process.env.BASE ?? "http://localhost:8787";
const page = await launch({ base, user: process.env.USER_NAME ?? "perf", throttle: process.env.THROTTLE === "0" ? null : { rtt: Number(process.env.RTT ?? 60), mbps: Number(process.env.MBPS ?? 20) }, bypassServiceWorker: process.env.SW === "0" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function summarize(label, ms) {
	const all = page.requests();
	const moved = all.filter((r) => r.bytes > 0 && !r.cached);
	return {
		label,
		ms: Math.round(ms),
		requests: all.length,
		networkRequests: moved.length,
		answeredByCache: all.length - moved.length,
		status304: all.filter((r) => r.status === 304).length,
		kiBTransferred: Math.round(all.reduce((sum, r) => sum + r.bytes, 0) / 1024),
		scripts: all.filter((r) => r.url.endsWith(".js")).length,
		api: all.filter((r) => r.url.includes("/api/")).length,
		...(process.env.VERBOSE ? { moved: moved.map((r) => `${r.status} ${r.bytes}B ${r.url.replace(base, "").slice(0, 90)}`) } : {}),
	};
}

async function load(label) {
	page.reset();
	const t = performance.now();
	await page.send("Page.navigate", { url: `${base}/` });
	await page.waitFor(`document.querySelectorAll('a[href^="/chat/"]').length >= 5`);
	const listed = performance.now() - t;
	await sleep(1500);
	results.push({ ...summarize(label, listed), note: "ms = until the sidebar lists chats" });
}

await load("cold (empty profile)");
await sleep(2000);
await load("warm reload (same profile)");
const links = await page.evalJs(`[...new Set([...document.querySelectorAll('a[href^="/chat/"]')].filter(a=>/Seed chat/.test(a.innerText)).map(a=>a.getAttribute('href')))].slice(0,3)`);
async function open(href, label) {
	page.reset();
	const t = performance.now();
	await page.evalJs(`document.querySelector('a[href="${href}"]').click()`);
	await page.waitFor(`location.pathname === "${href}" && /hello \\d+\\.2/.test(document.body.innerText)`);
	const ms = performance.now() - t;
	await sleep(500);
	results.push(summarize(`${label} ${href.slice(6, 14)}`, ms));
}
for (const href of links) await open(href, "chat, first open");
await open(links[0], "chat, REVISIT");
await open(links[1], "chat, REVISIT");
console.log(JSON.stringify({ base, label: process.env.LABEL, throttle: process.env.THROTTLE === "0" ? "none" : `${process.env.RTT ?? 60} ms round trip, ${process.env.MBPS ?? 20} Mbps down`, serviceWorker: process.env.SW === "0" ? "bypassed" : "active", results }, null, 2));
await page.close();
process.exit(0);
