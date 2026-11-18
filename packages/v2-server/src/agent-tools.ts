/**
 * The tools of a Pim agent on the portable stack, as one extension (`pim`) built for one partition's owner: the owner is fixed by the partition, so a tool can only
 * act for the person whose space it runs in. What a tool writes goes through the application's services (`@pim/v2-app`), whose Authorizer decides each call for the agent
 * principal (or, in a delegated task's chat, for the principal that started the chain). Coding goes through Forge. A tool whose service this Runner was not given answers
 * with what is missing instead of failing the turn.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type PromptSection, type ToolRegistration } from "@earendil-works/pi-durable";
import { QUOTA_MESSAGE } from "@pim/v2-app/quota";
import type { App } from "@pim/v2-app/app";
import { OwnerId, PartitionId, type Principal } from "@pim/v2-contracts/identity";
import { ExternalOperations } from "@pim/v2-runtime/external";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import type { Actor } from "@pim/v2-forge/authz";
import type { RelayBus } from "@pim/v2-app/relay";
import { postToRoom } from "./rooms.ts";
import { computerTools } from "./computer-tools.ts";
import { type ImageSources, imageTools } from "./image-tools.ts";
import type { ForgeParts } from "./forge-assembly.ts";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import { uiBlockReference } from "@pim/ui-lang";
import { loadWidgets, MAX_WIDGETS, type ShownWidget, uiDiagnostics, widgetRefs } from "./agent-widgets.ts";
import { connectorToolset, type Transport } from "./connector-tools.ts";
import { watchTools } from "./watch-tools.ts";
import { builtinSkill } from "./builtin-skills.ts";
import { readSkillFolder } from "./skill-sources.ts";
import { adminTools } from "./admin-tools.ts";
import { disabledBuiltins } from "./compat/admin-directory.ts";
import { textDigest } from "./compat/admin-util.ts";
import { guestToolset } from "./guest-tools.ts";

export type ToolDeps = {
	ownerId: string;
	partitionId: string;
	runtime: RuntimeDb;
	app: App | undefined;
	forge: ForgeParts | undefined;
	/** The Relay's bus, made when first needed: how the computer, browser and desktop tools reach the owner's paired computer. */
	relay?: (() => Promise<RelayBus>) | undefined;
	fetch: typeof fetch;
	now: () => number;
	/** The deployment's keys, which open a connector's sealed credential; and whether a connector may live at a private address. */
	crypto?: EnvelopeCrypto | undefined;
	allowPrivateConnectors?: boolean | undefined;
	/** The longest a tool may run before its call ends with an error instead of holding the chat; default 10 minutes. */
	toolTimeoutMs?: number | undefined;
	/** Where images can be drawn (`./image-tools.ts`); absent leaves `generate_image` out, as `PIM_IMAGE_MODEL=off` does. */
	images?: ImageSources | undefined;
	/** The public id of the chat that a pi conversation is. */
	chatOf(conversationId: number | string): Promise<string | null>;
};

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });
const json = (v: unknown): Result => text(JSON.stringify(v, null, 1));

const MAX_BODY = 100_000;
const MAX_REQUEST_MS = 20_000;

/** Whether an address is one an agent may not reach: loopback, private, link-local and the like. */
function privateAddress(address: string): boolean {
	if (isIP(address) === 6) {
		const a = address.toLowerCase();
		return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80") || (a.startsWith("::ffff:") && privateAddress(a.slice(7)));
	}
	const [a = 0, b = 0] = address.split(".").map(Number);
	return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function publicUrl(raw: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("That is not a web address");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses can be fetched");
	if (url.username || url.password) throw new Error("An address with credentials in it is refused");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
	if (addresses.length === 0 || addresses.some(privateAddress)) throw new Error("That address is not on the public internet");
	return url;
}

async function readBody(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_BODY) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.length;
	}
	await reader.cancel().catch(() => {});
	return Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8");
}

const REDACT = /^(authorization|cookie|x-api-key|proxy-authorization)$/i;
const redactHeaders = (headers: Record<string, string> | undefined) => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, REDACT.test(k) ? "[redacted]" : v]));

/** The person's time zone (Settings), else the deployment's `PIM_TIME_ZONE`, else UTC. */
export async function timeZoneOf(runtime: RuntimeDb, ownerId: string): Promise<string> {
	const chosen = await runtime.read<{ z: string | null }>(ownerId, "SELECT pim_app.runner_time_zone($1) AS z", [ownerId]).then((r) => r.rows[0]?.z ?? null, () => null);
	return chosen ?? process.env.PIM_TIME_ZONE ?? "UTC";
}

/** What the web app reads from an app tool's answer to show the app as a card in the chat that opens in the canvas: `{ artifact }`, an app with a backend being `hosted` there. */
const appCard = (ref: { id: string; title: string; kind: string; version: number; sha256: string; size: number }, note: string): Result =>
	text(JSON.stringify({ artifact: { id: ref.id, title: ref.title, kind: ref.kind === "backend" ? "hosted" : ref.kind, version: ref.version, sha256: ref.sha256, size: ref.size }, note }));

/** What the web app reads from a note tool's answer to show the note as a card in the chat that opens it beside the chat: `{ artifact }`, the same shape as an app's, of kind `markdown`. */
const noteCard = async (app: App, ownerId: string, id: string, note: string): Promise<Result> => {
	await app.canvas.keep(ownerId, id, "person");
	const [{ text: body, version }, row] = await Promise.all([app.canvas.read(ownerId, id), app.db.owner(ownerId, async (tx) => (await tx.query("SELECT title FROM pim_app.notes WHERE note_id = $1 AND deleted_at IS NULL", [id])).rows[0])]);
	return text(JSON.stringify({ artifact: { id, title: String(row?.title ?? ""), kind: "markdown", version, sha256: textDigest(body), size: Buffer.byteLength(body) }, note }));
};

