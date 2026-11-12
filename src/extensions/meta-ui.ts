import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { pimOrigin } from "../accounts";
import { match, type Route } from "../http";
import { defineGatedAction } from "./approvals";
import { definePimExtension } from "./define";
import { json, text } from "./services";

/**
 * The app's own routes, for the admin's majordomo: `ui_read` and `ui_write` run
 * a request against the same route table the web app uses (`Pim.#routes`,
 * through the ability's `ui`), in-process, so the majordomo can do what the
 * app can. Being offered the tools only keeps them out of other agents'
 * prompts: every tool checks on the server that the caller is the majordomo of
 * the admin's space.
 *
 * Every route has a class. `read` and `write` run through `ui_read` and
 * `ui_write`; `destructive` (every DELETE, and resetting a chat) only through
 * `ui_write_destructive`, which asks the person with the exact request; and
 * `blocked` never: what hands out or reads back credentials and files, and the
 * person's own decisions, such as approving a request, which an agent must not
 * do for itself. Writes are kept, with method, path, status and the keys of
 * the body, for `ui_audit`.
 */

const MAX_ANSWER_CHARS = 100_000;
const AUDIT_LIMIT = 500;

export type RouteClass = "read" | "write" | "destructive" | "blocked";

const BLOCKED: readonly RegExp[] = [
	/\/bridge$/,
	/\/grants$/,
	/\/download$/,
	/^\/files\/content$/,
	/^\/export$/,
	/^\/browser\/screenshot$/,
	/^\/mcp-server$/,
	/\/callback/,
	/^\/mcp\/events\//,
	// An agent must not approve or deny its own requests.
	/^\/approvals\/:id\/(approve|deny)$/,
	// An agent must not fill in or submit a form that was drawn for the person.
	/^\/messages\/:message\/ui-state/,
];

/** The class of a route, by its method and pattern. */
export function classOf(method: string, pattern: string): RouteClass {
	if (BLOCKED.some((blocked) => blocked.test(pattern))) return "blocked";
	if (method === "DELETE" || (method === "POST" && pattern === "/sessions/:session/reset")) return "destructive";
	return method === "GET" ? "read" : "write";
}

/**
 * The route the dispatcher serves a request with: the first of its method whose
 * pattern matches the path, found with the dispatcher's own `match`.
 */
export function routeFor(routes: readonly Route[], method: string, path: string): Route | undefined {
	const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
	return routes.find(([routeMethod, pattern]) => routeMethod === method && match(pattern, segments) !== null);
}

type Parsed = { method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | undefined };

const error = (message: string, status: number) => JSON.stringify({ error: message, status });

