/**
 * The agent's tools on the person's own computer, ported from v1 (`src/extensions/files.ts`, `browser.ts`, `desktop.ts`): the files under /workspace, `shell`, the browser and the
 * desktop. The computer is a paired `pim-computer` whose socket the Gate or Relay holds; a Runner reaches it over the Relay's bus (`acquireRemote`), so with no computer
 * connected, or no bus, every tool answers at once that it is unavailable and the chat goes on without it.
 *
 * What has effects outside the conversation asks a person first through the application's approvals, as `http_request` does, unless a standing approval covers it:
 * `shell`, `file_delete`, a desktop action, and (browser) sending a form, pressing Enter in a field that sends one, and uploading files. Once approved, the effect is
 * recorded as an external operation first, so a replay or a new owner of the partition never runs it twice: an outcome that cannot be known is left for a person to check.
 * Reading and writing files, opening and reading pages, and clicking links ask nothing, as in v1; every path is confined to /workspace, and a write that names the file's
 * hash is refused when the file changed since.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import { sniffImage } from "@pim/v2-app/objects";
import { fitImage } from "./message-images.ts";
import { acquireRemote, type Computer, type RelayBus, type RemoteComputer } from "@pim/v2-app/relay";
import { CapabilityUnavailableError } from "@pim/v2-contracts/authz";
import { OwnerId, PartitionId, type Principal } from "@pim/v2-contracts/identity";
import type { ExternalOperations } from "@pim/v2-runtime/external";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { type BrowserTransport, type Computer as BrowserComputer, describePage, PimBrowser } from "./computer-browser.ts";

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Part[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

export const FILES_ROOT = "/workspace";
const DEFAULT_COMMAND_MS = 120_000;
const MAX_COMMAND_MS = 600_000;
const COMMAND_OUTPUT_BYTES = 64_000;
const DRIVER_CALL_MS = 120_000;
const MAX_READ = 1_048_576;
/** What `file_read` takes of a file: it shows 60,000 characters at most, and an answer this size passes a message bus left at NATS's default 1 MB limit. */
const MAX_TEXT_READ = 524_288;
/** The largest picture `file_read` opens: what an upload may be. */
const MAX_IMAGE_FILE = 25_000_000;
const MAX_WRITE = 1_000_000;
const MAX_RESULT_CHARS = 60_000;

/** What the tools need of the Runner. */
export type ComputerToolDeps = {
	ownerId: string;
	partitionId: string;
	runtime: RuntimeDb;
	app: App | undefined;
	/** The Relay's bus, made when first needed; a Runner without one cannot reach a computer. */
	relay: (() => Promise<RelayBus>) | undefined;
	chatOf(conversationId: number | string): Promise<string | null>;
};
export type ComputerToolKit = {
	ops: ExternalOperations;
	principalOf(app: App, chat: string | null): Promise<Principal>;
};

/** `path` as an absolute path under /workspace, or null when it is not one. */
export function filesPath(path: unknown): string | null {
	if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return null;
	const resolved = posix.normalize(path).replace(/\/+$/, "") || "/";
	return resolved === FILES_ROOT || resolved.startsWith(`${FILES_ROOT}/`) ? resolved : null;
}

