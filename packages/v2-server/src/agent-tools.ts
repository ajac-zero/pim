/**
 * The tools of a Pim agent on the portable stack, as one extension (`pim`) built for one partition's owner: the owner is fixed by the partition, so a tool can only
 * act for the person whose space it runs in. What a tool writes goes through the application's services (`@pim/v2-app`), whose Authorizer decides each call for the agent
 * principal (or, in a delegated task's chat, for the principal that started the chain). Coding goes through Forge. A tool whose service this Runner was not given answers
 * with what is missing instead of failing the turn.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "typebox";
import { defineExtension, defineTool, type PromptSection, type ToolRegistration } from "@earendil-works/pi-durable";
import { QUOTA_MESSAGE } from "@pim/v2-app/quota";
import type { App } from "@pim/v2-app/app";
import { OwnerId, PartitionId, type Principal } from "@pim/v2-contracts/identity";
import { ExternalOperations } from "@pim/v2-runtime/external";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { type Actor, repoName } from "@pim/v2-forge/authz";
import { BRANCH_OR_COMMIT, COMMIT, MAX_DIFF_CHARS, MAX_TEST_RUNS, brief, diffText, latestTests, listing, pushedMessage, testRun, threadArg } from "./coding-tools.ts";
import type { RelayBus } from "@pim/v2-app/relay";
import { hostSpeaks, postToRoom } from "./rooms.ts";
import { computerTools } from "./computer-tools.ts";
import { type ImageSources, imageTools } from "./image-tools.ts";
import type { ForgeParts } from "./forge-assembly.ts";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import { uiBlockReference } from "@pim/ui-lang";
import { loadWidgets, MAX_WIDGETS, type ShownWidget, uiDiagnostics, widgetRefs } from "./agent-widgets.ts";
import { connectorToolset, type Transport } from "./connector-tools.ts";
import { watchTools } from "./watch-tools.ts";
import { canvasTools } from "./canvas-tools.ts";
import { connectorAdminTools } from "./connector-admin-tools.ts";
import { builtinSkill } from "./builtin-skills.ts";
import { readSkillFolder } from "./skill-sources.ts";
import { adminTools } from "./admin-tools.ts";
import { rosterOf, teamTools } from "./agent-team-tools.ts";
import { recordResult } from "./tool-approval.ts";
import { roomTools } from "./room-tools.ts";
import { triggerTools } from "./trigger-tools.ts";
import { copiedFiles } from "./app-from-files.ts";
import { noteTools } from "./note-tools.ts";
import { goalTools } from "./goal-tools.ts";
import { memoryTools } from "./memory-tools.ts";
import { skillTools } from "./skill-tools.ts";
import { clipText, webTools } from "./web-tools.ts";
import { plainReply, widgetMarkdown } from "./shared-chat.ts";
import { blockImages, blocksAsMarkdown, fetchImage, imageCopyId, MAX_REPLY_IMAGES, MAX_UI_STATE_CHARS, REPLY_BLOCKS_GUIDANCE, replyBlocks, uiBlockLabel, uiProgramsOf } from "./reply-blocks.ts";
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

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });
const json = (v: unknown): Result => text(JSON.stringify(v, null, 1));

/** An email's subject when the model gives none: the message's first line. */
function headline(message: string): string {
	const line = message.trim().split(/\r?\n/)[0]!.replace(/^[#>*\-\s]+/, "").trim();
	return line.length > 120 ? `${line.slice(0, 119)}…` : line || "Pim";
}

const MAX_BODY = 100_000;
const MAX_REQUEST_MS = 20_000;
/** How much of an HTTP response the agent is shown, as in v1. */
const MAX_RESPONSE_CHARS = 8000;

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
	return chosen ?? (process.env.PIM_TIME_ZONE || "UTC");
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
	"A jsx app is a React app, App.jsx: `export default function App() { ... }`, with hooks from \"react\"; it may import \"react\", \"recharts\", \"lucide-react\" and its own files, is styled with Tailwind classes, and is compiled when you save it: a compile error comes back to you to fix. " +
	"HTML and JSX apps can have more files than the main one, by relative path (\"app.js\", \"components/Chart.jsx\", \"data.json\", \"images/logo.png\"): " +
	"a page loads its own with <script src=\"app.js\">, <link rel=\"stylesheet\" href=\"style.css\"> and <img src=\"images/logo.png\">, and reads data from <script type=\"application/json\" id=\"data\" src=\"data.json\"> (JSON.parse(document.getElementById(\"data\").textContent)), and keeps markup it reuses in <template> elements in index.html, not files of its own; " +
	"an app imports them: import Chart from \"./components/Chart\", import rows from \"./data.json\", import \"./styles.css\", import logo from \"./logo.png\" (a URL). " +
	"Give a file's content as text in files, or in copy_files a path in the user's files (/workspace/...) to copy, for an image or a dataset the user has (up to 10 MB in all, 100 files). Split a large app into files, and change one with edits and path. ";

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

/** The note the person left with their decision on an approval, as a sentence for the agent that waited on it; empty when there is none (v1 passed it on with the decision). */
async function noteOn(app: App, ownerId: string, payload: object): Promise<string> {
	const approvalId = (payload as { approvalId?: unknown }).approvalId;
	if (typeof approvalId !== "string") return "";
	const note = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT args->>'note' AS note FROM pim_app.approvals WHERE id = $1", [approvalId])).rows[0]?.note as string | undefined).catch(() => undefined);
	return note ? ` Their note: ${note}` : "";
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
	const copyFiles = Type.Array(Type.Object({ path: S({ minLength: 1, maxLength: 200, description: "Where it goes in the app." }), from_file: S({ description: "A path in the user's files, such as /workspace/photos/logo.png, to copy." }) }), { maxItems: 100, description: "Files of the user's to copy into the app, such as an image or a dataset." });
	const copied = (app: App, call: Call, list: { path: string; from_file: string }[] | undefined) => copiedFiles({ ownerId, app, relay: deps.relay }, call.p, list);

	const tools: ToolRegistration[] = [
		tool(
			"send_to_user",
			`Send the person a message. It is the only way they see anything you write: the rest of your text is private working notes. It finishes your turn unless you set complete to false. When you are working on a task another agent handed you, what you send is your answer to it. ${REPLY_BLOCKS_GUIDANCE} To draw a small interactive piece, such as a quiz, a checklist or a form the person fills in and sends back as a turn, put a \`\`\`ui block in the message, alone on its lines; it is not JSON; to see what the person changed in one without a submit, call ui_state. ${uiBlockReference()} A block that can't be drawn refuses the message with what to fix. widgets shows data under the message, by name, up to ${MAX_WIDGETS}: ${widgetRefs().join(", ")}.`,
			Type.Object({
				message: S({ minLength: 1, maxLength: 20_000 }),
				complete: O(Type.Boolean({ description: "Finish this turn (default true). Set false only for a progress update; send the final answer in a separate call with no other tools." })),
				widgets: O(Type.Array(Type.String(), { maxItems: MAX_WIDGETS })),
				// Email is a channel only where the deployment can send it.
				...(deps.app?.mail.available
					? {
							title: O(S({ maxLength: 120, description: "The email's subject; else the message's first line." })),
							channel: O(Type.Union([Type.Literal("chat"), Type.Literal("email")], { description: 'Where it goes: "chat" (the default), this conversation; "email", their inbox, when they ask for email or for something they will want to keep, such as a report. The conversation shows that it was emailed.' })),
						}
					: {}),
			}),
			async (args, api) => {
				const app = deps.app;
				const message = String(args.message);
				const wanted = [...new Set<string>(args.widgets ?? [])];
				const unknown = wanted.filter((ref) => !widgetRefs().includes(ref));
				if (unknown.length > 0) return text(`Not sent: ${unknown.join(", ")} ${unknown.length === 1 ? "isn't a widget" : "aren't widgets"} you can show. The widgets you can show here: ${widgetRefs().join(", ")}.`, true);
				// A block it wrote wrong, or an image no tool gave it (which it may have made up), is a mistake the model can fix: say what is wrong and send nothing.
				const blocks = replyBlocks(message);
				if ("error" in blocks) return text(`Not sent: ${blocks.error}.`, true);
				const ui = uiDiagnostics(message);
				if (ui.error !== undefined) return text(`Not sent: ${ui.error}.`, true);
				const pictured = blockImages(blocks);
				if (pictured.length > MAX_REPLY_IMAGES) return text(`Not sent: a message can show at most ${MAX_REPLY_IMAGES} images.`, true);
				const chat = await deps.chatOf(api.conversationId);
				if (pictured.length > 0) {
					const seen = (await runtime.read<{ record: string }>(ownerId, "SELECT record FROM pim_runtime.entries WHERE owner_id = $1 AND conversation_id = $2 AND record LIKE '%\"role\":\"toolResult\"%' AND record NOT LIKE '%\"toolName\":\"send_to_user\"%' AND record NOT LIKE '%\"toolName\":\"ui_state\"%'", [ownerId, api.conversationId])).rows.map((r) => r.record).join("\n");
					const unseen = pictured.filter((url) => !seen.includes(url));
					if (unseen.length > 0) return text(`Not sent: no tool's result in this chat gave ${unseen.join(", ")}. Use only images a tool found, or leave the image out.`, true);
				}
				// An email goes to the person's own inbox, and only there: not from a chat with someone else's agent.
				if (args.channel === "email") {
					if (!app?.mail.available || !chat) return text("Not sent: this Pim can't send email.", true);
					try {
						const p = await principalOf(app, chat);
						const kind = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT kind FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0]?.kind)) as string | undefined;
						if (kind === "visit") return text("Not sent: there is no email to send from a chat with someone else's agent.", true);
						// An inbox can't draw widgets: they go as text.
						const shownWidgets = wanted.length > 0 ? await loadWidgets(app, p, p.kind === "agent" && p.agentId !== "pim" ? p.agentId : null, wanted) : [];
						const origin = process.env.PIM_PUBLIC_URL;
						const link = origin ? `\n\n—\nFrom your Pim: ${new URL(`/chat/${chat}`, origin)}` : "";
						const body = [plainReply(blocksAsMarkdown(message)), ...shownWidgets.map((widget) => widgetMarkdown(widget))].join("\n\n");
						const emailed = await app.mail.send(ownerId, { id: `${api.taskId}:${api.callId}`, chat, subject: String(args.title ?? "").trim() || headline(message), text: `${body}${link}` });
						if ("error" in emailed) return text(`Not sent: ${emailed.error}`, true);
						await app.conversations.markResponse(ownerId, chat);
						return { ...text(`Emailed it to ${emailed.to}.`), ...(args.complete === false ? {} : { control: { terminate: true as const } }) } as Result;
					} catch (error) {
						return text(`Not sent: ${error instanceof Error ? error.message : String(error)}`, true);
					}
				}
				let shown: ShownWidget[] = [];
				const images: Record<string, string> = {};
				if (app && chat) {
					try {
						const p = await principalOf(app, chat);
						// Copies of the images, kept once under a name of their own, so the reply never loads from a third party and a replayed send keeps the same ones.
						for (const url of pictured) {
							const got = await fetchImage(url, publicUrl, deps.fetch);
							if (!got) continue;
							const id = imageCopyId(chat, url);
							await app.objects.put(p, { bytes: got.bytes, contentType: got.type, purpose: "image", key: `${ownerId}/${id}` });
							images[url] = `/api/images/${id}`;
						}
						// An agent in a group chat speaks into the host chat, where the person reads it; its own seat is not a chat they open.
						const posted = await postToRoom(app, p, chat, `${api.taskId}:${api.callId}`, message);
						if (!posted) {
							await app.conversations.markResponse(ownerId, chat);
							// A room's host speaks to the agents in its seats too.
							await hostSpeaks(app, p, chat, `${api.taskId}:${api.callId}`, message);
						}
						// What an agent sends in a chat a task started is its answer to the agent that asked, once its turn ends.
						await app.conversations.taskSaid(ownerId, chat, `${api.taskId}:${api.callId}`, message);
						// Loaded once, as sent: the message and what it shows stay together, and the model is told what the person saw.
						if (wanted.length > 0) shown = await loadWidgets(app, p, p.kind === "agent" && p.agentId !== "pim" ? p.agentId : null, wanted);
					} catch (error) {
						return text(`Not sent: ${error instanceof Error ? error.message : String(error)}`, true);
					}
				}
				// Where the person's ui blocks can be read back with ui_state: this message's id, and each block's id with a short label.
				const programs = uiProgramsOf([{ type: "tool-call", name: "send_to_user", arguments: { message } }]);
				const messageId = programs.size > 0 ? (await runtime.read<{ id: string }>(ownerId, "SELECT id::text AS id FROM pim_runtime.entries WHERE owner_id = $1 AND conversation_id = $2 AND record LIKE '%\"role\":\"assistant\"%' AND strpos(record, $3) > 0 AND strpos(record, '\"send_to_user\"') > 0 ORDER BY id DESC LIMIT 1", [ownerId, api.conversationId, JSON.stringify(String(api.callId))])).rows[0]?.id : undefined;
				const missing = pictured.filter((url) => !images[url]);
				const result = {
					sent: "Sent.",
					...(messageId !== undefined ? { message: messageId, uiBlocks: [...programs].map(([id, program]) => ({ id, label: uiBlockLabel(program) })) } : {}),
					...(shown.length > 0 ? { widgets: shown } : {}),
					...(Object.keys(images).length > 0 ? { images } : {}),
					...(missing.length > 0 && app && chat ? { notShown: `${missing.join(", ")}: not an image Pim could load` } : {}),
				};
				// A successful send finishes the turn: no further model request, so nothing is said twice.
				return { ...text(Object.keys(result).length === 1 ? "Sent." : JSON.stringify(result)), ...(args.complete === false ? {} : { control: { terminate: true as const } }) } as Result;
			},
			"safe",
		),
		read("ui_state", "Read what the person has set in the ```ui blocks of a message you sent in this chat, without waiting for a submit: sliders, checkboxes, drafts and submitted forms, with when each block last changed. The message id and each block's id are in send_to_user's result.", Type.Object({ message: S({ minLength: 1, maxLength: 40, description: "The id of a message you sent with send_to_user, from its result." }), block: O(S({ maxLength: 40, description: "Only this block, by the id send_to_user's result gave." })) }), async (app, call, a) => {
			const message = String(a.message).trim();
			const row = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT message FROM pim_projection.chat_transcript_projection WHERE owner_id = $1 AND chat_id = $2 AND entry_id = $3 LIMIT 1", [ownerId, call.chat, message])).rows))[0];
			if (!row) return text(`No message ${message} in this chat.`, true);
			const blocks = uiProgramsOf(row.message?.parts ?? []);
			if (a.block !== undefined && !blocks.has(a.block)) return text(`Message ${message} has no ui block ${a.block}. Its blocks: ${[...blocks.keys()].join(", ") || "none"}.`, true);
			const kept = new Map((await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT block, state, submitted, updated_at FROM pim_app.ui_states WHERE message_id = $1", [message])).rows)).map((r) => [r.block as string, r]));
			const entries = [...blocks].filter(([id]) => a.block === undefined || id === a.block).map(([id, program]) => {
				const record = kept.get(id);
				const state = (record?.state ?? {}) as { values?: Record<string, unknown>; submitted?: Record<string, unknown> };
				return { block: id, label: uiBlockLabel(program), values: state.values ?? {}, submitted: record?.submitted ?? false, submittedForms: Object.keys(state.submitted ?? {}), updatedAt: record === undefined ? null : new Date(record.updated_at).toISOString() };
			});
			if (entries.length === 0) return text("That message has no ui blocks.");
			const render = (shown: typeof entries) => ({
				summary: shown.map((entry) => {
					const values = Object.entries(entry.values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
					return `- ${entry.label} [${entry.block}], ${entry.updatedAt === null ? "not changed yet" : `changed ${entry.updatedAt}`}${entry.submitted ? ", submitted" : ""}: ${values.length > 0 ? values.join(", ") : "no values"}`;
				}).join("\n"),
				blocks: shown,
			});
			// A large result is cut to fit: whole blocks from the end first, then half of the last block's values at a time.
			let shown = entries;
			let result = render(shown);
			let cut = "";
			while (JSON.stringify(result).length > MAX_UI_STATE_CHARS) {
				const last = shown[shown.length - 1]!;
				const keys = Object.keys(last.values);
				if (shown.length === 1 && keys.length === 0) break;
				cut = "Cut to fit: ask for one block by its id to read more.";
				shown = shown.length > 1 ? shown.slice(0, -1) : [{ ...last, values: Object.fromEntries(Object.entries(last.values).slice(0, Math.floor(keys.length / 2))) }];
				result = render(shown);
			}
			return json({ ...result, ...(cut ? { note: cut } : {}) });
		}),
		tool("current_time", "The current date and time, in UTC and in the user's time zone.", Type.Object({}), async () => {
			const now = new Date(deps.now());
			const zone = await timeZoneOf(runtime, ownerId);
			return json({ utc: now.toISOString(), timeZone: zone, local: now.toLocaleString("en-US", { timeZone: zone, dateStyle: "full", timeStyle: "long" }) });
		}, "safe"),

		// Skills and goals.
		read("read_skill", "Read a skill's instructions and the names of its files: one of the person's own, or one that comes with Pim.", Type.Object({ name: S() }), async (app, call, a) => {
			const s = await app.agents.getSkill(call.p, a.name).catch((error) => {
				if (builtinSkill(a.name)) return undefined;
				throw error;
			});
			if (!s) return text(`${builtinSkill(a.name)!.instructions}\n\nFiles: none`);
			return text(`Skill ${a.name}, version ${s.version}:\n${s.body}\n\nFiles: ${Object.keys(s.files ?? {}).join(", ") || "none"}`);
		}),
		read("read_skill_file", "Read one of a skill's supporting files.", Type.Object({ name: S(), path: S() }), async (app, call, a) => {
			const file = ((await app.agents.getSkill(call.p, a.name)).files ?? {})[a.path];
			return file === undefined ? text(`${a.name} has no file ${a.path}.`, true) : text(file);
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
					// An agent's switch for skills, in Tool permissions: off, it installs none.
					const self = (await rosterOf(runtime, ownerId, chat)).self;
					if (self && (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT 1 FROM pim_app.tool_permissions WHERE audience = $1 AND app = '' AND tool = 'write_skill' AND permission = 'off'", [`agent:${self}`])).rowCount))) return text("The person turned skills off for this agent, so no skill is installed.", true);
					const signal = (await runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
					if (signal && signal.payload.approved !== true) return text(`A person did not approve this skill, so it was not installed.${await noteOn(app, ownerId, signal.payload)}`, true);
					const filed = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, args FROM pim_app.approvals WHERE tool = 'skill:install' AND args->>'taskId' = $1 LIMIT 1", [taskId])).rows[0])) as { id: string; args: { commit?: string; hashes?: Record<string, string> } } | undefined;
					if (!signal && !filed) {
						const names = Object.keys(folder.hashes);
						const summary = `Install the skill ${name} from ${folder.source}: ${names.length} file${names.length === 1 ? "" : "s"} (${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""})`;
						const gate = await app.approvals.gate(p, { action: "skill:install", tool: "install_skill", resource: { source: folder.source.replace(/\/tree\/.*$/, "") }, ...(chat ? { chatId: chat } : {}), args: { taskId, callId: api.callId, source: folder.source, commit: folder.commit, name, hashes: folder.hashes, summary }, timeoutMs: 24 * 3600_000, onTimeout: "deny", explicit: true });
						if (gate.outcome === "waiting") return { output: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
					} else if (!signal) {
						return { output: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
					}
					// What was approved is what is installed: the folder read again must be the one the person was shown.
					if (filed?.args.hashes && JSON.stringify(Object.entries(filed.args.hashes).sort()) !== JSON.stringify(Object.entries(folder.hashes).sort())) return text("The skill's files are not the ones that were approved, so it was not installed. Ask again to see them.", true);
					const files = { ...folder.files, ".source": JSON.stringify({ source: folder.source, commit: folder.commit }) };
					const exists = await app.agents.getSkill(p, name).then(() => true, () => false);
					await (exists ? app.agents.updateSkill(p, name, { description: folder.description, body: folder.body, files }) : app.agents.createSkill(p, { name, description: folder.description, body: folder.body, files }));
					const done = `${exists ? "Saved a new version of" : "Installed"} the skill ${name} from ${folder.source}.`;
					await recordResult(app, ownerId, "skill:install", taskId, done);
					return text(done);
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				}
			}, "safe"),
		// Schedules and triggers.
		read("schedule_task", "Wake yourself up later with an instruction, to follow up, check progress, send a reminder, or do recurring work. Give exactly one of delay_seconds, at (ISO 8601 with offset), or cron (5 fields, UTC). The instruction arrives as a message starting with \"[Scheduled task\": in this conversation, or with new_chat in a new chat each time it fires.", Type.Object({
			instruction: S({ minLength: 1, description: "What to do when it fires, written to your future self." }),
			label: O(S({ description: "Short name shown to the user, and the title of each new chat." })),
			delay_seconds: O(Type.Integer({ minimum: 1 })),
			at: O(S()),
			cron: O(S()),
			new_chat: O(Type.Boolean({ description: "Start a new chat with you each time it fires, instead of continuing this one: for recurring work read on its own, such as a daily briefing. The new chat doesn't see this conversation, so make the instruction complete." })),
			agent: O(S({ description: "For the majordomo only: the id of another of the person's agents, from your_agents, to do the work. Each firing starts a new chat with that agent, as with new_chat, so write the instruction to it." })),
		}), async (app, call, a) => {
			if ([a.delay_seconds, a.at, a.cron].filter((v) => v !== undefined).length !== 1) return text("Give exactly one of delay_seconds, at, or cron.", true);
			const roster = await rosterOf(runtime, ownerId, call.chat);
			const other = a.agent === undefined || a.agent === roster.self ? undefined : a.agent;
			if (other !== undefined) {
				if (!roster.majordomo) return text("Only the majordomo schedules work for other agents. Leave out agent.", true);
				if (!roster.agents.some((x) => x.id === other)) return text(`No agent has the id ${other}. Use an id from your_agents.`, true);
			}
			let kind: "cron" | "at" | "delay" = "cron";
			let spec: string = a.cron ?? "";
			if (a.at !== undefined) {
				const date = new Date(a.at);
				if (Number.isNaN(date.getTime())) return text(`Cannot read ${JSON.stringify(a.at)} as a date.`, true);
				if (date.getTime() <= deps.now()) return text(`${a.at} is in the past.`, true);
				[kind, spec] = ["at", date.toISOString()];
			} else if (a.delay_seconds !== undefined) [kind, spec] = ["delay", String(a.delay_seconds * 1000)];
			const here = !a.new_chat && other === undefined;
			if (here && !call.chat) return text("Scheduled work can't come back to this conversation. Use new_chat, so each run starts a new chat.", true);
			// The call's own id makes the schedule's: a rerun after an eviction finds the schedule it made.
			const id = await app.schedules.create(call.p, { kind, spec, prompt: a.instruction, ...(a.label ? { label: a.label } : {}), target: here ? "same_chat" : "new_chat", ...(here && call.chat ? { chatId: call.chat } : {}), ...((other ?? call.agentId) ? { agentId: (other ?? call.agentId)! } : {}), now: new Date(deps.now()), key: `schedule_task:${call.api.taskId}:${call.api.callId}` });
			const made = (await app.schedules.list(call.p)).find((s) => s.id === id);
			return json({ id, type: kind === "cron" ? "cron" : kind === "at" ? "scheduled" : "delayed", next: made?.nextRunAt?.toISOString() ?? null, ...(kind === "cron" ? { cron: spec } : {}), label: a.label ?? null, instruction: a.instruction, newChat: !here, ...(other ? { agent: other } : {}) });
		}),
		read("list_scheduled_tasks", "List your pending scheduled tasks.", Type.Object({}), async (app, call) => json((await app.schedules.list(call.p)).filter((s) => s.enabled && s.nextRunAt).map((s) => ({ id: s.id, type: s.kind === "cron" ? "cron" : s.kind === "at" ? "scheduled" : "delayed", next: s.nextRunAt!.toISOString(), ...(s.kind === "cron" ? { cron: s.spec } : {}), session: s.chatId, label: s.label, instruction: s.prompt, newChat: s.target === "new_chat", ...(s.target === "new_chat" && s.agentId ? { agent: s.agentId } : {}) })))),
		write("cancel_scheduled_task", "Cancel a scheduled task.", Type.Object({ id: S() }), async (app, call, a) => (await app.schedules.remove(call.p, a.id), text("Cancelled."))),
		// Notes and apps.
		write("note_create", "Create a note a person can open and edit alongside you. The answer is the note's card in the chat, which is how the person sees and opens it; there is no panel for you to open.", Type.Object({ title: S({ minLength: 1, maxLength: 200 }), text: O(S()) }), async (app, call, a) =>
			noteCard(app, ownerId, await app.canvas.create(call.p, a.title, a.text ?? "", "agent"), "Made it. The person sees it as a card in the chat and opens it beside the chat.")),
		read("note_show", "Show the person a note that already exists, such as one from another chat or the one they asked you to open, as the card in this chat that opens it beside the chat. It changes nothing. Find its id with note_list.", Type.Object({ id: S() }), async (app, _call, a) => noteCard(app, ownerId, a.id, "Showed it. The person sees the card in the chat and opens the note from it.")),
		write("app_create", `Create an app: kind html or jsx, or backend (with a pim.app.json). Files are by path. ${HOW_APPS_RUN}`, Type.Object({ title: S({ minLength: 1 }), kind: Type.Union([Type.Literal("html"), Type.Literal("jsx"), Type.Literal("backend")]), files, copy_files: O(copyFiles), message: O(S()) }), async (app, call, a) => appCard(await app.apps.create(call.p, { title: a.title, kind: a.kind, files: { ...a.files, ...(await copied(app, call, a.copy_files)) }, message: a.message }), "Made it. The person sees it in the chat and opens it beside the chat.")),
		write("app_update", "Change an app. base_version is the version you read; an app that changed since is refused.", Type.Object({ id: S(), base_version: Type.Integer({ minimum: 1 }), title: O(S()), files: O(files), copy_files: O(copyFiles), delete_files: O(strings), edits: O(Type.Array(Type.Object({ path: O(S()), find: S(), replace: S() }))), message: O(S()) }), async (app, call, a) =>
			appCard(await app.apps.update(call.p, a.id, { baseVersion: a.base_version, title: a.title, files: a.copy_files ? { ...a.files, ...(await copied(app, call, a.copy_files)) } : a.files, deleteFiles: a.delete_files, edits: a.edits, message: a.message }), "Saved. The person sees the new version in the chat.")),
		read("app_show", "Show the person an app that already exists, such as one made in another chat, as the card in this chat that opens it beside the chat: the latest version, or the one asked for. It changes nothing; don't make a new version just to show one. Find its id with app_list.", Type.Object({ id: S(), version: O(Type.Integer({ minimum: 1 })) }), async (app, call, a) => appCard(await app.apps.read(call.p, a.id, { version: a.version, path: undefined, offset: undefined }), "Showed it. The person sees it in the chat.")),
		read("app_read", "Read an app: its files, or one file.", Type.Object({ id: S(), version: O(Type.Integer({ minimum: 1 })), path: O(S()), offset: O(Type.Integer({ minimum: 0 })) }), async (app, call, a) => json(await app.apps.read(call.p, a.id, { version: a.version, path: a.path, offset: a.offset }))),
		read("app_list", "Your apps.", Type.Object({ query: O(S()) }), async (app, call, a) => json(await app.apps.list(call.p, a.query ?? ""))),

		// The web.
		tool("http_request", "Make an HTTP request that may change something elsewhere (POST, PUT, PATCH, DELETE). It is sent once: if its outcome cannot be known, it is not sent again.", Type.Object({ method: Type.Union(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map((m) => Type.Literal(m))), url: S(), headers: O(Type.Record(Type.String(), Type.String())), body: O(S()) }),
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
					if (signal && signal.payload.approved !== true) return text(`A person did not approve this request, so it was not sent.${await noteOn(app, ownerId, signal.payload)}`, true);
					if (!signal) {
						const filed = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.approvals WHERE tool = 'http:request' AND args->>'taskId' = $1 LIMIT 1", [taskId])).rows[0]?.id as string | undefined);
						if (filed) return { output: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
						const gate = await app.approvals.gate(p, { action: "http:request", tool: "http_request", resource: { host: url.host, method: args.method }, ...(chat ? { chatId: chat } : {}), args: { taskId, callId: api.callId, method: args.method, url: url.href, headers: redactHeaders(args.headers), body: typeof args.body === "string" ? args.body.slice(0, 2000) : undefined }, timeoutMs: 24 * 3600_000, onTimeout: "deny" });
						if (gate.outcome === "waiting") return { output: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
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
						const body = clipText(await readBody(response), MAX_RESPONSE_CHARS);
						const summary = `${response.status} ${response.headers.get("content-type") ?? ""}\n${body}`;
						await ops.transition(ownerId, operationId, "completed", { status: response.status, summary });
						// What came back is on the approval card too, as in v1.
						await app.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.approvals SET args = args || $2::jsonb WHERE tool = 'http:request' AND args->>'taskId' = $1", [taskId, JSON.stringify({ result: summary.slice(0, 4000) })])).catch(() => undefined);
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
		write("archive_task_chats", "Archive the chats of tasks that are finished, so they leave the list.", Type.Object({}), async (app, call) => text(`Archived ${await app.conversations.archiveTaskChats(call.p)} task chats.`)),
	];
	// Delegation and agents (`./agent-team-tools.ts`).
	tools.push(...teamTools({ ownerId, runtime, fetch: deps.fetch, publicUrl, read, write }));
	// Group chats and other chats (`./room-tools.ts`).
	tools.push(...roomTools({ ownerId, runtime, read }));
	// Triggers, typed, with the person's grant for a computer source (`./trigger-tools.ts`).
	tools.push(...triggerTools({ ownerId, runtime, read, write }));
	// Memory (`./memory-tools.ts`), goals (`./goal-tools.ts`), and reading, changing and listing notes (`./note-tools.ts`).
	tools.push(...webTools({ tool, fetch: deps.fetch, publicUrl }));
	tools.push(...memoryTools({ ownerId, runtime, read, write }));
	tools.push(...skillTools({ ownerId, runtime, read }));
	tools.push(...goalTools({ read, write }));
	tools.push(...noteTools({ ownerId, read, write, card: (app, id, note) => noteCard(app, ownerId, id, note) }));

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
	// v1's tool surface (src/extensions/coding.ts): the same names, parameters and answers, with the new spelling `thread` and `budget_usd` accepted beside `thread_id` and `budget`.
	const ThreadId = Type.String({ description: "The thread's ID, as coding_start or coding_status gave it; also its /coding/<id> page, an Amp thread's ID (T-…) or an https://ampcode.com/threads/T-… URL." });
	const thread = O(ThreadId);
	const named = { thread_id: thread, thread };
	const link = (id: string) => `${(process.env.PIM_PUBLIC_URL ?? "").replace(/\/$/, "")}/coding/${id}`;
	const about = async (f: ForgeParts, actor: Actor, ref: string) => brief(await f.forge.status(actor, ref), { link, queue: { position: (await f.forge.progress(actor, ref)).queuePosition }, checkpoint: await f.forge.checkpoint(actor, ref) });
	const latest = async (f: ForgeParts, actor: Actor, ref: string) => latestTests(await f.forge.tests(actor, ref), 3, { output: false });
	tools.push(
		coding("coding_start", "Start a coding thread: a coding agent that works on a Git repository (GitHub or Gitea) in a workspace of its own, on a new branch (pim/…), on the task you give it. Use it for changes to a codebase: fixing a bug, adding a feature, writing tests. Write the task as you would for a capable engineer who knows nothing of this conversation: what to change, why, and how to check it. It returns at once, often queued while a workspace is made ready; don't wait for it. You are told in this chat when each of its turns ends. Then read what it did with coding_transcript (tail=true, or role=\"assistant\" for its replies; coding_transcript_output reads one whole) and its work with coding_diff and coding_tests; never steer it just to ask what it did or to print a diff. Say more with coding_steer, and push it with coding_push or ship it to the default branch with coding_merge (a person may be asked to approve first): check its diff and tests first. After a push, coding_open_pull_request opens a pull request. harness picks what runs it: pi (the default) in a sandbox, or amp in an Amp orb, which needs no sandbox; on a deployment with no sandbox pool where Amp is set up, the default is amp. If a thread fails with a transient error (workspace, manager, harness or provider), retry once by starting a fresh thread with the same task; if that fails too, stop and tell the person what happened.", Type.Object({
			repo: S({ minLength: 1, description: "The repository's address, such as https://github.com/<owner>/<name> or the same on the deployment's Gitea." }),
			ref: O(S({ description: "The branch, tag or commit to start from; main by default." })),
			task: S({ minLength: 1 }),
			profile: O(Type.Object({ provider: S(), model: S() }, { description: "The model it runs on, by provider and model id. Leave it out for the deployment's default." })),
			harness: O(S({ description: "The coding agent that runs it: pi, claude-code, codex, mistral-vibe or amp; pi by default. The others run the vendor's own CLI signed in as the person, who connects it on the coding page first." })),
			budget: O(Type.Number({ exclusiveMinimum: 0, description: "The most it may spend on its model, in US dollars. None by default: a thread runs until it finishes. Only Pi, Claude Code and Mistral Vibe report what they spend; for Codex and Amp the budget is ignored." })),
			budget_usd: O(Type.Number({ exclusiveMinimum: 0, description: "Same as budget." })),
			parent: O(S({ description: "The thread this one continues from, if any." })),
			pool: O(S({ description: "Pin the thread to one sandbox pool by id: it is placed only there and queues if that pool is full. An unknown or disabled pool is refused. Leave it out to take the first pool with room." })),
			provider: O(S({ description: "Same as pool." })),
			rebuildEnvironment: O(Type.Boolean({ description: "Accepted and ignored: this deployment keeps no environment snapshots, so every workspace is set up fresh." })),
		}), "coding:start", async (f, actor, c, a) => {
			const budget = a.budget ?? a.budget_usd;
			const started = await f.forge.start(actor, { operationId: `coding:${ownerId}:${c.api.taskId}:${c.api.callId}`, task: a.task, repo: a.repo, ref: a.ref, harness: a.harness, pool: a.pool, provider: a.provider, ...(c.chat ? { chatId: c.chat } : {}), ...(budget !== undefined ? { budgetUsd: budget } : {}), ...(a.profile ? { profile: { providerId: a.profile.provider, model: a.profile.model } } : {}), ...(a.parent ? { parent: a.parent } : {}) });
			const t = await about(f, actor, started.threadId);
			return { thread_id: t.thread_id, url: t.url, status: t.status, ...(t.position ? { position: t.position, waiting_for: t.waiting_for } : {}), branch: t.branch, provider: t.provider, pool: t.pool };
		}),
		coding("coding_status", "How a coding thread is doing: its state, its harness and, for an Amp Orb thread, its Amp thread (orb.thread_id, orb.url), its latest checkpoint, what its setup script did and what it has spent. Without a thread_id, lists the person's coding threads, newest first. Also reads an Amp thread (T-… or its ampcode.com URL) that Pim didn't start, through the person's Amp login.", Type.Object(named), "coding:read", async (f, actor, _c, a) => {
			const given = a.thread_id ?? a.thread;
			if (!given) return listing(await f.forge.list(actor));
			const outside = await f.forge.external(actor, given);
			if (outside) return { thread_id: outside.threadId, orb: { thread_id: outside.threadId, url: outside.url }, harness: "amp", provider: "amp-orbs", status: outside.state, external_amp_thread: true };
			return about(f, actor, given);
		}),
		coding("coding_steer", "Tell a coding thread something: more to do, a correction, an answer to its question. During a turn it reads it after its current step, or with interrupt stops what it is doing and starts on it; between turns it starts a new turn; a thread that failed goes on with it.", Type.Object({ ...named, text: O(S({ minLength: 1 })), interrupt: O(Type.Boolean()), retry_environment: O(Type.Boolean({ description: "Not available: this deployment keeps no environment snapshots to rebuild." })) }), "coding:steer", async (f, actor, c, a) => {
			if (a.retry_environment === true) throw new Error("This deployment keeps no environment snapshots to rebuild; its setup script runs again whenever a workspace is made.");
			if (!a.text) throw new Error("Say something to the thread: text is required");
			const ref = threadArg(a);
			await f.forge.steer(actor, ref, a.text, `steer:${ownerId}:${c.api.taskId}:${c.api.callId}`, { interrupt: a.interrupt === true });
			const t = await f.forge.status(actor, ref);
			return { thread_id: t.threadId, status: t.state, turn_under_way: t.state === "running" };
		}),
		coding("coding_diff", `What a coding thread changed, as a git diff from where it started (or from \`since\`, a commit) to its latest checkpoint. At most ${MAX_DIFF_CHARS} characters; the thread's page has all of it. An Amp Orb thread runs in Amp's cloud with no workspace of Pim's: its diff is read from the git host, of its pim/ branch (or another branch it says it pushed, or the \`head\` you give) once it is pushed. Never steer a thread just to print its diff.`, Type.Object({ ...named, since: O(S({ description: "A commit to diff from: an earlier checkpoint's sha." })), head: O(S({ description: "For an Amp Orb thread: the branch or commit on the git host to diff to, when it pushed under another name than its own." })) }), "coding:read", async (f, actor, _c, a) => {
			if (a.since !== undefined && !COMMIT.test(a.since)) throw new Error("since must be a commit's sha");
			if (a.head !== undefined && !BRANCH_OR_COMMIT.test(a.head)) throw new Error("head must be a branch or a commit");
			const ref = threadArg(a);
			const t = await f.forge.status(actor, ref);
			return diffText(await f.forge.diff(actor, ref, { since: a.since, head: a.head }), t.branch, link(t.threadId));
		}),
		coding("coding_tests", `The latest test runs of a coding thread (up to ${MAX_TEST_RUNS}), newest first: the command, how it exited, the counts when the runner said them, and the end of its output. With \`command\` it runs that command in the thread's workspace first (its tests, say) and answers with that run.`, Type.Object({ ...named, command: O(strings) }), "coding:read", async (f, actor, c, a) => {
			const ref = threadArg(a);
			// Reading the runs is reading; running a command is what a steer may do.
			if (a.command) await deps.app!.identity.authz.authorize({ principal: c.p, ownerId: owner, action: "coding:steer" });
			if (a.command) return testRun({ command: a.command.join(" "), ...(await f.forge.runTests(actor, ref, a.command)) });
			return latestTests(await f.forge.tests(actor, ref));
		}),
		coding("coding_transcript", "What a coding thread said: the task it was given, what its agent answered, the commands it ran and what they printed, and its notices. It reads the whole conversation of any coding thread, a workspace thread or an Amp Orb thread (also an Amp thread Pim didn't start, by its T-… ID or ampcode.com URL), so never steer a thread just to ask what it did. Messages come oldest first, `limit` from `offset` (0 by default); with `tail` it reads the latest `limit` instead, where a long thread's final answers are. `role` reads only one kind of message (user, assistant, tool or notice), and `summary` one line of each. Long messages are cut; coding_transcript_output reads one whole by its id.", Type.Object({ ...named, offset: O(Type.Integer({ minimum: 0, description: "The first message to show, counting from 0; the oldest by default." })), tail: O(Type.Boolean({ description: "Read the latest `limit` messages instead of starting at 0; ignored when `offset` is given." })), limit: O(Type.Integer({ minimum: 1, maximum: 100 })), role: O(S({ description: "Only messages of this kind: user, assistant, tool or notice." })), summary: O(Type.Boolean({ description: "One line of each message, instead of the whole of each." })) }), "coding:read", (f, actor, _c, a) => f.forge.transcriptPage(actor, threadArg(a), { offset: a.offset, limit: a.limit, role: a.role, summary: a.summary, tail: a.tail, external: true })),
		coding("coding_transcript_output", "One message of a coding thread's transcript whole, by the id coding_transcript gave it: the whole of what it said, of a command it ran or of what that printed, which the transcript had cut. Paged by lines like read.", Type.Object({ ...named, id: O(S({ description: "The message's id, as coding_transcript gave it." })), offset: O(Type.Integer({ minimum: 0 })), limit: O(Type.Integer({ minimum: 1 })) }), "coding:read", (f, actor, _c, a) => f.forge.transcriptOutput(actor, threadArg(a), { id: a.id, offset: a.offset, limit: a.limit, external: true })),
		coding("coding_abort", "Stop a coding thread: its turn and every command it runs, and what was waiting for it. It keeps its work, and can be steered again.", Type.Object(named), "coding:steer", async (f, actor, _c, a) => {
			const ref = threadArg(a);
			await f.forge.abort(actor, ref);
			return about(f, actor, ref);
		}),
		coding("coding_archive", "End a coding thread for good: it stops and its workspace is deleted. Its transcript, diff and tests stay readable. Push its branch first if its work is wanted.", Type.Object(named), "coding:steer", async (f, actor, _c, a) => {
			const ref = threadArg(a);
			await f.forge.archive(actor, ref);
			return { thread_id: (await f.forge.status(actor, ref)).threadId, status: "archived" };
		}),
		coding("coding_push", "Push a coding thread's work to its git host (GitHub or Gitea): its latest checkpoint, to its own branch (pim/…) unless you name another pim/ branch, never main or the default branch (to ship to it, use coding_merge). A person may be asked to approve first. Then open a pull request with coding_open_pull_request. The result includes the thread's latest test runs.", Type.Object({ ...named, branch: O(S({ description: "A branch starting with pim/; the thread's own by default." })) }), "coding:push", async (f, actor, _c, a) => {
			const ref = threadArg(a);
			const pushed = await f.forge.push(actor, ref, { branch: a.branch });
			if (pushed.status !== "done") return pushed;
			const t = await f.forge.status(actor, ref);
			return { message: pushedMessage(t.repo, repoName(t.repo) ?? t.repo, pushed.outcome, pushed.sha, pushed.branch), tests: await latest(f, actor, ref) };
		}),
		coding("coding_open_pull_request", "Open a pull request on the thread's git host (GitHub or Gitea) from its pushed pim/… branch into the branch it started from (the default branch when it started from a commit). Push the branch first with coding_push. A person may be asked to approve first. The title defaults to the thread's task, and the body to the task with a note that Pim opened it. If a pull request from the branch is open already, that one is the answer. Returns the pull request's URL and number.", Type.Object({ ...named, title: O(S({ description: "The pull request's title; the thread's task by default." })), body: O(S({ description: "The pull request's description; the thread's task by default." })) }), "coding:pr", async (f, actor, _c, a) => {
			const opened = await f.forge.openPullRequest(actor, threadArg(a), a.title, a.body);
			if (opened.status !== "done") return opened;
			return { message: `Pull request #${opened.number} from ${opened.head} into ${opened.base}: ${opened.url}`, url: opened.url, number: opened.number };
		}),
		coding("coding_merge", "Ship a coding thread's work: merge its latest checkpoint into the repository's default branch on the git host (fast-forward or rebase, never forced; if it moves meanwhile, the rebase is retried once), so look at coding_diff and coding_tests first. A person may be asked to approve first. If the thread's changes conflict with the default branch, nothing is pushed: coding_steer the thread to rebase onto origin/<default branch> and resolve the conflicts, then merge again after its turn ends. Returns the default branch's new commit and the thread's latest test runs.", Type.Object(named), "coding:merge", async (f, actor, _c, a) => {
			const ref = threadArg(a);
			const merged = await f.forge.merge(actor, ref);
			if (merged.status !== "done") return merged;
			if (merged.outcome !== "merged") return { error: "merge_failed", message: merged.detail ?? "The merge conflicted", tests: await latest(f, actor, ref) };
			const t = await f.forge.status(actor, ref);
			return { message: `Merged into ${merged.base} on ${new URL(t.repo).host}/${repoName(t.repo) ?? t.repo}${merged.method === "rebase" ? " after rebasing onto it" : " as a fast-forward"}: ${merged.base} is now at ${merged.sha}.`, sha: merged.sha, tests: await latest(f, actor, ref) };
		}),
	);

	// The person's computer: files, shell, browser, desktop (`./computer-tools.ts`).
	tools.push(...computerTools({ ownerId, partitionId, runtime, app: deps.app, relay: deps.relay, chatOf: deps.chatOf }, { ops, principalOf }));

	// Images: `generate_image`, saved to the person's files.
	if (deps.images) tools.push(...imageTools({ ownerId, partitionId, runtime, app: deps.app, images: deps.images, relay: deps.relay, fetch: deps.fetch, now: deps.now, chatOf: deps.chatOf }, { ops, principalOf }));

	// The owner's connected MCP servers: their tools, with each one's Off, Ask or On.
	const transport: Transport = { fetch: deps.fetch, allowPrivate: deps.allowPrivateConnectors === true, check: publicUrl };
	const connectors = connectorToolset({ ownerId, partitionId, runtime, app: deps.app, crypto: deps.crypto, transport, ops, owner, now: deps.now, chatOf: deps.chatOf, principalOf });
	tools.push(...connectors.tools);
	// The canvas beside the chat (`./canvas-tools.ts`).
	tools.push(...canvasTools({ ownerId, read, relay: deps.relay }));
	// Finding, connecting and managing connectors (`./connector-admin-tools.ts`).
	tools.push(...connectorAdminTools({ ownerId, runtime, read, write, env: process.env, transport, now: deps.now }));
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
