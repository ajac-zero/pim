/**
 * The tools that read, change and list the person's notes, with v1's parameters (`src/extensions/notes.ts`): `note_read` takes a version and an offset, `note_edit` takes
 * edits, an append, the whole content or a new title, and `note_list` takes words of the title. The text itself is the Canvas's Yjs document (`@pim/v2-app/canvas`), so what the
 * person types while the agent writes is kept.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

/** How much of a note one read returns, so a long one doesn't fill the context at once. */
export const NOTE_READ_CHARS = 60_000;
export const MAX_NOTES_LISTED = 200;

export function noteTools(deps: { ownerId: string; read: Define; write: Define; card: (app: App, id: string, note: string) => Promise<Result> }): ToolRegistration[] {
	const { ownerId, read, write, card } = deps;
	const S = Type.String;
	const O = Type.Optional;
	return [
		read("note_read", `Read a note as it is now, with what the person typed in it, or an older version. Long ones come in parts of ${NOTE_READ_CHARS} characters: pass offset for the next.`, Type.Object({ id: S(), version: O(Type.Integer({ minimum: 1 })), offset: O(Type.Integer({ minimum: 0 })) }), async (app, _call, a) => {
			const offset = a.offset ?? 0;
			const found = await app.canvas.kept(ownerId, a.id, a.version).catch((error) => {
				if ((error as { status?: number }).status === 404) return undefined;
				throw error;
			});
			if (!found) return text(a.version === undefined ? `No note ${a.id}. Find it with note_list.` : `No version ${a.version} of note ${a.id}.`, true);
			// The live text, which the person may have typed in since the last version, is what the latest version was just made from.
			const by = found.source === "person" ? " (the person's)" : found.source === "restore" ? ` (the person restored version ${found.restoredFrom})` : "";
			const part = found.text.slice(offset, offset + NOTE_READ_CHARS);
			const rest = found.text.length - offset - part.length;
			const header = `Note ${a.id} "${found.title}", version ${found.version} of ${found.latest}${by}, ${found.text.length} characters${offset > 0 ? `, from ${offset}` : ""}:`;
			return text(`${header}\n${part}${rest > 0 ? `\n[... ${rest} more characters: read again with offset ${offset + part.length}]` : ""}`);
		}),
		write("note_edit", "Change a note, as the person sees it at once: edits (find-and-replace pairs, each find exactly as note_read gave it and appearing once, applied together or not at all), append (text added at the end), or content (the whole new text, only when base_version is the latest). title renames it. A person's typing meanwhile is never lost: edits and append land on the note as it is now. find and replace alone are one edit. The answer is the note's card in the chat, which is how the person sees and opens it; you can't open a panel, so don't say you did.", Type.Object({
			id: S(),
			base_version: O(Type.Integer({ minimum: 1, description: "The version you read; needed only with content." })),
			edits: O(Type.Array(Type.Object({ find: S({ minLength: 1 }), replace: S() }), { minItems: 1, maxItems: 50 })),
			find: O(S({ minLength: 1 })),
			replace: O(S()),
			append: O(S({ minLength: 1 })),
			content: O(S()),
			title: O(S({ minLength: 1, maxLength: 200 })),
		}), async (app, call, a) => {
			if ((a.find === undefined) !== (a.replace === undefined)) return text("Give find and replace together.", true);
			if (a.find !== undefined && a.edits !== undefined) return text("Give edits, or find and replace, not both.", true);
			const edits = a.edits ?? (a.find === undefined ? undefined : [{ find: a.find, replace: a.replace }]);
			const { version, changed } = await app.canvas.change(call.p, a.id, { edits, append: a.append, content: a.content, title: a.title, baseVersion: a.base_version });
			return card(app, a.id, changed ? `Made version ${version}; the person sees it in the note as it lands.` : `Nothing changed, so this is still version ${version}.`);
		}),
		read("note_list", "List the person's notes, most recently changed first: id, title, latest version and size. Give query to find ones by title.", Type.Object({ query: O(S({ description: "Words the title has, in any case and order." })) }), async (app, call, a) => {
			const words = String(a.query ?? "").split(/\s+/).filter(Boolean);
			const { total, notes } = await app.canvas.list(call.p, words, MAX_NOTES_LISTED);
			if (notes.length === 0) return text(words.length > 0 ? `No note's title has ${words.join(" and ")}.` : "No notes yet.");
			return text(`${notes.map((n) => `- ${n.title} (id ${n.id}, version ${n.version}, ${n.size} bytes)`).join("\n")}${total > notes.length ? `\nNewest ${notes.length} of ${total} notes. Narrow it with query.` : ""}`);
		}),
	];
}
