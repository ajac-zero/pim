import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { type ArtifactStore, type ArtifactVersion, checkTitle } from "../artifacts";
import { HttpError } from "../http";
import type { NoteStore } from "../notes";
import { text } from "./services";

/**
 * Notes, Pim's built-in app for the person's documents: plans, lists,
 * drafts, research. Every agent has its tools, and its skill, which says
 * how to write in notes well; the prompt lists the skill, and the agent
 * loads it with `read_skill` (see ./app-skills.ts). A note is stored as an
 * app of kind `markdown`, and its live text is in ../notes.ts.
 */

/** What the note tools need from the space. */
export type NoteServices = {
	readonly artifacts: ArtifactStore;
	readonly notes: NoteStore;
	/** Throws once the space is being erased: work still under way then writes nothing. */
	assertOpen(): void;
};

/** A skill a built-in app brings, which every agent can load. */
export type BuiltinSkill = {
	/** The app that brings it, as `read_skill` takes it. */
	readonly app: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
};

export const NOTES_SKILL: BuiltinSkill = {
	app: "notes",
	name: "notes",
	description: "How to write in the person's notes, which they edit with you live: when to start one, how to change one without losing their typing, and how to draw diagrams and pictures in one.",
	instructions: `# Notes

Notes are the person's documents in Pim: plans, lists, drafts, research, meeting notes. They're Markdown, and the person may have a note open and be typing in it while you work: they see your changes as you make them, and you see theirs the next time you read it.

## When to write a note
- Write a note for anything the person will come back to or keep working on: a plan, a list, a draft, a summary of what you found. Answer in the chat for what they only need to read once.
- Before starting one, look for a note on the same topic with note_list, and add to it rather than making another.
- note_create and note_edit show the note in the chat. Say in a sentence what you wrote or changed; don't repeat the note's text in the chat. note_show shows a note again, such as one from another chat.

## Changing a note
- Read it with note_read right before you change it: the person may have changed it since you last looked.
- Change it with edits: find-and-replace pairs, each find copied exactly from what you read and long enough to appear once. They land where the text is now, so what the person typed elsewhere stays.
- Add to the end with append.
- Give content, the whole text, only when the person asked you to rewrite the note. It's refused if the note changed since base_version, so their typing is never lost unseen.
- Keep the person's words: don't reformat, reorder or tidy what they wrote unless they ask.

## Writing in one
- Use Markdown: headings, lists, task lists (\`- [ ]\`), tables, links, code. Images and raw HTML aren't shown. The note's title is its own; the text needn't repeat it.
- Draw a diagram with a \`\`\`mermaid block (flowchart, sequenceDiagram, gantt, timeline, mindmap and so on), without another fence around it.
- Draw a picture, a logo or a chart with an \`\`\`svg block: one <svg> element with a viewBox, inline and self-contained, since it loads nothing from elsewhere.
- The person sees blocks drawn when they preview the note, and as source while they write.
- Don't put passwords, codes or personal details in a note unless the person asks.`,
};

/** How much of a note one read returns, so a long one doesn't fill the context at once. */
const READ_CHARS = 60_000;

/** A tool's answer about a note's version: a reference the web app shows as the note, never its text. */
function reference(version: ArtifactVersion, title: string, note: string) {
	return text(
		JSON.stringify({
			artifact: { id: version.artifact, title, kind: "markdown", version: version.version, sha256: version.sha256, size: version.size },
			note,
		}),
	);
}

function failure(error: unknown) {
	if (error instanceof HttpError) return text(error.message, true);
	throw error;
}

