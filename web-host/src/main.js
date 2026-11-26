/**
 * The web host: the process that serves the web app, on its own, in front of nothing but the proxy. The Pim image has no web app in it. This one's image carries one
 * build (`PIM_WEB_SOURCE`); on starting it publishes that build into the releases volume (`PIM_WEB_RELEASES`), makes it the one served, deletes releases nothing
 * needs any more (`release.js`), and serves. So releasing the interface is starting the new web image: the backend is not touched, and the files of the releases before
 * it stay for the pages that are still open on them. Starting an older image again is the rollback.
 *
 *   PIM_HTTP_PORT (8080), PIM_WEB_RELEASES (/web-releases), PIM_WEB_SOURCE (/app/dist), PIM_WEB_KEEP (5) and PIM_WEB_KEEP_DAYS (7): what `prune` keeps.
 *   `node src/main.js list` and `node src/main.js prune` show and clean the releases without serving.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { webAssets } from "./assets.js";
import { activate, linked, listReleases, prune, publish } from "./release.js";

const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data }));

/** Publishes and activates `source` in `releases`, prunes, and serves from `releases` on `port` (0: any). */
export async function startWebHost({ port = 8080, releases, source, keep = 5, keepDays = 7, quiet = false }) {
	const say = quiet ? () => {} : log;
	if (source && existsSync(source)) {
		const release = publish(source, releases);
		activate(releases, release.id);
		say("pim.web.published", { release: release.id, version: release.version ?? null, files: release.files });
		const deleted = prune(releases, { keep, minAgeDays: keepDays });
		if (deleted.length) say("pim.web.pruned", { deleted });
	}
	const handler = webAssets(releases, { onRelease: (release) => say("pim.web.serving", { release: release ?? null }) });
	const server = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0];
		if (path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
		// Ready once there is a release to serve; the proxy and the orchestrator send it nothing before.
		if (path === "/readyz") return void res.writeHead(linked(releases, "current") ? 200 : 503, { "content-type": "text/plain" }).end();
		handler(req, res);
	});
	await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
	return { server, port: server.address().port, close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
				server.closeIdleConnections();
				// A download still on its way gets a moment to end.
				setTimeout(() => server.closeAllConnections(), 500).unref();
			}),
	};
}

async function main(argv) {
	const releases = process.env.PIM_WEB_RELEASES ?? "/web-releases";
	const [command = "serve"] = argv;
	if (command === "list") {
		for (const r of listReleases(releases)) console.log(`${r.current ? "current " : r.previous ? "previous" : "        "} ${r.id} ${r.version ?? ""} ${r.revision?.slice(0, 7) ?? ""} used ${new Date(r.usedAt).toISOString()}`);
		return;
	}
	const keep = Number(process.env.PIM_WEB_KEEP ?? 5);
	const keepDays = Number(process.env.PIM_WEB_KEEP_DAYS ?? 7);
	if (command === "prune") {
		const deleted = prune(releases, { keep, minAgeDays: keepDays });
		console.log(deleted.length ? `deleted ${deleted.join(", ")}` : "nothing to delete");
		return;
	}
	if (command !== "serve") throw new Error("usage: main.js [serve|list|prune]");
	const host = await startWebHost({ port: Number(process.env.PIM_HTTP_PORT ?? 8080), releases, source: process.env.PIM_WEB_SOURCE ?? "/app/dist", keep, keepDays });
	log("pim.web.started", { port: host.port });
	for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => host.close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(JSON.stringify({ event: "pim.web.failed", error: String(error?.message ?? error) }));
		process.exit(1);
	});
}