/** The request a call describes, or what is wrong with it. */
function parse(method: string, path: string, query: unknown, body: unknown): Parsed | string {
	if (!path.startsWith("/") || /[?#\\]/.test(path)) return "path must start with / and be like /sessions, with no query string: give query separately.";
	const parts = path.split("/");
	try {
		if (parts.some((part) => [".", ".."].includes(decodeURIComponent(part)))) return "path must not have . or .. in it.";
	} catch {
		return "path is not valid.";
	}
	if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) return "body must be a JSON object.";
	const params: Record<string, string> = {};
	for (const [key, value] of Object.entries((query ?? {}) as Record<string, unknown>)) params[key] = String(value);
	return { method, path, query: params, body: body as Record<string, unknown> | undefined };
}

const line = ({ method, path, body }: { method: string; path: string; body?: object }) => `${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`;

const PROMPT = `You can do in this Pim what the person does in its app, through the app's own routes. ui_routes lists every route with its class. ui_read gets any route (a GET); ui_write runs POST, PUT and PATCH routes at once. DELETE routes and resetting a chat (POST /sessions/<id>/reset) run only through ui_write_destructive, which asks the person first and shows them the exact request. Some routes are blocked for you: anything that hands out or reads back credentials, files and exports, and approving or denying a request, which only the person does. Bodies and query parameters are what the app sends. Every write is kept for ui_audit. Do only what the person asked.`;

export const metaUi = definePimExtension({
	id: "meta-ui",
	name: "The app's routes",
	description: "The admin's majordomo does what the web app does, through the same routes: reads and writes run at once, deletes ask the person, and some routes are never open to it.",
	ability: (context) => {
		const { conversationOf, ui } = context;
		/** The agent's id when this conversation is the admin's majordomo's. */
		const majordomoOf = (session: unknown) => {
			const { agent } = conversationOf(String(session));
			return context.admin && agent.majordomo ? agent.id : null;
		};
		const REFUSED = error("Only the admin's majordomo can use the app's routes.", 403);

		/** Runs the request through the app's routes. */
		function call({ method, path, query, body }: Parsed) {
			const url = new URL(path, pimOrigin(env));
			for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
			return ui.request(new Request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
		}

		/** What the model reads of an answer: JSON as it is, anything else only described. */
		async function render(response: Response) {
			const status = response.status;
			const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
			let body: string;
			if (type === "application/json" || type.endsWith("+json")) {
				body = JSON.stringify({ status, body: await response.json().catch(() => null) });
			} else {
				const size = (await response.arrayBuffer()).byteLength;
				body = JSON.stringify({ status, body: `[${type || "no content type"}, ${size} bytes: not shown]` });
			}
			return { text: body.length > MAX_ANSWER_CHARS ? `${body.slice(0, MAX_ANSWER_CHARS)} … [cut: ask for less with query]` : body, failed: status >= 400 };
		}

		/** The class of the route a request is for, or the refusal for one that has none. */
		function classify({ method, path }: Parsed): RouteClass | string {
			const route = routeFor(ui.routes(), method, path);
			return route ? classOf(method, route[1]) : error(`No ${method} route for ${path}: see ui_routes.`, 404);
		}

		/** Runs a write and keeps it. */
		async function write(agentId: string, request: Parsed) {
			const response = await call(request);
			ui.audit({ at: new Date().toISOString(), agent: agentId, method: request.method, path: request.path, status: response.status, keys: Object.keys(request.body ?? {}) });
			return render(response);
		}

		const writeParameters = (methods: string[], description: string) =>
			Type.Object({
				method: Type.Union(methods.map((method) => Type.Literal(method)), { description: "The HTTP method." }),
				path: Type.String({ description }),
				body: Type.Optional(Type.Object({}, { additionalProperties: true, description: "The JSON body the app sends." })),
			});

		const NOT_OPEN = error("This route is not open to you.", 403);

		return {
			offeredTo: (agent) => context.admin && agent.majordomo,
			actions: [
				defineGatedAction({
					name: "ui_write_destructive",
					description: "A write through the app's routes that can't be taken back: any DELETE, and POST /sessions/<id>/reset. The person reads the exact request before it runs.",
					parameters: writeParameters(["POST", "DELETE"], "Such as /sessions/<id> or /sessions/<id>/reset."),
					explicitApproval: true,
					summarize: ({ method, path, body }) => line({ method, path, body }),
					async prepare(args, { session }) {
						if (majordomoOf(session) === null) return { refused: REFUSED };
						const parsed = parse(args.method, args.path, undefined, args.body);
						if (typeof parsed === "string") return { refused: error(parsed, 400) };
						const kind = classify(parsed);
						if (kind === "blocked") return { refused: NOT_OPEN };
						if (kind !== "destructive") return { refused: kind === "read" || kind === "write" ? error("This one needs no approval: use ui_write.", 400) : kind };
						return { args: { method: parsed.method, path: parsed.path, ...(parsed.body === undefined ? {} : { body: parsed.body }) } as typeof args, summary: line(parsed) };
					},
					async run(args, { session }) {
						const agentId = majordomoOf(session);
						if (agentId === null) return REFUSED;
						const parsed = parse(args.method, args.path, undefined, args.body);
						if (typeof parsed === "string") return error(parsed, 400);
						if (classify(parsed) !== "destructive") return error("Not a route that runs here.", 403);
						return (await write(agentId, parsed)).text;
					},
				}),
			],
			sections: [section("ui_routes", ({ conversationId }) => (majordomoOf(conversationId) === null ? undefined : PROMPT))],
			tools: [
				defineTool({
					name: "ui_routes",
					description: "Every route of the app, with its method, pattern and class: read, write, destructive (asks the person) or blocked (never open to you).",
					parameters: Type.Object({}),
					async execute(_args, api) {
						if (majordomoOf(api.conversationId) === null) return text(REFUSED, true);
						return json({ routes: ui.routes().map(([method, pattern]) => ({ method, path: pattern, class: classOf(method, pattern) })) });
					},
				}),
				defineTool({
					name: "ui_read",
					description: "GETs any route of the app, as the app does. The answer is cut at 100,000 characters; files and other answers that aren't JSON are only described.",
					parameters: Type.Object({
						path: Type.String({ description: "Starting with /, with no ? or #, such as /sessions." }),
						query: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Query parameters." })),
					}),
					async execute({ path, query }, api) {
						if (majordomoOf(api.conversationId) === null) return text(REFUSED, true);
						const parsed = parse("GET", path, query, undefined);
						if (typeof parsed === "string") return text(error(parsed, 400), true);
						const kind = classify(parsed);
						if (kind === "blocked") return text(NOT_OPEN, true);
						if (kind !== "read") return text(kind, true);
						const done = await render(await call(parsed));
						return text(done.text, done.failed);
					},
				}),
				defineTool({
					name: "ui_write",
					description:
						"POSTs, PUTs or PATCHes a route of the app, as the app does. DELETE routes and chat resets are refused here: use ui_write_destructive. Blocked routes are refused. Every write is kept for ui_audit.",
					parameters: writeParameters(["POST", "PUT", "PATCH"], "Starting with /, with no ? or #, such as /agents."),
					async execute({ method, path, body }, api) {
						const agentId = majordomoOf(api.conversationId);
						if (agentId === null) return text(REFUSED, true);
						const parsed = parse(method, path, undefined, body);
						if (typeof parsed === "string") return text(error(parsed, 400), true);
						const kind = classify(parsed);
						if (kind === "blocked") return text(NOT_OPEN, true);
						if (kind === "destructive") return text(error("This one asks the person first: use ui_write_destructive.", 403), true);
						if (kind !== "write") return text(kind, true);
						const done = await write(agentId, parsed);
						return text(done.text, done.failed);
					},
				}),
				defineTool({
					name: "ui_audit",
					description: "The writes made through the app's routes, newest first: agent, method, path, status and the keys of the body.",
					parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: AUDIT_LIMIT, description: "How many, 50 unless given." })) }),
					async execute({ limit }, api) {
						if (majordomoOf(api.conversationId) === null) return text(REFUSED, true);
						return json({ writes: ui.audited(limit ?? 50) });
					},
				}),
			],
		};
	},
});
