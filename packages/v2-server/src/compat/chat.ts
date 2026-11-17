/**
 * What a signed-in person uses around chatting, in the shapes the web app was written against (v1's `/api`), over V2's services: a chat's
 * activity, cost, tasks, room and ui-block state, memory, files, triggers, the account screens, and the page diagrams are drawn in.
 * These routes are tried before the application's own, so where one answers a path that both do, the app's shape wins.
 */
import { type Reply, type Route, route } from "@pim/v2-app/http";
import { accountRoutes } from "./chat-account.ts";
import { fileRoutes } from "./chat-files.ts";
import { memoryRoutes } from "./chat-memory.ts";
import { sessionRoutes } from "./chat-sessions.ts";
import { triggerRoutes } from "./chat-triggers.ts";

/** The page a ```mermaid block is drawn in, inside a sandboxed frame: the same for everyone, and it loads only the Mermaid runtime the web build ships. */
function diagramPage(origin: string): Reply {
	const page =
		'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
		"<style>html,body{margin:0;background:transparent}body{font:14px/1.5 system-ui,sans-serif}pre.mermaid{margin:0;overflow-x:auto}pre.mermaid svg{display:block;margin:0 auto}</style></head><body>" +
		`<script src="${origin}/artifact-runtime/mermaid.js"></script>` +
		`<script>addEventListener("message",(event)=>{const data=event.data;if(event.source!==parent||!data||data.type!=="pim:diagram"||typeof data.source!=="string")return;__pimDiagram(data.source,data.dark===true)})</script>` +
		"</body></html>";
	return {
		status: 200,
		raw: page,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": `default-src 'none'; script-src 'unsafe-inline' ${origin}/artifact-runtime/; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; sandbox allow-scripts`,
			"x-content-type-options": "nosniff",
			"cache-control": "public, max-age=3600",
		},
	};
}

export const chatRoutes: Route[] = [
	...accountRoutes(),
	...sessionRoutes(),
	...memoryRoutes(),
	...fileRoutes(),
	...triggerRoutes(),
	route("GET", "/api/diagram", async ({ origin }) => diagramPage(origin)),
];