const WHERE = `The person's files are under ${FILES_ROOT}, a folder on their computer. Paths outside it are refused: use shell for the rest of the computer.`;
const clip = (s: string, n = MAX_RESULT_CHARS) => (s.length > n ? `${s.slice(0, n)}\n[… cut; ${s.length - n} more characters]` : s);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const Ref = Type.Integer({ minimum: 1, description: "The element's number, from the page as browser_open or browser_read last showed it: 12 for [12 button “Search”]." });
const ClickArgs = Type.Object({ ref: Ref });
const TypeArgs = Type.Object({ ref: Ref, text: Type.String({ maxLength: 2_000, description: "What to type. It replaces what the field held. In a list, the option to choose, by its text." }), submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing, which usually sends the form." })) });
const UploadArgs = Type.Object({ ref: Ref, paths: Type.Array(Type.String({ pattern: "^/workspace/" }), { minItems: 1, maxItems: 10, description: "Files in the person's files, as /workspace/report.pdf." }) });

const DESKTOP_ABOUT = "The person's computer has a desktop they can watch from Computer in the app while you work. Use desktop_look to see it, desktop_read to read a window's accessibility tree, desktop_act to act in its apps. For web pages use the browser tools.";
/** What a computer without displayd answers a chat's call for a display of its own. */
const NO_DISPLAYD = /no display allocated|displayd is not reachable/;
const sessionOf = (chat: string) => `pim-${chat.replace(/[^\w-]/g, "").slice(0, 24)}`;
const Pid = Type.Integer({ description: "The app's process, as desktop_look or desktop_read shows it." });
const DesktopAct = Type.Object({
	action: Type.Union(["launch_app", "click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "set_value", "kill_app"].map((a) => Type.Literal(a)), { description: "launch_app: open an app by `name` (or `urls`). click, double_click, right_click: an element, or a point. type_text: type `text`. press_key: one `key`. hotkey: `keys`. scroll: `direction`, `amount`. set_value: `value` into an element. kill_app: force-quit `pid`." }),
	pid: Type.Optional(Pid),
	window_id: Type.Optional(Type.Integer()),
	element_token: Type.Optional(Type.String({ description: "An element from desktop_read: `<snapshot id>:N`." })),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	text: Type.Optional(Type.String({ maxLength: 5_000 })),
	key: Type.Optional(Type.String()),
	keys: Type.Optional(Type.Array(Type.String(), { maxItems: 5 })),
	value: Type.Optional(Type.String({ maxLength: 5_000 })),
	direction: Type.Optional(Type.Union(["up", "down", "left", "right"].map((a) => Type.Literal(a)))),
	amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	name: Type.Optional(Type.String()),
	urls: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
	foreground: Type.Optional(Type.Boolean()),
});

/** What a desktop action does, as the person reads it to decide. */
function summarizeDesktop(a: any): string {
	const where = a.element_token ? `element ${a.element_token}` : a.x !== undefined ? `(${a.x}, ${a.y})` : "the window";
	const app = a.pid !== undefined ? ` in app ${a.pid}` : "";
	switch (a.action) {
		case "launch_app": return `Open ${a.name ?? a.urls?.join(", ") ?? "an app"} on your computer`;
		case "type_text": return `Type “${String(a.text ?? "").slice(0, 300)}” on your computer${app}`;
		case "press_key": return `Press ${a.key ?? "a key"} on your computer${app}`;
		case "hotkey": return `Press ${(a.keys ?? []).join("+")} on your computer${app}`;
		case "scroll": return `Scroll ${a.direction ?? ""} on your computer${app}`;
		case "set_value": return `Set ${where} to “${String(a.value ?? "").slice(0, 300)}” on your computer${app}`;
		case "kill_app": return `Force-quit app ${a.pid} on your computer, losing what isn't saved`;
		default: return `${a.action === "click" ? "Click" : a.action === "double_click" ? "Double-click" : "Right-click"} ${where} on your computer${app}`;
	}
}

type Mcp = { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: unknown; isError?: boolean };
function mcpResult(r: Mcp): Result {
	const content: Part[] = [];
	for (const part of r.content ?? []) {
		if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: clip(part.text) });
		else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") content.push({ type: "image", data: part.data, mimeType: part.mimeType });
		else content.push({ type: "text", text: clip(JSON.stringify(part)) });
	}
	if (content.length === 0) content.push({ type: "text", text: r.structuredContent !== undefined ? clip(JSON.stringify(r.structuredContent)) : "(no content)" });
	return { content, ...(r.isError ? { isError: true } : {}) };
}
const mcpText = (r: Result) => r.content.map((p) => (p.type === "text" ? p.text : `[image ${p.mimeType}]`)).join("\n");

const reason = (error: unknown) => (error instanceof CapabilityUnavailableError ? `${error.message}. Nothing was done; the person can pair a computer in Settings → Computer.` : error instanceof Error ? error.message : String(error));

export function computerTools(deps: ComputerToolDeps, kit: ComputerToolKit): ToolRegistration[] {
	const { ownerId, partitionId } = deps;
	const owner = OwnerId.parse(ownerId);
	const { ops, principalOf } = kit;
	const tool = (name: string, description: string, parameters: any, execute: (args: any, api: any, context: any) => Promise<Result>, replay: "safe" | "unsafe" = "safe") =>
		defineTool({ name, description, parameters, replay, execute: async (args: any, api: any, context: any) => {
			try {
				return await execute(args, api, context);
			} catch (error) {
				// Both "no computer" and a computer that fails answer the model, so the turn goes on.
				return text(reason(error), true);
			}
		} } as never) as ToolRegistration;

	/** The owner's computer, wherever its socket is held; unavailable at once when none is. */
	const acquire = async (capability: string): Promise<RemoteComputer> => {
		const bus = deps.relay ? await deps.relay().catch(() => null) : null;
		return acquireRemote(bus, ownerId, capability);
	};
	/** The chat that is asking, and the principal the Authorizer knows it as. */
	const caller = async (api: any) => {
		const app = deps.app;
		if (!app) throw new Error("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot use the computer.");
		const chat = await deps.chatOf(api.conversationId);
		const p = await principalOf(app, chat);
		return { app, chat, p, thread: chat ?? String(api.conversationId) };
	};
	/** Everything that touches the computer first checks the owner may use one (agents may; guests may not). */
	const use = async (api: any, capability: string) => {
		const c = await caller(api);
		await c.app.identity.authz.enforce(c.p, "computer:use");
		return { ...c, computer: await acquire(capability) };
	};

	// ---- the approval and the once-only effect behind a gated tool ----

	type Prepared = { result: Result } | { summary: string };
	type Gated = { action: string; tool: string; resource?: Record<string, string>; args: Record<string, unknown>; prepare?: () => Promise<Prepared>; run: (computer: RemoteComputer) => Promise<{ text: string; isError?: boolean; content?: Part[] }> };
	const waiting = { content: [{ type: "text", text: "Waiting for a person's approval." }], control: { suspend: true } } as never;
	const gated = async (api: any, g: Gated): Promise<Result> => {
		const { app, chat, p } = await caller(api);
		await app.identity.authz.enforce(p, "computer:use");
		const taskId = String(api.taskId);
		// Unavailable is said before a person is asked for anything.
		await acquire(g.tool);
		// The decision: a person's, delivered as a signal that wakes this task; or a standing approval, which stands in for it.
		const signal = (await deps.runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
		if (signal && signal.payload.approved !== true) return text("A person did not approve this, so it was not done.", true);
		if (!signal) {
			const filed = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.approvals WHERE tool = $1 AND args->>'taskId' = $2 LIMIT 1", [g.action, taskId])).rows[0]?.id as string | undefined);
			if (filed) return waiting;
			let summary: string;
			if (g.prepare) {
				const prepared = await g.prepare();
				if ("result" in prepared) return prepared.result;
				summary = prepared.summary;
			} else summary = String(g.args.summary ?? g.tool);
			const gate = await app.approvals.gate(p, { action: g.action, resource: g.resource ?? {}, ...(chat ? { chatId: chat } : {}), args: { taskId, callId: api.callId, tool: g.tool, ...g.args, summary }, timeoutMs: 24 * 3600_000, onTimeout: "deny" });
			if (gate.outcome === "waiting") return waiting;
		}
		// The effect itself, once: a replay or a new owner finds its outcome on the operation, and one that was in flight is reconciled, not run again.
		const operationId = `computer:${partitionId}:${taskId}`;
		const op = await ops.begin({ operationId, ownerId: owner, partitionId: PartitionId.parse(partitionId), taskId, toolName: g.tool, capability: "computer", idempotencyKey: `pim-${ownerId}-${partitionId}-${taskId}` });
		if (op.state === "completed") return text(String((op.receipt as any)?.summary ?? "Done."), (op.receipt as any)?.isError === true);
		if (op.state === "failed" || op.state === "cancelled") return text(`It was not done: ${String((op.receipt as any)?.error ?? op.state)}`, true);
		if (op.state !== "pending") return text(`It was started, but what became of it is not known (${op.state}). It was not run again; look at the computer before asking again.`, true);
		await ops.transition(ownerId, operationId, "running");
		let computer: RemoteComputer;
		try {
			computer = await acquire(g.tool);
		} catch (error) {
			await ops.transition(ownerId, operationId, "failed", { error: reason(error) });
			return text(reason(error), true);
		}
		try {
			const done = await g.run(computer);
			await ops.transition(ownerId, operationId, "completed", { summary: done.text, isError: done.isError === true });
			return done.content ? { content: done.content, ...(done.isError ? { isError: true } : {}) } : text(done.text, done.isError === true);
		} catch (error) {
			const message = reason(error);
			// A call the computer answered with an error did not take effect as asked; one that may have run, or whose answer was lost, is left for a person.
			const unsent = error instanceof CapabilityUnavailableError || (error as { status?: number }).status === 502;
			await ops.transition(ownerId, operationId, unsent ? "failed" : "needs_reconciliation", { error: message });
			return text(unsent ? `It failed: ${message}` : `It may or may not have run on the computer (${message}). It was not run again; look at the computer before asking again.`, true);
		}
	};

	// ---- files ----

	const confined = (...paths: unknown[]) => {
		for (const path of paths) if (path !== undefined && filesPath(path) === null) return text(`${String(path)} is not one of the person's files. Use an absolute path under ${FILES_ROOT}.`, true);
		return null;
	};
	const readFile = async (c: Computer, path: string, length = MAX_READ, offset = 0): Promise<{ bytes: Buffer; size: number }> => {
		const r = await c.call<{ data: string; size: number }>("read", { path, offset, length });
		return { bytes: Buffer.from(r.data, "base64"), size: r.size };
	};
	/** Where a path under /workspace is for a command in the shell, which has no /workspace: the files' folder is a real one on the computer. */
	const whereIs = (c: Computer, path: string) => {
		const root = c.info?.root;
		return root ? `${path} is ${posix.join(root, path.slice(FILES_ROOT.length))} on the computer, which is $PIM_WORKSPACE${path.slice(FILES_ROOT.length)}.` : `${path} is under $PIM_WORKSPACE${path.slice(FILES_ROOT.length)}.`;
	};
	const conflictOf = (error: unknown): Result | null => {
		const remote = (error as { remote?: Record<string, unknown> })?.remote;
		return remote?.code === "conflict" ? text(JSON.stringify(remote.conflict ?? remote), true) : null;
	};
	const writeFile = async (c: Computer, path: string, data: Uint8Array, expectedHash?: string) => {
		await c.call("mkdir", { path: posix.dirname(path), recursive: true });
		return c.call("write", { path, data: Buffer.from(data).toString("base64"), ...(expectedHash ? { expectedHash } : {}) });
	};
	const EXPECTED_HASH = Type.Optional(Type.String({ description: `The sha256 of the file as you last read it (file_read gives it), or "absent" to only create a new file. If the file changed since, nothing is written and the result is a conflict: read it again and redo the change.` }));

	const tools: ToolRegistration[] = [
		tool("file_read", `Read a text file, from line \`offset\` (1-based) for \`limit\` lines. A picture (PNG, JPEG, WebP, GIF) is shown to you instead, scaled down if it is large. ${WHERE}`, Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }), async (a, api) => {
			const bad = confined(a.path);
			if (bad) return bad;
			const { computer } = await use(api, "file_read");
			const stat = await computer.call<{ isDirectory: boolean; sha256: string | null }>("stat", { path: a.path });
			if (stat.isDirectory) return text(`${a.path} is a folder: list it with file_list.`, true);
			const { bytes, size } = await readFile(computer, a.path, MAX_TEXT_READ);
			// As in v1, a picture is shown to the model; other binary files (a PDF, an archive) are for a program to open, so the model is told where that is.
			// A phone photo is several MB, more than one answer of the bus carries: it is read in pieces and scaled down to what a model takes. A model that cannot see pictures gets the note alone.
			if (sniffImage(bytes)) {
				if (size > MAX_IMAGE_FILE) return text(`${a.path} is a picture of ${size} bytes, more than the ${MAX_IMAGE_FILE} bytes file_read opens. To make it smaller, use shell: ${whereIs(computer, a.path)}`, true);
				const pieces = [bytes];
				for (let have = bytes.length; have < size; ) {
					const next = await readFile(computer, a.path, MAX_TEXT_READ, have);
					if (next.bytes.length === 0) break;
					pieces.push(next.bytes);
					have += next.bytes.length;
				}
				const whole = Buffer.concat(pieces);
				const fitted = await fitImage(whole);
				if (fitted) return { content: [fitted, { type: "text", text: `${a.path} (${size} bytes${fitted.data.length === Math.ceil(whole.length / 3) * 4 ? "" : "; scaled down to fit"})` }] };
			}
			if (bytes.subarray(0, 8192).includes(0)) return text(`${a.path} is a binary file (${size} bytes), not text. To open it with a program, use shell: ${whereIs(computer, a.path)}`, true);
			const lines = bytes.toString("utf8").split("\n");
			const from = (a.offset ?? 1) - 1;
			const shown = lines.slice(from, from + (a.limit ?? 2000));
			const more = from + shown.length < lines.length ? `\n[${lines.length - from - shown.length} more lines: read on with offset ${from + shown.length + 1}]` : "";
			const cut = size > bytes.length ? `\n[The file is ${size} bytes; only the first ${bytes.length} were read.]` : "";
			return text(`${clip(shown.join("\n"))}${more}${cut}${stat.sha256 ? `\nsha256 of the whole file: ${stat.sha256}` : ""}`);
		}),
		tool("file_list", `List a folder. ${WHERE}`, Type.Object({ path: Type.Optional(Type.String({ description: `Defaults to ${FILES_ROOT}.` })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }), async (a, api) => {
			const path = a.path ?? FILES_ROOT;
			const bad = confined(path);
			if (bad) return bad;
			const { computer } = await use(api, "file_list");
			const entries = await computer.call<{ name: string; size: number; isDirectory: boolean }[]>("readdir", { path, limit: a.limit ?? 500 });
			return text(entries.length ? entries.map((e) => `${e.isDirectory ? "dir " : "file"} ${e.name}${e.isDirectory ? "/" : ` (${e.size} bytes)`}`).join("\n") : "(empty)");
		}),
		tool("file_find", `Find files and folders by a glob pattern such as **/*.md. ${WHERE}`, Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }), async (a, api) => {
			const bad = confined(a.path);
			if (bad) return bad;
			const { computer } = await use(api, "file_find");
			const found = await computer.call<{ path: string; type: string }[]>("find", { pattern: a.pattern, path: a.path ?? FILES_ROOT, limit: a.limit ?? 200 });
			return text(found.length ? found.map((f) => f.path + (f.type === "dir" ? "/" : "")).join("\n") : "Nothing matches.");
		}),
		tool("file_search", `Search the text of files for a string (or a regular expression with regex). ${WHERE}`, Type.Object({ query: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()), regex: Type.Optional(Type.Boolean()), ignoreCase: Type.Optional(Type.Boolean()), include: Type.Optional(Type.Array(Type.String())), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }), async (a, api) => {
			const bad = confined(a.path);
			if (bad) return bad;
			const { computer } = await use(api, "file_search");
			const found = await computer.call<{ path: string; line: number; text: string }[]>("grep", { query: a.query, path: a.path ?? FILES_ROOT, regex: a.regex === true, ignoreCase: a.ignoreCase === true, ...(a.include ? { include: a.include } : {}), limit: a.limit ?? 100 });
			return text(found.length ? clip(found.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n")) : "Nothing matches.");
		}),
		tool("file_write", `Write a text file, creating its folders and replacing what was there. ${WHERE}`, Type.Object({ path: Type.String(), content: Type.String({ maxLength: MAX_WRITE }), expectedHash: EXPECTED_HASH }), async (a, api) => {
			const bad = confined(a.path);
			if (bad) return bad;
			if (a.path === FILES_ROOT) return text(`${FILES_ROOT} is a folder.`, true);
			const { computer } = await use(api, "file_write");
			try {
				await writeFile(computer, a.path, Buffer.from(a.content, "utf8"), a.expectedHash);
			} catch (error) {
				const conflict = conflictOf(error);
				if (conflict) return conflict;
				throw error;
			}
			return text(`Wrote ${a.path} (${Buffer.byteLength(a.content)} bytes).`);
		}),
		tool("file_edit", `Edit a text file: each of \`edits\` replaces text that occurs exactly once. ${WHERE}`, Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }), { minItems: 1 }), expectedHash: EXPECTED_HASH }), async (a, api) => {
			const bad = confined(a.path);
			if (bad) return bad;
			const { computer } = await use(api, "file_edit");
			const { bytes, size } = await readFile(computer, a.path);
			if (size > bytes.length) return text(`${a.path} is too large to edit (${size} bytes).`, true);
			let body = bytes.toString("utf8");
			for (const [i, e] of (a.edits as { oldText: string; newText: string }[]).entries()) {
				const at = body.indexOf(e.oldText);
				if (at < 0) return text(`Edit ${i + 1}: the text to replace was not found. Read the file again.`, true);
				if (body.indexOf(e.oldText, at + 1) >= 0) return text(`Edit ${i + 1}: the text to replace occurs more than once; include more around it.`, true);
				body = body.slice(0, at) + e.newText + body.slice(at + e.oldText.length);
			}
			try {
				// Held to the bytes that were read, so a change by the person in between is a conflict, not a lost edit.
				await writeFile(computer, a.path, Buffer.from(body, "utf8"), a.expectedHash || sha256(bytes));
			} catch (error) {
				const conflict = conflictOf(error);
				if (conflict) return conflict;
				throw error;
			}
			return text(`Edited ${a.path}.`);
		}, "unsafe"),
		tool("file_delete", `Delete a file or folder. ${WHERE}`, Type.Object({ path: Type.String(), recursive: Type.Optional(Type.Boolean()) }), async (a, api) => {
			const bad = confined(a.path);
			if (bad) return bad;
			if (a.path === FILES_ROOT) return text(`${FILES_ROOT} itself can't be deleted.`, true);
			return gated(api, {
				action: "computer:file_delete",
				tool: "file_delete",
				resource: { path: a.path },
				args: { path: a.path, recursive: a.recursive === true, summary: `Delete ${a.path}${a.recursive === true ? " and everything in it" : ""}` },
				run: async (c) => (await c.call("rm", { path: a.path, recursive: a.recursive === true }), { text: `Deleted ${a.path}.` }),
			});
		}),
		tool(
			"shell",
			`Run a command on the person's computer, in a bash login shell, as the user pim-computer runs as there. ${FILES_ROOT} exists only for the file tools: in the shell it is a real folder elsewhere, $PIM_WORKSPACE, where the shell starts, so ${FILES_ROOT}/uploads/a.pdf is $PIM_WORKSPACE/uploads/a.pdf there, or uploads/a.pdf from the start.`,
			Type.Object({ command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String({ description: `A folder under ${FILES_ROOT}.` })), timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COMMAND_MS / 1000 })) }),
			async (a, api) => {
				const bad = confined(a.cwd);
				if (bad) return bad;
				const timeoutMs = Math.min((a.timeout_seconds ?? DEFAULT_COMMAND_MS / 1000) * 1000, MAX_COMMAND_MS);
				const thread = (await deps.chatOf(api.conversationId)) ?? String(api.conversationId);
				return gated(api, {
					action: "computer:shell",
					tool: "shell",
					args: { command: String(a.command).slice(0, 4000), ...(a.cwd ? { cwd: a.cwd } : {}), summary: "Run a command" },
					run: async (c) => {
						const r = await c.call<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut?: boolean }>("exec", { command: a.command, timeoutMs, maxBytes: COMMAND_OUTPUT_BYTES, thread, ...(a.cwd ? { cwd: a.cwd } : {}) }, timeoutMs + 15_000);
						const status = r.timedOut ? `Stopped after ${timeoutMs / 1000} seconds` : r.exitCode === null ? `Ended by ${r.signal ?? "a signal"}` : `Exit code ${r.exitCode}`;
						const parts = [status];
						if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
						if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
						if (!r.stdout && !r.stderr) parts.push("(no output)");
						if (r.exitCode !== 0 && String(a.command).includes(FILES_ROOT)) parts.push(`Note: ${FILES_ROOT} is not a folder in the shell. The files' folder is ${c.info?.root ?? "$PIM_WORKSPACE"} here: use it, or relative paths.`);
						return { text: parts.join("\n") };
					},
				});
			},
		),
	];

	// ---- the desktop ----

	// A computer with displayd gives each chat a desktop of its own; one without it (a Cua desktop, as on a managed computer) has one, which every chat shares.
	const callDriver = async (c: RemoteComputer, tool: string, args: Record<string, unknown>, thread: string) => {
		const arguments_ = { ...args, session: sessionOf(thread) };
		try {
			return mcpResult(await c.call<Mcp>("driver", { tool, arguments: arguments_, thread }, DRIVER_CALL_MS));
		} catch (error) {
			if (!NO_DISPLAYD.test(error instanceof Error ? error.message : String(error))) throw error;
			return mcpResult(await c.call<Mcp>("driver", { tool, arguments: arguments_ }, DRIVER_CALL_MS));
		}
	};
	const driver = async (api: any, toolName: string, args: Record<string, unknown>) => {
		const { computer, thread } = await use(api, "desktop");
		return callDriver(computer, toolName, args, thread);
	};
	tools.push(
		tool("desktop_look", `See the person's computer's desktop: a screenshot, with its windows, each with its app's pid and window_id. ${DESKTOP_ABOUT}`, Type.Object({}), (_a, api) => driver(api, "get_desktop_state", {})),
		tool("desktop_read", "Read a window of an app: its elements from the accessibility tree, each numbered [N], with the snapshot id their element_token starts with. Give a `query` to list only matching elements. Without a pid, lists the running apps.", Type.Object({ pid: Type.Optional(Pid), window_id: Type.Optional(Type.Integer()), query: Type.Optional(Type.String()) }), (a, api) => (a.pid === undefined ? driver(api, "list_apps", {}) : driver(api, "get_window_state", a))),
		tool("desktop_act", `Act in an app on the person's computer's desktop: open apps, click, type, press keys, scroll. ${DESKTOP_ABOUT}`, DesktopAct, async (a, api) => {
			const { action, foreground, ...rest } = a;
			const thread = (await deps.chatOf(api.conversationId)) ?? String(api.conversationId);
			return gated(api, {
				action: "computer:desktop",
				tool: "desktop_act",
				args: { action, summary: summarizeDesktop(a) },
				run: async (c) => {
					const r = await callDriver(c, action, { ...rest, ...(foreground ? { delivery_mode: "foreground" } : {}) }, thread);
					return { text: mcpText(r), isError: r.isError === true, content: r.content };
				},
			});
		}),
	);

	// ---- the browser ----

	let current: RemoteComputer | null = null;
	let root = "";
	// References count up across pages; a process that restarts begins above anything an earlier one gave, so an approval that waited across a restart reaches the element it named or none.
	const meta = new Map<string, string>([["browser_next_ref", String(Math.floor(Date.now() / 1000))]]);
	// Each chat's browser is on a display of its own where the computer runs displayd. A computer without it (a laptop, a plain server) has one browser, the primary, which the chats
	// share, each in a window of its own; that is remembered once the computer has said so.
	let sharedBrowser = false;
	const perThread = async <T>(thread: string | undefined, run: (thread: string | undefined) => Promise<T>): Promise<T> => {
		if (!thread || sharedBrowser) return run(undefined);
		try {
			return await run(thread);
		} catch (error) {
			if (!NO_DISPLAYD.test(error instanceof Error ? error.message : String(error))) throw error;
			sharedBrowser = true;
			return run(undefined);
		}
	};
	const asBrowser: BrowserComputer = {
		paired: () => current !== null,
		status: () => ({ state: current ? "online" : "offline" }),
		browserStatus: (thread) => (current ? perThread(thread, (t) => current!.call("browser_status", t ? { thread: t } : {})) : Promise.resolve({ available: false, running: false })),
		stopBrowser: async (thread) => void (await current?.call("browser_stop", thread ? { thread } : {}).catch(() => undefined)),
		fs: { mkdir: async (path, options) => void (await current!.call("mkdir", { path, recursive: options.recursive })) },
		localPath: async (path) => {
			await current!.call("stat", { path });
			const rest = posix.relative(FILES_ROOT, posix.resolve(path));
			if (rest === "") return root;
			const sep = root.includes("\\") ? "\\" : "/";
			return `${root.replace(/[\\/]$/, "")}${sep}${rest.split("/").join(sep)}`;
		},
		connectBrowser: async (thread) => {
			const computer = current!;
			const transport: BrowserTransport = { send: () => {}, close: () => {} };
			const link = await perThread(thread, (t) => computer.openBrowser((data) => (data === null ? transport.onclose?.() : transport.onmessage?.(data)), t));
			transport.send = (message) => link.send(message);
			transport.close = () => link.close();
			return transport;
		},
	};
	const browser = new PimBrowser(asBrowser, { get: (key) => meta.get(key) ?? null, set: (key, value) => void (value === null ? meta.delete(key) : meta.set(key, value)) });
	/** A browser use: the computer is acquired first (so "unavailable" is immediate), and the browser's own failures are the model's to read. */
	const browse = async <T>(api: any, run: (chat: string, computer: RemoteComputer) => Promise<T>): Promise<T> => {
		const { computer, thread } = await use(api, "browser");
		current = computer;
		root = computer.info?.root ?? root;
		if (!computer.info?.browser) throw new Error("The person's computer has no Chrome or Chromium, so there is no browser.");
		return run(thread, computer);
	};
	const NOT_FOUND = (ref: number) => text(`There is no [${ref}] on the page now. Read the page again with browser_read and use a number it shows.`, true);
	const submitting = (api: any, action: string, args: Record<string, unknown>, prepare: (chat: string) => Promise<Prepared>, run: (chat: string) => Promise<string>) =>
		gated(api, {
			action: "computer:browser_submit",
			tool: action,
			resource: { tool: action },
			args,
			prepare: () => browse(api, (chat) => prepare(chat)),
			run: async () => (await browse(api, async (chat) => ({ text: await run(chat) }))),
		});

	tools.push(
		tool("browser_open", "Open a web page in your window of the browser and read it: its text, with what can be clicked or typed into numbered like [12 link “Prices”]. Use it for pages fetch_url can't read (built by JavaScript) and anything you need to click through. The browser is a Chrome on the person's computer that you have to yourself, with the sign-ins the person made in their own browser.", Type.Object({ url: Type.String({ pattern: "^(https?://|data:text/html)" }) }), async (a, api) => text(describePage(await browse(api, (chat) => browser.visit(chat, a.url))))),
		tool("browser_read", "Read the page your window shows now, as browser_open does: after waiting for it to change, or after the person took over.", Type.Object({}), async (_a, api) => {
			const view = await browse(api, (chat) => browser.read(chat));
			return view ? text(describePage(view)) : text("Your window is closed. Open a page with browser_open.", true);
		}),
		tool("browser_hover", "Point at an element on your window's page, by its number, for what shows only then (a menu, a tooltip); then read the page.", Type.Object({ ref: Ref }), async (a, api) => text(describePage(await browse(api, (chat) => browser.hover(chat, a.ref))))),
		tool("browser_dialog", "Answer the dialog your window's page shows (an alert, a confirm, a prompt), which holds the page until it's answered: `accept` it, with `text` for a prompt, or dismiss it. Then read the page.", Type.Object({ accept: Type.Boolean(), text: Type.Optional(Type.String({ maxLength: 2_000 })) }), async (a, api) => text(describePage(await browse(api, (chat) => browser.answerDialog(chat, a.accept, a.text))))),
		tool("browser_screenshot", "Save a picture of your window's page to the person's files. Returns where it was saved.", Type.Object({ path: Type.Optional(Type.String({ description: `Where to save the PNG, under ${FILES_ROOT}. Defaults to ${FILES_ROOT}/screenshots/, named by the time.` })) }), async (a, api) => {
			const bad = confined(a.path);
			if (bad) return bad;
			return browse(api, async (chat, computer) => {
				const png = await browser.screenshot(chat);
				if (!png) return text("Your window is closed. Open a page with browser_open.", true);
				const path = a.path ?? `${FILES_ROOT}/screenshots/${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
				await writeFile(computer, path, png);
				return text(`Saved to ${path}.`);
			});
		}),
		tool("browser_close", "Close your window when you're done with it; what's signed in there stays.", Type.Object({}), async (_a, api) => (await browse(api, (chat) => browser.close(chat)), text("Your window is closed."))),
		tool("browser_click", "Click a link, button or other element on your window's page, by its number, and read the page it leads to.", ClickArgs, (a, api) =>
			submitting(api, "browser_click", { ref: a.ref }, async (chat) => {
				const element = await browser.describe(chat, a.ref);
				if (!element) return { result: NOT_FOUND(a.ref) };
				if (!element.submits) return { result: text(describePage(await browser.click(chat, a.ref))) };
				return { summary: `On ${element.host}, click ${element.label}` };
			}, async (chat) => describePage(await browser.click(chat, a.ref)))),
		tool("browser_type", "Type into a field on your window's page, by its number, replacing what it held, and press Enter after if `submit`, or choose an option in a list by its text; then read the page. Never type passwords or payment details: the person does that when they take over.", TypeArgs, (a, api) =>
			submitting(api, "browser_type", { ref: a.ref, text: a.text, submit: a.submit === true }, async (chat) => {
				const element = await browser.describe(chat, a.ref);
				if (!element) return { result: NOT_FOUND(a.ref) };
				if (!a.submit || element.enterLoads) return { result: text(describePage(await browser.type(chat, a.ref, a.text, a.submit === true))) };
				return { summary: element.role === "list" ? `On ${element.host}, choose “${a.text}” in ${element.label} and press Enter` : `On ${element.host}, type “${a.text}” into ${element.label} and press Enter` };
			}, async (chat) => describePage(await browser.type(chat, a.ref, a.text, a.submit === true)))),
		tool("browser_upload", "Upload files from the person's files to a file field on your window's page, by its number; then read the page.", UploadArgs, async (a, api) => {
			const bad = confined(...a.paths);
			if (bad) return bad;
			return submitting(api, "browser_upload", { ref: a.ref, paths: a.paths }, async (chat) => {
				const element = await browser.describe(chat, a.ref);
				if (!element) return { result: NOT_FOUND(a.ref) };
				return { summary: `On ${element.host}, upload ${a.paths.map((p: string) => p.slice(p.lastIndexOf("/") + 1)).join(", ")} with ${element.label}` };
			}, async (chat) => {
				const files = await Promise.all((a.paths as string[]).map((p) => asBrowser.localPath(p)));
				return describePage(await browser.upload(chat, a.ref, files));
			});
		}),
	);
	return tools;
}