/** How an app runs, for the agent that writes one (the same words as v1's). */
const HOW_APPS_RUN =
	"An HTML app is a page, index.html: put its CSS in <style> and its JavaScript in <script>, or in files of its own. It runs in a sandbox: fetch, forms, anything from the web (scripts, stylesheets, fonts, images), cookies, localStorage and alert() are blocked, so images must be inline (data: URLs or SVG) or files of its own. It shows in the chat and on a full screen, including on phones, so make it responsive. " +
	"Any app can use window.pim, whose calls return promises and can fail: pim.storage.get(key), .set(key, text), .delete(key) and .list(prefix) keep text that stays across visits and new versions (up to 1 MB; JSON.stringify anything else); " +
	"pim.shared has the same calls, for text everyone the user shares the app with sees and changes; pim.ask(prompt) answers with text from Pim's model, which has no tools and sees only the prompt; " +
	"pim.tools.call(name, input) runs one of the user's connector tools that runs without asking, by its tool name, and answers with its result as text. " +
	"The user is asked once per version before ask or a tool first runs; tools that ask before they run can't be used. Show a message when a call fails. " +
	"A jsx app is a React app, App.jsx: `export default function App() { ... }`, with hooks from \"react\"; it may import \"react\", \"recharts\", \"lucide-react\" and its own files, is styled with Tailwind classes, and is compiled when you save it: a compile error comes back to you to fix. ";

/**
 * Makes a tool stoppable: its call ends when the chat is stopped (the abort signal) even if the tool's own work ignores it, and with an error after `timeoutMs` instead of
 * never, so a hung connection or process cannot leave a chat busy for ever. The work itself is not cancelled, only abandoned; a tool that can cancel it still should.
 */
export function stoppable(tool: ToolRegistration, timeoutMs = 600_000): ToolRegistration {
	const execute = (tool as any).execute as (args: any, api: any, context: any) => Promise<Result>;
	return {
		...(tool as object),
		execute: (args: any, api: any, context: any) =>
			new Promise<Result>((resolve, reject) => {
				const signal: AbortSignal | undefined = context?.abortSignal;
				const stop = () => reject(signal?.reason ?? new Error("The call was stopped"));
				if (signal?.aborted) return stop();
				const timer = setTimeout(() => resolve(text(`${(tool as any).name} did not finish within ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`, true)), timeoutMs);
				signal?.addEventListener("abort", stop, { once: true });
				execute(args, api, context).then(resolve, reject).finally(() => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", stop);
				});
			}),
	} as ToolRegistration;
}

/** What a guest's agent, and a bot's visitor's chat in the host's space, may use: its own memory and the clock, and a guest's calls to the host's shared tools. */
const GUEST_TOOLS = new Set(["send_to_user", "current_time", "note", "recall", "zoom", "forget", "move_memory", "read_skill", "read_skill_file", "guest_tools", "guest_call"]);
const VISIT_TOOLS = new Set(["send_to_user", "current_time"]);
const kinds = new Map<string, { at: number; allowed: Set<string> | null }>();

