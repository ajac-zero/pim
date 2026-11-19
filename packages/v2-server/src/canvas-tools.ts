/**
 * The canvas as tools, ported from v1 (`src/extensions/canvas.ts`): the pane beside a chat where the person has files open in the code editor. An agent opens a file there, at a line,
 * and looks at what is open and what the person has selected, so "this function" or "fix this" can be answered. The canvas is in the person's browser: these reach the app that has the
 * chat open through the notices of `app.notices` (the app answers a question with `canvas_answer`), and without one they say so. They need a paired computer, as the files do.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import { acquireRemote, type RelayBus } from "@pim/v2-app/relay";
import type { Principal } from "@pim/v2-contracts/identity";
import { FILES_ROOT, filesPath } from "./computer-tools.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

const NO_APP = "No app has this chat open right now, so there is no canvas to look at. The person sees the chat when they open it.";
/** How long the app has to answer a question about its canvas. */
const ANSWER_MS = 5_000;

type Where = { line: number; column: number };
/** What the app answers a question about its canvas with (`CanvasAnswer` in the web app). */
type Answer = { tabs?: { path: string; dirty: boolean }[]; active?: string | null; selection?: { path: string; from: Where; to: Where; text: string } | null };

export function canvasTools(deps: { ownerId: string; read: Define; relay?: (() => Promise<RelayBus>) | undefined }): ToolRegistration[] {
	const { ownerId, read } = deps;
	const S = Type.String;
	/** The owner's computer, or why there is none: the canvas shows the person's files, which are on it. */
	const computer = async (app: App, call: Call) => {
		await app.identity.authz.enforce(call.p, "computer:use");
		return acquireRemote(deps.relay ? await deps.relay().catch(() => null) : null, ownerId, "canvas");
	};
	const ask = async (app: App, call: Call, what: "tabs" | "selection"): Promise<Answer | null> => {
		if (!call.chat) return null;
		const answer = await app.notices.ask(ownerId, "canvas_query", { session: call.chat, what }, ANSWER_MS);
		return answer === null ? null : (answer as Answer);
	};
	const unpaired = (error: unknown) => text(`${error instanceof Error ? error.message : String(error)}. The canvas shows the person's files, which are on their computer: they can pair one in Settings → Computer.`, true);

	return [
		read("canvas_open_file", `Open one of the person's files in the canvas beside the chat, in the code editor, optionally scrolled to a line, so they can read or edit it with you. The path is absolute, under ${FILES_ROOT}. The person's edits and yours share the file: write with an expectedHash so neither overwrites the other.`, Type.Object({ path: S({ description: `The file, under ${FILES_ROOT}.` }), line: Type.Optional(Type.Integer({ minimum: 1, description: "The line to show, counting from 1." })) }), async (app, call, a) => {
			const resolved = filesPath(a.path);
			if (resolved === null) return text(`${a.path} is not one of the person's files. Use an absolute path under ${FILES_ROOT}.`, true);
			try {
				const stat = await (await computer(app, call)).call<{ isDirectory?: boolean }>("stat", { path: resolved });
				if (stat.isDirectory) return text(`${resolved} is not a file.`, true);
			} catch (error) {
				return unpaired(error);
			}
			if (!call.chat) return text(`${NO_APP} Link the file in your message instead: [${resolved}](${resolved}).`);
			// A notice is a hint, said to every app of the person's that is open; the one showing this chat opens the file.
			app.notices.publish(ownerId, "canvas_open", { session: call.chat, path: resolved, ...(a.line ? { line: a.line } : {}) });
			return text(`Asked the app showing this chat to open ${resolved}${a.line ? ` at line ${a.line}` : ""} in the person's canvas. If no app has the chat open, link the file in your message instead: [${resolved}](${resolved}).`);
		}),
		read("canvas_list_open", "List the files open in the person's canvas, which one is shown, and which have changes the person hasn't saved yet.", Type.Object({}), async (app, call) => {
			try {
				await computer(app, call);
			} catch (error) {
				return unpaired(error);
			}
			const answer = await ask(app, call, "tabs");
			if (!answer) return text(NO_APP);
			const tabs = answer.tabs ?? [];
			if (tabs.length === 0) return text("Nothing is open in the canvas.");
			return text(tabs.map((tab) => `${tab.path}${tab.path === answer.active ? " (shown)" : ""}${tab.dirty ? " (unsaved changes)" : ""}`).join("\n"));
		}),
		read("canvas_get_selection", "Read where the person's cursor is, or what they have selected, in the file shown in the canvas. Use it when they refer to something in the editor, such as \"this function\" or \"here\". It reads the editor now; the selection isn't sent with their messages.", Type.Object({}), async (app, call) => {
			try {
				await computer(app, call);
			} catch (error) {
				return unpaired(error);
			}
			const answer = await ask(app, call, "selection");
			if (!answer) return text(NO_APP);
			const picked = answer.selection;
			if (!picked) return text(answer.active ? `Nothing is selected in ${answer.active}.` : "No file is shown in the canvas.");
			const { from, to } = picked;
			const where = from.line === to.line && from.column === to.column ? `cursor at line ${from.line}, column ${from.column}` : `selected from line ${from.line}, column ${from.column} to line ${to.line}, column ${to.column}`;
			return text(`${picked.path}: ${where}${picked.text === "" ? "" : `\n${picked.text}`}`);
		}),
	];
}
