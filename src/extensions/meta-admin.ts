import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { adminAsMajordomo, pimOrigin } from "../accounts";
import { defineGatedAction } from "./approvals";
import { definePimExtension } from "./define";
import { json, text } from "./services";

/**
 * The admin area of the app, for the admin's majordomo: `admin_read` and
 * `admin_write` call `/api/admin/*` (adminApi in ../accounts.ts), the same
 * handler the app uses, with a request built here. That handler opens to them
 * through `adminAsMajordomo`, which checks on the server that the caller is the
 * majordomo of the admin's space; being offered the tools only keeps them out
 * of other agents' prompts.
 *
 * Writes that can't be taken back, or that hand out or change credentials, are
 * not run by `admin_write`: they are `admin_write_approved`, which asks the
 * person with the exact request. Secrets (provider keys, the computer host's
 * token, invite codes and links, setup links) are taken out of every answer.
 * Every write is kept, with its method, path, status and the keys of its body,
 * for `admin_audit`.
 */

const AUDIT_PREFIX = "audit/";
const AUDIT_ROWS = 500;
const MAX_ANSWER_CHARS = 30_000;

type AuditRow = { at: string; method: string; path: string; status: number; bodyKeys: string[]; approved: boolean };

const SECRET_KEY = /token|secret|password|api_?key|^key$|credential|^codes?$|^links?$|setupurl/i;
const SECRET_VALUE = /#(invite|setup)=/;

/** A value with everything that is a secret taken out: by the name it is under, or by what it looks like. */
function redact(value: unknown): unknown {
	if (typeof value === "string") return SECRET_VALUE.test(value) ? "[redacted]" : value;
	if (Array.isArray(value)) return value.map(redact);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, SECRET_KEY.test(key) && inner !== null && typeof inner !== "boolean" ? "[redacted]" : redact(inner)]),
		);
	}
	return value;
}

/** Writes the admin must approve: every delete, the computer host's pairing, model providers, and credentials for someone's sign-in. */
export function needsApproval(method: string, path: string): boolean {
	if (method === "DELETE") return true;
	if (path === "/admin/computer-host" || path.startsWith("/admin/providers")) return true;
	return /^\/admin\/accounts\/[^/]+\/setup-link$/.test(path);
}

type Parsed = { method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | undefined };

/** The request a call describes, or what is wrong with it. */
function parse(method: string, given: string, query: unknown, body: unknown): Parsed | string {
	const path = given.startsWith("/admin") ? given : `/admin${given.startsWith("/") ? "" : "/"}${given}`;
	if (/[?#\\]/.test(path) || path.split("/").some((part) => part === "." || part === ".." || /^%2e/i.test(part))) {
		return "path must be like /admin/stats, with no query string: give query separately.";
	}
	if (path.endsWith("/")) return "path must not end in a slash.";
	if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) return "body must be a JSON object.";
	const params: Record<string, string> = {};
	for (const [key, value] of Object.entries((query ?? {}) as Record<string, unknown>)) params[key] = String(value);
	return { method, path, query: params, body: body as Record<string, unknown> | undefined };
}

const line = ({ method, path, body }: { method: string; path: string; body?: object }) => `${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`;
const error = (message: string, status: number) => JSON.stringify({ error: message, status });

const PROMPT = `You run the admin area of this Pim for the person, who is its admin, as the app's Admin pages do. admin_read gets (stats, accounts, accounts/<username>, sign-in, deployment, computer-host, default-agent, builtin-apps), and admin_write changes (POST invites, POST/PUT apps, PUT builtin-apps/<id>, PUT default-agent, accounts/<username>/suspend, unsuspend and limits). Paths are under /admin and take the same bodies as the app sends. Every DELETE, the computer host's pairing, model providers and setup links run only through admin_write_approved, which asks the person first and shows them the exact request. Secrets (provider keys, the computer host's token, invite codes and links, setup links) are never shown to you: tell the person to take them from Admin in the app. Every write is kept for admin_audit. Do only what the person asked.`;