/** The tools a chat is limited to, or null when it has all of its owner's. Read fresh each half minute, so a role change or a deleted chat takes effect soon. */
async function toolsAllowed(app: App, ownerId: string, chat: string | null): Promise<Set<string> | null> {
	const key = `${ownerId}\u0000${chat ?? ""}`;
	const held = kinds.get(key);
	if (held && Date.now() - held.at < 30_000) return held.allowed;
	const row = await app.db.owner(ownerId, async (tx) => ({
		role: (await tx.query("SELECT role FROM pim_app.accounts WHERE owner_id = $1", [ownerId])).rows[0]?.role as string | undefined,
		kind: chat ? ((await tx.query("SELECT kind FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0]?.kind as string | undefined) : undefined,
	}));
	const allowed = row.role === "guest" ? GUEST_TOOLS : row.kind === "visit" ? VISIT_TOOLS : null;
	if (kinds.size > 5000) kinds.clear();
	kinds.set(key, { at: Date.now(), allowed });
	return allowed;
}

export function pimExtension(deps: ToolDeps, sections: PromptSection[]) {
	const { ownerId, partitionId, runtime } = deps;
	const owner = OwnerId.parse(ownerId);
	const ops = new ExternalOperations(runtime);
	const principals = new Map<string, Promise<Principal>>();
	const noApp = () => text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot do that.", true);
	const noForge = () => text("Coding is not available here: this Runner has no coding database (PIM_FORGE_DATABASE_URL).", true);

	/** The agent that is answering in a chat, as the Authorizer knows it; in a delegated task's chat, the principal that started the chain. */
	const principalOf = (app: App, chat: string | null): Promise<Principal> => {
		const key = chat ?? "";
		let held = principals.get(key);
		if (!held) {
			held = (async (): Promise<Principal> => {
				if (!chat) return { kind: "agent", ownerId: owner, agentId: "pim" };
				const row = await app.db.owner(ownerId, async (tx) => ({
					task: (await tx.query("SELECT task_id FROM pim_app.tasks WHERE task_chat = $1", [chat])).rows[0]?.task_id as string | undefined,
					agent: (await tx.query("SELECT agent_id FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0]?.agent_id as string | null | undefined,
				}));
				return row.task ? app.conversations.taskPrincipal(ownerId, row.task) : { kind: "agent", ownerId: owner, agentId: row.agent ?? "pim" };
			})();
			principals.set(key, held);
			held.catch(() => principals.delete(key));
		}
		return held;
	};

	type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
	/** A tool that needs the application: it gets the services and the principal of the chat it runs in. */
	const withApp = (run: (app: App, call: Call, args: any) => Promise<Result>) =>
		async (args: any, api: any, context: any): Promise<Result> => {
			const app = deps.app;
			if (!app) return noApp();
			try {
				const chat = await deps.chatOf(api.conversationId);
				const p = await principalOf(app, chat);
				const agentId = p.kind === "agent" ? (p.agentId === "pim" ? null : p.agentId) : null;
				return await run(app, { chat, p, api, agentId, context }, args);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		};
	const tool = (name: string, description: string, parameters: any, execute: (args: any, api: any, context: any) => Promise<Result>, replay: "safe" | "unsafe" = "unsafe") =>
		defineTool({ name, description, parameters, replay, execute } as never) as ToolRegistration;
	const read = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => tool(name, description, parameters, withApp(run), "safe");
	const write = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => tool(name, description, parameters, withApp(run), "unsafe");

	const S = Type.String;
	const O = Type.Optional;
	const strings = Type.Array(Type.String());
	const anyObject = Type.Record(Type.String(), Type.Any());
	const files = Type.Record(Type.String(), Type.String());
	const scopeOf = (call: Call, scope?: string) => scope ?? (call.agentId ? `agent-${call.agentId}` : "everyone");

	const tools: ToolRegistration[] = [
		tool(
			"send_to_user",
			`Send the person a message. It is the only way they see anything you write: the rest of your text is private working notes. Set complete when you are finishing a delegated task. To draw a small interactive piece, such as a quiz, a checklist or a form, put a \`\`\`ui block in the message, alone on its lines; it is not JSON. ${uiBlockReference()} A block that can't be drawn refuses the message with what to fix. widgets shows data under the message, by name, up to ${MAX_WIDGETS}: ${widgetRefs().join(", ")}.`,
			Type.Object({ message: S({ minLength: 1 }), complete: O(Type.Boolean()), widgets: O(Type.Array(Type.String(), { maxItems: MAX_WIDGETS })) }),
			async (args, api) => {
				const app = deps.app;
				const wanted = [...new Set<string>(args.widgets ?? [])];
				const unknown = wanted.filter((ref) => !widgetRefs().includes(ref));
				if (unknown.length > 0) return text(`Not sent: ${unknown.join(", ")} ${unknown.length === 1 ? "isn't a widget" : "aren't widgets"} you can show. The widgets you can show here: ${widgetRefs().join(", ")}.`, true);
				// A block it wrote wrong is a mistake the model can fix: say what the compiler found and send nothing.
				const ui = uiDiagnostics(String(args.message));
				if (ui.error !== undefined) return text(`Not sent: ${ui.error}.`, true);
				const chat = await deps.chatOf(api.conversationId);
				let shown: ShownWidget[] = [];
				if (app && chat) {
					try {
						// An agent in a group chat speaks into the host chat, where the person reads it; its own seat is not a chat they open.
						const p = await principalOf(app, chat);
						const posted = await postToRoom(app, p, chat, `${api.taskId}:${api.callId}`, String(args.message));
						if (!posted) await app.conversations.markResponse(ownerId, chat);
						if (args.complete && p.kind === "delegated") await app.conversations.updateTask(p, p.delegateId, "completed", String(args.message).slice(0, 2000));
						// Loaded once, as sent: the message and what it shows stay together, and the model is told what the person saw.
						if (wanted.length > 0) shown = await loadWidgets(app, p, p.kind === "agent" && p.agentId !== "pim" ? p.agentId : null, wanted);
					} catch (error) {
						return text(`Not sent: ${error instanceof Error ? error.message : String(error)}`, true);
					}
				}
				const result = { sent: "Sent.", ...(shown.length > 0 ? { widgets: shown } : {}) };
				return text(Object.keys(result).length === 1 ? "Sent." : JSON.stringify(result));
			},
			"safe",
		),
		tool("current_time", "The current date and time, in UTC and in the user's time zone.", Type.Object({}), async () => {
			const now = new Date(deps.now());
			const zone = await timeZoneOf(runtime, ownerId);
			return json({ utc: now.toISOString(), timeZone: zone, local: now.toLocaleString("en-US", { timeZone: zone, dateStyle: "full", timeStyle: "long" }) });
		}, "safe"),

		// Memory.
		write("note", "Save something to remember: a title and the text. It goes to your own memory unless you give a scope such as everyone.", Type.Object({ title: S({ minLength: 1 }), body: S({ minLength: 1 }), scope: O(S()) }), async (app, call, a) =>
			text(`Remembered as ${await app.memories.remember(call.p, scopeOf(call, a.scope), a.title, a.body)}.`)),
		read("recall", "Search your memory with a regular expression (case-insensitive) over titles and text.", Type.Object({ pattern: S({ minLength: 1 }), scope: O(S()), limit: O(Type.Integer({ minimum: 1, maximum: 50 })) }), async (app, call, a) => {
			const scopes = a.scope ? [a.scope] : [...new Set([scopeOf(call), "everyone"])];
			const found = await app.memories.recall(call.p, scopes, a.pattern, a.limit ?? 20);
			return text(found.length ? found.map((m) => `[${m.id}] (${m.scope}) ${m.title}`).join("\n") : "Nothing matches.");
		}),
		read("zoom", "Read a memory in full, or a block of its lines.", Type.Object({ id: S(), start: O(Type.Integer({ minimum: 1 })), count: O(Type.Integer({ minimum: 1, maximum: 400 })) }), async (app, call, a) => {
			const z = await app.memories.zoom(call.p, a.id, a.start ?? 1, a.count ?? 40);
			return text(`${z.lines.join("\n")}\n(${z.total} lines in all)`);
		}),
		write("forget", "Forget a memory.", Type.Object({ id: S() }), async (app, call, a) => (await app.memories.forget(call.p, a.id), text("Forgotten."))),
		write("move_memory", "Move a memory to another scope, such as everyone or another agent's.", Type.Object({ id: S(), scope: S() }), async (app, call, a) => (await app.memories.move(call.p, a.id, a.scope), text(`Moved to ${a.scope}.`))),

		// Skills and goals.
		read("read_skill", "Read a skill's instructions and the names of its files: one of the person's own, or one that comes with Pim.", Type.Object({ name: S() }), async (app, call, a) => {
			const s = await app.agents.getSkill(call.p, a.name).catch((error) => {
				if (builtinSkill(a.name)) return undefined;
				throw error;
			});
			if (!s) return text(`${builtinSkill(a.name)!.instructions}\n\nFiles: none`);
			return text(`${s.body}\n\nFiles: ${Object.keys(s.files ?? {}).join(", ") || "none"}`);
		}),
		read("read_skill_file", "Read one of a skill's supporting files.", Type.Object({ name: S(), path: S() }), async (app, call, a) => {
			const file = ((await app.agents.getSkill(call.p, a.name)).files ?? {})[a.path];
			return file === undefined ? text(`${a.name} has no file ${a.path}.`, true) : text(file);
		}),
		write("write_skill", "Create a skill, or save a new version of it: a name, what it is for, instructions, and supporting files by path.", Type.Object({ name: S(), description: O(S()), body: O(S()), files: O(files) }), async (app, call, a) => {
			const exists = await app.agents.getSkill(call.p, a.name).then(() => true, () => false);
			await (exists ? app.agents.updateSkill(call.p, a.name, { description: a.description, body: a.body, files: a.files }) : app.agents.createSkill(call.p, { name: a.name, description: a.description, body: a.body, files: a.files }));
			return text(exists ? `Saved a new version of ${a.name}.` : `Created ${a.name}.`);
		}),
		tool("install_skill", "Install a skill from a GitHub folder (https://github.com/owner/repo/tree/ref/path, holding a SKILL.md and any files it uses). A person approves it first, with the files it holds listed; what is installed is exactly what they approved, at the commit the folder is at now.", Type.Object({ source: S({ minLength: 1 }), name: O(S()) }),
			async (args, api) => {
				const app = deps.app;
				if (!app) return noApp();
				const taskId = String(api.taskId);
				try {
					const folder = await readSkillFolder(deps.fetch, args.source);
					const chat = await deps.chatOf(api.conversationId);
					const p = await principalOf(app, chat);
					const name = args.name ?? folder.name;
					const signal = (await runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
					if (signal && signal.payload.approved !== true) return text("A person did not approve this skill, so it was not installed.", true);
					const filed = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, args FROM pim_app.approvals WHERE tool = 'skill:install' AND args->>'taskId' = $1 LIMIT 1", [taskId])).rows[0])) as { id: string; args: { commit?: string; hashes?: Record<string, string> } } | undefined;
					if (!signal && !filed) {
						const names = Object.keys(folder.hashes);
						const summary = `Install the skill ${name} from ${folder.source}: ${names.length} file${names.length === 1 ? "" : "s"} (${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""})`;
						const gate = await app.approvals.gate(p, { action: "skill:install", resource: { source: folder.source.replace(/\/tree\/.*$/, "") }, ...(chat ? { chatId: chat } : {}), args: { taskId, callId: api.callId, source: folder.source, commit: folder.commit, name, hashes: folder.hashes, summary }, timeoutMs: 24 * 3600_000, onTimeout: "deny", explicit: true });
						if (gate.outcome === "waiting") return { content: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
					} else if (!signal) {
						return { content: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
					}
					// What was approved is what is installed: the folder read again must be the one the person was shown.
					if (filed?.args.hashes && JSON.stringify(Object.entries(filed.args.hashes).sort()) !== JSON.stringify(Object.entries(folder.hashes).sort())) return text("The skill's files are not the ones that were approved, so it was not installed. Ask again to see them.", true);
					const files = { ...folder.files, ".source": JSON.stringify({ source: folder.source, commit: folder.commit }) };
					const exists = await app.agents.getSkill(p, name).then(() => true, () => false);
					await (exists ? app.agents.updateSkill(p, name, { description: folder.description, body: folder.body, files }) : app.agents.createSkill(p, { name, description: folder.description, body: folder.body, files }));
					return text(`${exists ? "Saved a new version of" : "Installed"} the skill ${name} from ${folder.source}.`);
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			}, "safe"),
		write("create_goal", "Start a goal, with the steps to reach it.", Type.Object({ title: S({ minLength: 1 }), steps: O(strings) }), async (app, call, a) => text(`Created goal ${await app.memories.createGoal(call.p, a.title, a.steps ?? [])}.`)),
		write("update_goal", "Change a goal: its title, its status (active, done, dropped) or its steps; or tick a step off with complete_step (its position, from 0).", Type.Object({ id: S(), title: O(S()), status: O(Type.Union([Type.Literal("active"), Type.Literal("done"), Type.Literal("dropped")])), steps: O(strings), complete_step: O(Type.Integer({ minimum: 0 })) }), async (app, call, a) => {
			if (a.title !== undefined || a.status !== undefined || a.steps !== undefined) await app.memories.updateGoal(call.p, a.id, { title: a.title, status: a.status, steps: a.steps });
			if (a.complete_step !== undefined) return text((await app.memories.completeStep(call.p, a.id, a.complete_step)).goalDone ? "Step done; the goal is done." : "Step done.");
			return text("Updated.");
		}),
		read("list_goals", "Your goals and their steps.", Type.Object({}), async (app, call) => json(await app.memories.listGoals(call.p))),

		// Schedules and triggers.
		write("schedule_task", "Run a prompt later: kind cron (spec is a 5-field cron expression, in UTC), at (spec is a date and time) or delay (spec is milliseconds). target is new_chat (default) or this chat.", Type.Object({ kind: Type.Union([Type.Literal("cron"), Type.Literal("at"), Type.Literal("delay")]), spec: S(), prompt: S({ minLength: 1 }), target: O(Type.Union([Type.Literal("new_chat"), Type.Literal("same_chat")])) }), async (app, call, a) =>
			text(`Scheduled ${await app.schedules.create(call.p, { kind: a.kind, spec: a.spec, prompt: a.prompt, target: a.target ?? "new_chat", ...(call.chat ? { chatId: call.chat } : {}), ...(call.agentId ? { agentId: call.agentId } : {}) })}.`)),
		read("list_scheduled_tasks", "Your scheduled tasks.", Type.Object({}), async (app, call) => json(await app.schedules.list(call.p))),
		write("cancel_scheduled_task", "Cancel a scheduled task.", Type.Object({ id: S() }), async (app, call, a) => (await app.schedules.remove(call.p, a.id), text("Cancelled."))),
		write("create_trigger", "Create a trigger: the spec says what starts a turn (a time, a connector's event, a computer's file or process) and what to do. It starts as a draft; resume_trigger enables it.", Type.Object({ spec: anyObject }), async (app, call, a) => {
			const t = await app.triggers.create(call.p, { spec: { ...(call.chat ? { originChatId: call.chat } : {}), ...(call.agentId ? { owningAgentId: call.agentId } : {}), ...a.spec } });
			return json({ id: t.id, lifecycle: t.lifecycle, label: t.label });
		}),
		write("update_trigger", "Replace a trigger's spec.", Type.Object({ id: S(), spec: anyObject }), async (app, call, a) => {
			const t = await app.triggers.update(call.p, a.id, { spec: { ...(call.chat ? { originChatId: call.chat } : {}), ...(call.agentId ? { owningAgentId: call.agentId } : {}), ...a.spec } });
			return json({ id: t.id, lifecycle: t.lifecycle, label: t.label });
		}),
		read("list_triggers", "Your triggers.", Type.Object({ lifecycle: O(S()) }), async (app, call, a) => json((await app.triggers.list(call.p, { lifecycle: a.lifecycle })).map((t) => ({ id: t.id, lifecycle: t.lifecycle, label: t.label })))),
		read("get_trigger", "One trigger with its spec and its latest runs.", Type.Object({ id: S() }), async (app, call, a) => json({ trigger: await app.triggers.get(call.p, a.id), runs: await app.triggers.runs(call.p, a.id, 10) })),
		write("pause_trigger", "Pause a trigger.", Type.Object({ id: S() }), async (app, call, a) => text(`Now ${(await app.triggers.setLifecycle(call.p, a.id, "paused")).lifecycle}.`)),
		write("resume_trigger", "Enable a trigger, or start one that is paused. A time trigger counts from now.", Type.Object({ id: S() }), async (app, call, a) => text(`Now ${(await app.triggers.setLifecycle(call.p, a.id, "enabled")).lifecycle}.`)),
		write("delete_trigger", "Delete a trigger.", Type.Object({ id: S() }), async (app, call, a) => (await app.triggers.setLifecycle(call.p, a.id, "deleted"), text("Deleted."))),
		read("test_trigger", "A dry run, changing nothing and running nothing: whether a trigger (by id, or as you would make it with trigger) is valid, what would stop it being enabled, a time source's next firings, or what its condition says of each sample.", Type.Object({ id: O(S()), trigger: O(anyObject), samples: O(Type.Array(anyObject, { maxItems: 10 })), count: O(Type.Integer({ minimum: 1, maximum: 20 })) }), async (app, call, a) => json(await app.triggers.test(call.p, a.id ?? null, { ...(a.count ? { count: a.count } : {}), ...(a.trigger ? { spec: { ...(call.chat ? { originChatId: call.chat } : {}), ...(call.agentId ? { owningAgentId: call.agentId } : {}), ...a.trigger } } : {}), ...(a.samples ? { samples: a.samples } : {}) }))),
		read("list_trigger_runs", "A trigger's runs, newest first, with what is known of each.", Type.Object({ id: S(), limit: O(Type.Integer({ minimum: 1, maximum: 50 })) }), async (app, call, a) => json(await app.triggers.runs(call.p, a.id, a.limit))),
		read("list_trigger_sources", "What a trigger can watch here: each kind of source, and whether it can run now.", Type.Object({}), async (app, call) => {
			const paired = !!(await app.db.owner(call.p.ownerId, (tx) => tx.query("SELECT 1 FROM pim_app.computers WHERE revoked_at IS NULL LIMIT 1"))).rowCount;
			const draft = (reason: string) => ({ status: "draft_only", delivers: false, reason });
			return json({ sources: [
				{ kind: "time", status: "available", delivers: true, reason: null },
				{ kind: "connector_event", status: "available", delivers: true, reason: null },
				{ kind: "file", status: "unavailable", delivers: false, reason: "not_wired" },
				...["poll", "stream", "process"].map((kind) => ({ kind, ...draft(paired ? "not_wired" : "computer_not_paired") })),
			] });
		}),

		// Notes and apps.
		write("note_create", "Create a note a person can open and edit alongside you. The answer is the note's card in the chat, which is how the person sees and opens it; there is no panel for you to open.", Type.Object({ title: S({ minLength: 1 }), text: O(S()) }), async (app, call, a) =>
			noteCard(app, ownerId, await app.canvas.create(call.p, a.title, a.text ?? "", "agent"), "Made it. The person sees it as a card in the chat and opens it beside the chat.")),
		read("note_read", "Read a note: its text and its version.", Type.Object({ id: S() }), async (app, call, a) => {
			await app.canvas.keep(ownerId, a.id, "person");
			const n = await app.canvas.read(ownerId, a.id);
			return text(`version ${n.version}\n${n.text}`);
		}),
		write("note_edit", "Edit a note by replacing text. base_version is the version you read; if the note changed since, nothing is changed and you read it again. A person's typing is never lost. The answer is the note's card in the chat, which is how the person sees and opens it; you can't open a panel, so don't say you did.", Type.Object({ id: S(), base_version: Type.Integer({ minimum: 0 }), find: S({ minLength: 1 }), replace: S() }), async (app, call, a) => {
			const { version } = await app.canvas.edit(call.p, a.id, a.base_version, a.find, a.replace);
			return noteCard(app, ownerId, a.id, `Saved version ${version}. The person sees the card in the chat and opens the note from it.`);
		}),
		read("note_show", "Show the person a note that already exists, such as one from another chat or the one they asked you to open, as the card in this chat that opens it beside the chat. It changes nothing. Find its id with note_list.", Type.Object({ id: S() }), async (app, _call, a) => noteCard(app, ownerId, a.id, "Showed it. The person sees the card in the chat and opens the note from it.")),
		read("note_list", "Your notes.", Type.Object({}), async (app) => json((await app.db.owner(ownerId, (tx) => tx.query("SELECT note_id, title, kept_version AS version FROM pim_app.notes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200"))).rows)),
		write("app_create", `Create an app: kind html or jsx, or backend (with a pim.app.json). Files are by path. ${HOW_APPS_RUN}`, Type.Object({ title: S({ minLength: 1 }), kind: Type.Union([Type.Literal("html"), Type.Literal("jsx"), Type.Literal("backend")]), files, message: O(S()) }), async (app, call, a) => appCard(await app.apps.create(call.p, { title: a.title, kind: a.kind, files: a.files, message: a.message }), "Made it. The person sees it in the chat and opens it beside the chat.")),
		write("app_update", "Change an app. base_version is the version you read; an app that changed since is refused.", Type.Object({ id: S(), base_version: Type.Integer({ minimum: 1 }), title: O(S()), files: O(files), delete_files: O(strings), edits: O(Type.Array(Type.Object({ path: O(S()), find: S(), replace: S() }))), message: O(S()) }), async (app, call, a) =>
			appCard(await app.apps.update(call.p, a.id, { baseVersion: a.base_version, title: a.title, files: a.files, deleteFiles: a.delete_files, edits: a.edits, message: a.message }), "Saved. The person sees the new version in the chat.")),
		read("app_show", "Show the person an app that already exists, such as one made in another chat, as the card in this chat that opens it beside the chat: the latest version, or the one asked for. It changes nothing; don't make a new version just to show one. Find its id with app_list.", Type.Object({ id: S(), version: O(Type.Integer({ minimum: 1 })) }), async (app, call, a) => appCard(await app.apps.read(call.p, a.id, { version: a.version, path: undefined, offset: undefined }), "Showed it. The person sees it in the chat.")),
		read("app_read", "Read an app: its files, or one file.", Type.Object({ id: S(), version: O(Type.Integer({ minimum: 1 })), path: O(S()), offset: O(Type.Integer({ minimum: 0 })) }), async (app, call, a) => json(await app.apps.read(call.p, a.id, { version: a.version, path: a.path, offset: a.offset }))),
		read("app_list", "Your apps.", Type.Object({ query: O(S()) }), async (app, call, a) => json(await app.apps.list(call.p, a.query ?? ""))),

		// The web.
		tool("fetch_url", "Read a web page or file with an HTTP GET. Public addresses only.", Type.Object({ url: S() }), async (args) => {
			try {
				const url = await publicUrl(args.url);
				const response = await deps.fetch(url, { signal: AbortSignal.timeout(MAX_REQUEST_MS), redirect: "manual", headers: { "user-agent": "Pim/2" } });
				if (response.status >= 300 && response.status < 400) return text(`Redirected (${response.status}) to ${response.headers.get("location") ?? "somewhere"}. Fetch that address instead if you want it.`);
				return text(`${response.status} ${response.headers.get("content-type") ?? ""}\n${await readBody(response)}`, !response.ok);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		}, "safe"),
		tool("http_request", "Make an HTTP request that may change something elsewhere (POST, PUT, PATCH, DELETE). A person approves it first, unless they have said it may go ahead. It is sent once: if its outcome cannot be known, it is not sent again.", Type.Object({ method: Type.Union(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map((m) => Type.Literal(m))), url: S(), headers: O(Type.Record(Type.String(), Type.String())), body: O(S()) }),
			async (args, api) => {
				const app = deps.app;
				if (!app) return noApp();
				const taskId = String(api.taskId);
				try {
					const url = await publicUrl(args.url);
					const chat = await deps.chatOf(api.conversationId);
					const p = await principalOf(app, chat);
					// The decision: a person's, delivered as a signal that wakes this task; or a standing approval, which stands in for it.
					const signal = (await runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
					if (signal && signal.payload.approved !== true) return text("A person did not approve this request, so it was not sent.", true);
					if (!signal) {
						const filed = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.approvals WHERE tool = 'http:request' AND args->>'taskId' = $1 LIMIT 1", [taskId])).rows[0]?.id as string | undefined);
						if (filed) return { content: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
						const gate = await app.approvals.gate(p, { action: "http:request", resource: { host: url.host, method: args.method }, ...(chat ? { chatId: chat } : {}), args: { taskId, callId: api.callId, method: args.method, url: url.href, headers: redactHeaders(args.headers), body: typeof args.body === "string" ? args.body.slice(0, 2000) : undefined }, timeoutMs: 24 * 3600_000, onTimeout: "deny" });
						if (gate.outcome === "waiting") return { content: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
					}
					// The request itself, once: its outcome is on the operation, so a replay or a new owner finds it there, and one that was in flight is reconciled, not sent again.
					const operationId = `http:${partitionId}:${taskId}`;
					const op = await ops.begin({ operationId, ownerId: owner, partitionId: PartitionId.parse(partitionId), taskId, toolName: "http_request", capability: "http", idempotencyKey: `pim-${ownerId}-${partitionId}-${taskId}` });
					if (op.state === "completed") return text(String((op.receipt as any)?.summary ?? "Done."));
					if (op.state === "failed" || op.state === "cancelled") return text(`The request did not go through: ${String((op.receipt as any)?.error ?? op.state)}`, true);
					if (op.state !== "pending") return text(`The request was started, but what became of it is not known (${op.state}). It was not sent again; check with the other service before asking again.`, true);
					await ops.transition(ownerId, operationId, "running");
					const idempotent = args.method === "GET" || args.method === "HEAD";
					try {
						const response = await deps.fetch(url, { method: args.method, headers: { ...(args.headers ?? {}), ...(idempotent ? {} : { "idempotency-key": op.idempotencyKey }) }, ...(args.body !== undefined && !idempotent ? { body: args.body } : {}), signal: AbortSignal.timeout(MAX_REQUEST_MS), redirect: "manual" });
						const body = await readBody(response);
						const summary = `${response.status} ${response.headers.get("content-type") ?? ""}\n${body}`;
						await ops.transition(ownerId, operationId, "completed", { status: response.status, summary });
						return text(summary, response.status >= 400);
					} catch (error) {
						// It may have reached the other side. A read is just asked again later; anything else waits for a person to check.
						await ops.transition(ownerId, operationId, idempotent ? "failed" : "needs_reconciliation", { error: error instanceof Error ? error.message : String(error) });
						return text(idempotent ? `The request failed: ${error instanceof Error ? error.message : String(error)}` : `The request may or may not have reached the other service (${error instanceof Error ? error.message : String(error)}). It was not sent again; check with that service before asking again.`, true);
					}
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			}, "safe"),

		// Delegation and agents.
		write("delegate", "Hand a task to another agent (or yourself) in a chat of its own. Its progress and answer come back to you as [Task update] messages. Pass agent_id to choose who does it.", Type.Object({ title: S({ minLength: 1 }), text: S({ minLength: 1 }), agent_id: O(S()) }), async (app, call, a) => {
			if (!call.chat) return text("There is no chat to delegate from.", true);
			const admission = await app.conversations.admit(call.p, { commandId: `delegate:${ownerId}:${call.api.taskId}:${call.api.callId}`, kind: "delegate", chatId: call.chat, payload: { title: a.title, text: a.text, ...(a.agent_id ? { agentId: a.agent_id } : {}) } });
			return json({ task: admission.result?.taskId, chat: admission.chatId });
		}),
		write("archive_task_chats", "Archive the chats of tasks that are finished, so they leave the list.", Type.Object({}), async (app, call) => text(`Archived ${await app.conversations.archiveTaskChats(call.p)} task chats.`)),
		write("create_agent", "Create an agent: a name, its instructions, and optionally its model, skills and the agents it may delegate to.", Type.Object({ name: S({ minLength: 1 }), instructions: O(S()), emoji: O(S()), color: O(S()), model: O(Type.Object({ provider: S(), id: S() })), skills: O(strings), contacts: O(strings), delegates: O(strings) }), async (app, call, a) => {
			const created = await app.agents.create(call.p, a);
			return text(`Created agent ${created.id} (${created.name}).`);
		}),
		write("update_agent", "Change an agent, yourself included: its name, instructions, emoji, color, model, skills or contacts.", Type.Object({ id: S(), name: O(S()), instructions: O(S()), emoji: O(S()), color: O(S()), model: O(Type.Object({ provider: S(), id: S() })), skills: O(strings), contacts: O(strings), delegates: O(strings) }), async (app, call, a) => {
			const { id, ...changes } = a;
			return text(`Updated agent ${(await app.agents.update(call.p, id, changes)).name}.`);
		}),
	];

	// Coding: Forge, with the Authorizer deciding first whether this agent may.
	/** `pi`, which runs in a sandbox pool, unless this deployment has no pool to run it in and can run Amp, whose orbs need none. */
	const defaultHarness = async (forge: ForgeParts) => {
		const pooled = (await forge.db.query("select 1 from pim_forge.forge_pools where enabled limit 1")).rows.length > 0;
		return !pooled && forge.ampConfigured ? "amp" : "pi";
	};
	const coding = (name: string, description: string, parameters: any, action: string, run: (forge: ForgeParts, actor: Actor, call: Call, args: any) => Promise<unknown>) =>
		tool(name, description, parameters, async (args, api, context) => {
			const app = deps.app;
			if (!app) return noApp();
			const forge = deps.forge;
			if (!forge) return noForge();
			try {
				const chat = await deps.chatOf(api.conversationId);
				const p = await principalOf(app, chat);
				// Whether the agent may at all: its owner's grant, and the repository and pool it covers. What a person must approve (push, pull request, merge) Forge files itself.
				if (action === "coding:start" && !args.harness) args = { ...args, harness: await defaultHarness(forge) };
				const repo = typeof args.repo === "string" ? { repository: args.repo.replace(/^https?:\/\//, "").replace(/\.git$/, ""), ...(typeof args.pool === "string" ? { pool: args.pool } : {}), ...(action === "coding:start" && typeof args.harness === "string" ? { harness: args.harness } : {}) } : undefined;
				await app.identity.authz.authorize({ principal: p, ownerId: owner, action, ...(repo ? { resource: repo } : {}) });
				const role = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT role FROM pim_app.accounts WHERE owner_id = $1", [ownerId])).rows[0]?.role)) ?? "member";
				const actor: Actor = { ownerId: owner, role, ...(p.kind === "agent" && p.agentId !== "pim" ? { agent: p.agentId } : {}) };
				const result: any = await run(forge, actor, { chat, p, api, agentId: null, context }, args);
				if (result?.status === "approval_required") return text(`This needs a person's approval (${result.approvalId}). It is waiting in their approvals; ask again once they have said yes.`);
				return typeof result === "string" ? text(result) : json(result ?? { ok: true });
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		}, action === "coding:start" || action === "coding:push" || action === "coding:merge" || action === "coding:pr" || action === "coding:steer" || action === "coding:abort" ? "unsafe" : "safe");
	const thread = Type.String({ description: "The coding thread's id." });
	tools.push(
		coding("coding_start", "Start a coding thread on a repository: a task for a coding agent in its own workspace. harness picks what runs it: pi (the default) in a sandbox, or amp in an Amp orb, which needs no sandbox. On a deployment with no sandbox pool where Amp is set up, the default is amp.", Type.Object({ task: S({ minLength: 1 }), repo: S({ minLength: 1 }), ref: O(S()), harness: O(S()), pool: O(S()), budget_usd: O(Type.Number({ minimum: 0 })) }), "coding:start", async (f, actor, c, a) =>
			f.forge.start(actor, { operationId: `coding:${ownerId}:${c.api.taskId}:${c.api.callId}`, task: a.task, repo: a.repo, ref: a.ref, harness: a.harness, pool: a.pool, ...(c.chat ? { chatId: c.chat } : {}), ...(a.budget_usd !== undefined ? { budgetUsd: a.budget_usd } : {}) })),
		coding("coding_status", "A coding thread's state.", Type.Object({ thread }), "coding:read", (f, actor, _c, a) => f.forge.status(actor, a.thread)),
		coding("coding_steer", "Send a coding thread an instruction.", Type.Object({ thread, text: S({ minLength: 1 }) }), "coding:steer", (f, actor, c, a) => f.forge.steer(actor, a.thread, a.text, `steer:${ownerId}:${c.api.taskId}:${c.api.callId}`)),
		coding("coding_diff", "The changes a coding thread has made.", Type.Object({ thread }), "coding:read", (f, actor, _c, a) => f.forge.diff(actor, a.thread)),
		coding("coding_tests", "Run a command in a coding thread's workspace (for example its tests), or read the last run.", Type.Object({ thread, command: O(strings) }), "coding:steer", (f, actor, _c, a) => (a.command ? f.forge.runTests(actor, a.thread, a.command) : f.forge.tests(actor, a.thread))),
		coding("coding_transcript", "A coding thread's transcript.", Type.Object({ thread, offset: O(Type.Integer({ minimum: 0 })), limit: O(Type.Integer({ minimum: 1, maximum: 100 })), role: O(S()), summary: O(Type.Boolean()), tail: O(Type.Boolean()) }), "coding:read", (f, actor, _c, a) => f.forge.transcriptPage(actor, a.thread, { offset: a.offset, limit: a.limit, role: a.role, summary: a.summary, tail: a.tail })),
		coding("coding_transcript_output", "The full output of one step of a coding thread's transcript.", Type.Object({ thread, id: O(S()), offset: O(Type.Integer({ minimum: 0 })), limit: O(Type.Integer({ minimum: 1 })) }), "coding:read", (f, actor, _c, a) => f.forge.transcriptOutput(actor, a.thread, { id: a.id, offset: a.offset, limit: a.limit })),
		coding("coding_abort", "Stop a coding thread's current turn.", Type.Object({ thread }), "coding:steer", (f, actor, _c, a) => f.forge.abort(actor, a.thread)),
		coding("coding_archive", "Archive a coding thread: its workspace is torn down, its transcript and diffs stay readable.", Type.Object({ thread }), "coding:steer", (f, actor, _c, a) => f.forge.archive(actor, a.thread)),
		coding("coding_push", "Push a coding thread's branch. A person approves it first, unless they have said it may go ahead.", Type.Object({ thread }), "coding:push", (f, actor, _c, a) => f.forge.push(actor, a.thread)),
		coding("coding_open_pull_request", "Open a pull request for a coding thread's branch. A person approves it first, unless they have said it may go ahead.", Type.Object({ thread, title: O(S()) }), "coding:pr", (f, actor, _c, a) => f.forge.openPullRequest(actor, a.thread, a.title)),
		coding("coding_merge", "Merge a coding thread's branch into the default branch, fast-forward or rebase, never forced. A person approves it first, unless they have said it may go ahead.", Type.Object({ thread }), "coding:merge", (f, actor, _c, a) => f.forge.merge(actor, a.thread)),
	);

	// The person's computer: files, shell, browser, desktop (`./computer-tools.ts`).
	tools.push(...computerTools({ ownerId, partitionId, runtime, app: deps.app, relay: deps.relay, chatOf: deps.chatOf }, { ops, principalOf }));

	// Images: `generate_image`, saved to the person's files.
	if (deps.images) tools.push(...imageTools({ ownerId, partitionId, runtime, app: deps.app, images: deps.images, fetch: deps.fetch, now: deps.now, chatOf: deps.chatOf }, { ops, principalOf }));

	// The owner's connected MCP servers: their tools, with each one's Off, Ask or On.
	const transport: Transport = { fetch: deps.fetch, allowPrivate: deps.allowPrivateConnectors === true, check: publicUrl };
	const connectors = connectorToolset({ ownerId, partitionId, runtime, app: deps.app, crypto: deps.crypto, transport, ops, owner, now: deps.now, chatOf: deps.chatOf, principalOf });
	tools.push(...connectors.tools);
	// Watches: events of a connected server, delivered to the chat that asked.
	tools.push(...watchTools({ ownerId, watch: () => (deps.app && deps.crypto ? { app: deps.app, crypto: deps.crypto, transport, publicUrl: process.env.PIM_PUBLIC_URL, now: deps.now } : undefined), chatOf: deps.chatOf, principalOf: (chat) => (deps.app ? principalOf(deps.app, chat) : Promise.resolve(undefined)) }));

	// The admin's majordomo runs the deployment (`./admin-tools.ts`); every other agent is refused there.
	tools.push(...adminTools({ ownerId, app: deps.app, env: process.env, principalOf, chatOf: deps.chatOf, runtime: runtime as never }));
	// A guest's agent, and a chat that is someone's visit to a bot, work with a short list of tools: nothing of the owner's computer, files, coding or other connectors.
	tools.push(...guestToolset({ ownerId, partitionId, runtime, app: deps.app, crypto: deps.crypto, transport, ops, owner, now: deps.now, chatOf: deps.chatOf }));
	// Every tool call that gets this far counts against the owner's day (migration 0621); once the day's allowance is used the call is refused with the space's usual message.
	const defaultToolCalls = /^\d+$/.test(process.env.PIM_LIMIT_DAILY_TOOL_CALLS?.trim() ?? "") ? Number(process.env.PIM_LIMIT_DAILY_TOOL_CALLS) : null;
	const withinToolCalls = () => runtime.read<{ ok: boolean }>(ownerId, "SELECT pim_app.runner_count_tool_call($1, $2) AS ok", [ownerId, defaultToolCalls]).then((r) => r.rows[0]?.ok !== false, () => true);
	const guarded = tools.map((t) => {
		const name = (t as unknown as { name: string }).name;
		const run = (t as unknown as { execute: (...a: any[]) => Promise<Result> }).execute;
		return { ...t, execute: async (args: any, api: any, context: any): Promise<Result> => {
			const app = deps.app;
			const allowed = app ? await toolsAllowed(app, ownerId, await deps.chatOf(api.conversationId)) : null;
			if (app && name.startsWith("note_") && (await disabledBuiltins(app)).includes("notes")) return text("Notes are turned off for everyone by this Pim's admin.", true);
			if (allowed && !allowed.has(name)) return text(`${name} isn't available here: this chat only has ${[...allowed].join(", ")}.`, true);
			if (!(await withinToolCalls())) return text(`${QUOTA_MESSAGE} too many tool calls today. It resets at midnight UTC.`, true);
			return run(args, api, context);
		} };
	}) as unknown as ToolRegistration[];
	return defineExtension({ name: "pim", tools: guarded.map((t) => stoppable(t, deps.toolTimeoutMs)), sections: [...sections, ...connectors.sections] });
}