export function notesExtension({ artifacts, notes, assertOpen }: NoteServices) {
	/** The note `id` names, refusing any other app. */
	const noteOf = (id: string) => {
		const found = artifacts.get(id);
		if (!found || found.kind !== "markdown") throw new HttpError(404, `No note ${id}. Find it with note_list.`);
		return found;
	};

	const create = defineTool({
		name: "note_create",
		description: "Start a note: a Markdown document the person keeps and writes in with you, live. Look for one on the topic with note_list first.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 200 }),
			content: Type.String({ description: "Its Markdown." }),
		}),
		replay: "safe",
		async execute({ title, content }, api, context) {
			const id = await api.memo("note", crypto.randomUUID(), context);
			try {
				assertOpen();
				const name = checkTitle(title);
				const version = await artifacts.create({ id, title: name, kind: "markdown", content, session: String(api.conversationId) });
				return reference(version, name, `Started note ${id}, version 1. The person sees it in the chat.`);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const read = defineTool({
		name: "note_read",
		description: `Read a note as it is now, with what the person typed in it, or an older version. Long ones come in parts of ${READ_CHARS} characters: pass offset for the next.`,
		parameters: Type.Object({
			id: Type.String(),
			version: Type.Optional(Type.Integer({ minimum: 1 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		replay: "safe",
		async execute({ id, version, offset = 0 }) {
			try {
				noteOf(id);
				// What the person typed since the last version becomes a version of theirs first, so the latest is what's read.
				const content = version === undefined ? await notes.read(id) : undefined;
				const found = artifacts.version(id, version);
				if (!found) throw new HttpError(404, `No version ${version} of note ${id}.`);
				const summary = artifacts.get(id)!;
				const body = content ?? (await artifacts.text(id, found.version));
				const by = found.source === "person" ? " (the person's)" : found.source === "restore" ? ` (the person restored version ${found.restoredFrom})` : "";
				const part = body.slice(offset, offset + READ_CHARS);
				const rest = body.length - offset - part.length;
				const header = `Note ${id} "${summary.title}", version ${found.version} of ${summary.version}${by}, ${body.length} characters${offset > 0 ? `, from ${offset}` : ""}:`;
				const more = rest > 0 ? `\n[... ${rest} more characters: read again with offset ${offset + part.length}]` : "";
				return text(`${header}\n${part}${more}`);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const edit = defineTool({
		name: "note_edit",
		description:
			"Change a note, as the person sees it at once: edits (find-and-replace pairs, each find exactly as note_read gave it and appearing once), append (text added at the end), or content (the whole new text, only when base_version is the latest). title renames it.",
		parameters: Type.Object({
			id: Type.String(),
			base_version: Type.Integer({ minimum: 1, description: "The version you read." }),
			edits: Type.Optional(Type.Array(Type.Object({ find: Type.String({ minLength: 1 }), replace: Type.String() }), { minItems: 1, maxItems: 50 })),
			append: Type.Optional(Type.String({ minLength: 1 })),
			content: Type.Optional(Type.String()),
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		}),
		replay: "safe",
		async execute({ id, base_version, edits, append, content, title }, api) {
			try {
				assertOpen();
				noteOf(id);
				if (content !== undefined && (edits !== undefined || append !== undefined)) throw new HttpError(400, "Send content alone, or edits and append.");
				if (edits === undefined && append === undefined && content === undefined && title === undefined) {
					throw new HttpError(400, "Send edits, append, content or title: something to change.");
				}
				const { version, changed } = await notes.write(id, {
					baseVersion: base_version,
					...(edits !== undefined ? { edits } : {}),
					...(append !== undefined ? { append } : {}),
					...(content !== undefined ? { content } : {}),
					...(title !== undefined ? { title: checkTitle(title) } : {}),
					source: "agent",
					callId: api.callId,
				});
				return reference(
					version,
					artifacts.get(id)!.title,
					changed ? `Made version ${version.version}; the person sees it in the note as it lands.` : `Nothing changed, so this is still version ${version.version}.`,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const list = defineTool({
		name: "note_list",
		description: "List the person's notes, most recently changed first: id, title, latest version and size. Give query to find ones by title.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Words the title has, in any case and order." })),
		}),
		replay: "safe",
		async execute({ query }) {
			const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const found = artifacts
				.list()
				.filter((artifact) => artifact.kind === "markdown" && words.every((word) => artifact.title.toLowerCase().includes(word)));
			if (found.length === 0) return text(words.length > 0 ? `No note's title has ${words.join(" and ")}.` : "No notes yet.");
			return text(found.map((note) => `- ${note.title} (id ${note.id}, version ${note.version}, ${note.size} bytes)`).join("\n"));
		},
	});

	const show = defineTool({
		name: "note_show",
		description: "Show the person a note that already exists, such as one from another chat, as the card in this chat that opens it. It changes nothing.",
		parameters: Type.Object({ id: Type.String() }),
		replay: "safe",
		async execute({ id }) {
			try {
				const summary = noteOf(id);
				return reference(artifacts.version(id)!, summary.title, `Showed version ${summary.version}. The person sees it in the chat.`);
			} catch (error) {
				return failure(error);
			}
		},
	});

	return defineExtension({
		name: "pim.notes",
		sections: [
			section(
				"notes",
				() =>
					`Notes is one of Pim's built-in apps: the person's documents, which they write in with you, live. Its skill, notes: ${NOTES_SKILL.description} Load it with read_skill (app notes, skill notes) before you first write in a note.`,
			),
		],
		tools: [create, read, edit, list, show],
	});
}