export const metaAdmin = definePimExtension({
	id: "meta-admin",
	name: "Admin area",
	description: "The admin's majordomo reads and runs the app's Admin pages: accounts, deployment, providers, invites and the rest, with secrets left out.",
	ability: (context) => {
		const { space, conversationOf, data } = context;
		/** The agent's id when this conversation is the admin's majordomo's. */
		const majordomoOf = (session: unknown) => {
			const { agent } = conversationOf(String(session));
			return context.admin && agent.majordomo ? agent.id : null;
		};
		const REFUSED = error("Only the admin's majordomo can run the admin area.", 403);

		/** Calls the admin handler as `agentId`, and answers with what it said, secrets out. */
		async function call(agentId: string, { method, path, query, body }: Parsed) {
			const url = new URL(`/api${path}`, pimOrigin(env));
			for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
			const request = new Request(url, {
				method,
				headers: { "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const response = await adminAsMajordomo(env, space, agentId, request);
			const raw = await response.text();
			let answer: unknown = null;
			try {
				if (raw) answer = redact(JSON.parse(raw));
			} catch {
				answer = "[not JSON, left out]";
			}
			return { status: response.status, answer };
		}

		/** What the model reads of a call. */
		function render({ status, answer }: { status: number; answer: unknown }) {
			const failed = status >= 400;
			const body = JSON.stringify(failed ? { status, error: (answer as { error?: unknown } | null)?.error ?? answer } : { status, body: answer });
			return { text: body.length > MAX_ANSWER_CHARS ? `${body.slice(0, MAX_ANSWER_CHARS)} … [cut: ask for less with query]` : body, failed };
		}

		/** Runs a write and keeps it. */
		async function write(agentId: string, request: Parsed, approved: boolean) {
			const done = await call(agentId, request);
			const now = Date.now();
			const row: AuditRow = { at: new Date(now).toISOString(), method: request.method, path: request.path, status: done.status, bodyKeys: Object.keys(request.body ?? {}), approved };
			data.put(`${AUDIT_PREFIX}${String(now).padStart(15, "0")}-${crypto.randomUUID().slice(0, 8)}`, row);
			const keys = data.list(AUDIT_PREFIX).map((entry) => entry.key).sort();
			for (const key of keys.slice(0, Math.max(0, keys.length - AUDIT_ROWS))) data.delete(key);
			return render(done);
		}

		const writeParameters = Type.Object({
			method: Type.Union(["POST", "PUT", "PATCH", "DELETE"].map((method) => Type.Literal(method)), { description: "The HTTP method." }),
			path: Type.String({ description: "Under /admin, such as /admin/invites or /admin/accounts/ada/suspend." }),
			body: Type.Optional(Type.Object({}, { additionalProperties: true, description: "The JSON body the app sends." })),
		});

		return {
			offeredTo: (agent) => context.admin && agent.majordomo,
			actions: [
				defineGatedAction({
					name: "admin_write_approved",
					description:
						"A write to the admin area that can't be taken back or touches credentials: any DELETE, POST or DELETE /admin/computer-host, anything under /admin/providers, and an account's setup-link. Same arguments as admin_write. The person reads the exact request before it runs.",
					parameters: writeParameters,
					explicitApproval: true,
					summarize: ({ method, path, body }) => line({ method, path, body }),
					async prepare(args, { session }) {
						if (majordomoOf(session) === null) return { refused: REFUSED };
						const parsed = parse(args.method, args.path, undefined, args.body);
						if (typeof parsed === "string") return { refused: error(parsed, 400) };
						if (!needsApproval(parsed.method, parsed.path)) return { refused: error("This one needs no approval: use admin_write.", 400) };
						return { args: { method: parsed.method, path: parsed.path, ...(parsed.body === undefined ? {} : { body: parsed.body }) } as typeof args, summary: line(parsed) };
					},
					async run(args, { session }) {
						const agentId = majordomoOf(session);
						const parsed = parse(args.method, args.path, undefined, args.body);
						if (agentId === null) return REFUSED;
						if (typeof parsed === "string") return error(parsed, 400);
						return (await write(agentId, parsed, true)).text;
					},
				}),
			],
			sections: [section("admin_area", ({ conversationId }) => (majordomoOf(conversationId) === null ? undefined : PROMPT))],
			tools: [
				defineTool({
					name: "admin_read",
					description:
						"Reads the admin area, as the app's Admin pages do: GET /admin/stats, /accounts (query status, after, limit), /accounts/<username>, /sign-in, /deployment, /computer-host, /default-agent, /builtin-apps. Secrets are left out.",
					parameters: Type.Object({
						path: Type.String({ description: "Under /admin, such as /admin/stats." }),
						query: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Query parameters." })),
					}),
					async execute({ path, query }, api) {
						const agentId = majordomoOf(api.conversationId);
						if (agentId === null) return text(REFUSED, true);
						const parsed = parse("GET", path, query, undefined);
						if (typeof parsed === "string") return text(error(parsed, 400), true);
						const done = render(await call(agentId, parsed));
						return text(done.text, done.failed);
					},
				}),
				defineTool({
					name: "admin_write",
					description:
						"Changes the admin area, as the app's Admin pages do. Writes that can't be taken back or touch credentials (DELETE, computer-host, providers, setup-link) are refused here: use admin_write_approved. Every write is kept for admin_audit.",
					parameters: writeParameters,
					async execute({ method, path, body }, api) {
						const agentId = majordomoOf(api.conversationId);
						if (agentId === null) return text(REFUSED, true);
						const parsed = parse(method, path, undefined, body);
						if (typeof parsed === "string") return text(error(parsed, 400), true);
						if (needsApproval(parsed.method, parsed.path)) return text(error("This one asks the person first: use admin_write_approved.", 403), true);
						const done = await write(agentId, parsed, false);
						return text(done.text, done.failed);
					},
				}),
				defineTool({
					name: "admin_audit",
					description: "The writes made to the admin area through admin_write and admin_write_approved, newest first: method, path, status and the keys of the body.",
					parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: AUDIT_ROWS, description: "How many, 50 unless given." })) }),
					async execute({ limit }, api) {
						if (majordomoOf(api.conversationId) === null) return text(REFUSED, true);
						const rows = data.list<AuditRow>(AUDIT_PREFIX).sort((a, b) => (a.key < b.key ? 1 : -1));
						return json({ writes: rows.slice(0, limit ?? 50).map((row) => row.value) });
					},
				}),
			],
		};
	},
});
