import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Computer } from "../computer";
import { FILES_ROOT, filesPath } from "../files";
import { text } from "./services";

/**
 * The canvas as tools: the pane beside a chat where the person has files
 * open in the code editor. Agents open a file there for them, at a line, and
 * can look at what is open and what the person has selected, so "this
 * function" or "fix this" can be answered. The canvas is in the person's
 * browser: these reach the app that has the chat open, and without one say
 * so. They exist while the person has a computer, as the files do.
 */
export const CANVAS_EXTENSION = "pim.canvas";

/** What the app answers a question about its canvas with. */
export type CanvasAnswer = {
	/** The files open as tabs, in order; `dirty` is whether the person has typed something not yet saved. */
	readonly tabs: readonly { readonly path: string; readonly dirty: boolean }[];
	/** The file shown now, if it is one. */
	readonly active: string | null;
	/** Asked for with `selection`: where the person's cursor or selection is in the shown file. */
	readonly selection?: { readonly path: string; readonly from: { line: number; column: number }; readonly to: { line: number; column: number }; readonly text: string } | null;
};

export type CanvasServices = {
	readonly computer: Computer;
	/** Asks the apps showing the chat to open `path`, at `line`; how many were asked. */
	open(session: string, path: string, line?: number): number;
	/** Asks the app showing the chat, which answers within a few seconds; null when none does. */
	ask(session: string, what: "tabs" | "selection"): Promise<CanvasAnswer | null>;
};

const NO_APP = "No app has this chat open right now, so there is no canvas to look at. The person sees the chat when they open it.";

/** The canvas tools while the person has a computer; without one the extension has none, so chats get them once it's paired. */
export function canvasExtension(services: CanvasServices) {
	if (!services.computer.paired()) return defineExtension({ name: CANVAS_EXTENSION, tools: [] });
	const open = defineTool({
		name: "canvas_open_file",
		description: `Open one of the person's files in the canvas beside the chat, in the code editor, optionally scrolled to a line, so they can read or edit it with you. The path is absolute, under ${FILES_ROOT}. The person's edits and yours share the file: write with an expectedHash so neither overwrites the other.`,
		parameters: Type.Object({
			path: Type.String({ description: `The file, under ${FILES_ROOT}.` }),
			line: Type.Optional(Type.Integer({ minimum: 1, description: "The line to show, counting from 1." })),
		}),
		replay: "safe",
		async execute({ path, line }, api) {
			const resolved = filesPath(path);
			if (resolved === null) return text(`${path} is not one of the person's files. Use an absolute path under ${FILES_ROOT}.`, true);
			try {
				const stat = await services.computer.fs.stat(resolved);
				if (!stat.isFile) return text(`${resolved} is not a file.`, true);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
			const told = services.open(String(api.conversationId), resolved, line);
			return text(told > 0 ? `Opened ${resolved}${line ? ` at line ${line}` : ""} in the person's canvas.` : `${NO_APP} Link the file in your message instead: [${resolved}](${resolved}).`);
		},
	});
	const list = defineTool({
		name: "canvas_list_open",
		description: "List the files open in the person's canvas, which one is shown, and which have changes the person hasn't saved yet.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			const answer = await services.ask(String(api.conversationId), "tabs");
			if (!answer) return text(NO_APP);
			if (answer.tabs.length === 0) return text("Nothing is open in the canvas.");
			return text(answer.tabs.map((tab) => `${tab.path}${tab.path === answer.active ? " (shown)" : ""}${tab.dirty ? " (unsaved changes)" : ""}`).join("\n"));
		},
	});
	const selection = defineTool({
		name: "canvas_get_selection",
		description: "Read where the person's cursor is, or what they have selected, in the file shown in the canvas. Use it when they refer to something in the editor, such as \"this function\" or \"here\". It reads the editor now; the selection isn't sent with their messages.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			const answer = await services.ask(String(api.conversationId), "selection");
			if (!answer) return text(NO_APP);
			const { selection: picked } = answer;
			if (!picked) return text(answer.active ? `Nothing is selected in ${answer.active}.` : "No file is shown in the canvas.");
			const { from, to } = picked;
			const where = from.line === to.line && from.column === to.column ? `cursor at line ${from.line}, column ${from.column}` : `selected from line ${from.line}, column ${from.column} to line ${to.line}, column ${to.column}`;
			return text(`${picked.path}: ${where}${picked.text === "" ? "" : `\n${picked.text}`}`);
		},
	});
	return defineExtension({ name: CANVAS_EXTENSION, tools: [open, list, selection] });
}
