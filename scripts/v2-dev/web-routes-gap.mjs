// Lists the API paths the web app (web/src) calls and those no v2 route (packages/v2-app, packages/v2-server) matches: the gaps between the UI and a v2 Gate. Heuristic: run from the repository root.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) && !/test/.test(f) ? [p] : []; });
const web = walk("web/src").map((f) => readFileSync(f, "utf8")).join("\n");
const calls = new Set();
for (const m of web.matchAll(/call(?:<[^>]*(?:<[^>]*>[^>]*)*>)?\(\s*[`"']([^`"']+)[`"'](?:,\s*\{\s*method:\s*"(\w+)")?/g)) calls.add(`${m[2] ?? "GET"} /api${m[1].replace(/\$\{[^}]+\}/g, ":x").split("?")[0]}`);
for (const m of web.matchAll(/[`"'](\/(?:api|auth)\/[^`"'?]*)/g)) calls.add(`? ${m[1].replace(/\$\{[^}]+\}/g, ":x")}`);
const v2 = walk("packages/v2-app/src").concat(walk("packages/v2-server/src")).map((f) => readFileSync(f, "utf8")).join("\n");
const routes = [...v2.matchAll(/route\(\s*"(\w+)",\s*[`"']([^`"']+)[`"']/g)].map((m) => [m[1], m[2]]);
const toRe = (p) => new RegExp("^" + p.replace(/:[a-zA-Z_]+\*?/g, "[^/]+").replace(/\*/g, ".*") + "$");
const missing = [];
for (const c of [...calls].sort()) {
	const [method, path] = c.split(" ");
	const norm = path.replace(/:x/g, "X");
	const hit = routes.some(([m, p]) => (method === "?" || m === method || m === "ANY") && toRe(p).test(norm));
	if (!hit) missing.push(c);
}
console.log(routes.length, "v2 routes;", calls.size, "web calls;", missing.length, "unmatched");
console.log(missing.join("\n"));
