import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
	ARTIFACT_KINDS,
	type ArtifactKind,
	type ArtifactStore,
	type ArtifactVersion,
	applyEdits,
	checkFiles,
	checkKind,
	checkPath,
	checkTitle,
	ENTRY_FILES,
	type FileContents,
	fileType,
	isTextType,
	MAX_ARTIFACT_FILES,
} from "../artifacts";
import { JSX_MODULES } from "../artifact-jsx";
import { HttpError } from "../http";
import { definePimExtension } from "./define";
import { text } from "./services";

/** What the artifact tools need from the space. */
export type ArtifactServices = {
	readonly artifacts: ArtifactStore;
	/** Throws once the space is being erased: work still under way then writes nothing. */
	assertOpen(): void;
	/** A file from the person's files, by its path there, for an artifact to have a copy of. */
	readFile(path: string): Promise<Uint8Array>;
};

/** How much of an artifact one read returns, so a large one doesn't fill the context at once. */
const READ_CHARS = 60_000;

const HOW_IT_RUNS =
	"An HTML artifact is a page, index.html: put its CSS in <style> and its JavaScript in <script>, or in files of its own (see files). " +
	"It runs in a sandbox: fetch and XMLHttpRequest are blocked, even for its own files and data: URLs, and so are forms, anything from the web (scripts, stylesheets, fonts, images), cookies, localStorage and alert(). " +
	"That doesn't stop it sending data out: it can still navigate itself away, so treat what it contains, and what the user types into it, as possibly visible to others. " +
	"Don't put passwords, codes or personal details in an artifact unless the user asks. " +
	"Images must be inline (data: URLs or SVG) or files of its own. It shows in the chat and on a full screen, including on phones, so make it responsive. " +
	"Markdown artifacts are documents; images and raw HTML in them aren't rendered. " +
	"An svg artifact is one <svg> element, for a drawing, a logo or an illustration. " +
	"A mermaid artifact is Mermaid source (flowchart, sequenceDiagram, gantt, mindmap, and so on), for a diagram, drawn for the user; don't wrap it in a code fence. " +
	"Any artifact but Markdown can use window.pim, whose calls return promises and can fail: " +
	"pim.storage.get(key), .set(key, text), .delete(key) and .list(prefix) keep text that stays across visits and new versions (up to 1 MB; JSON.stringify anything else); " +
	"pim.shared has the same calls, for text everyone the user shares the artifact with sees and changes (a family list, scores); it's the user's own when nobody else uses it; " +
	"pim.ask(prompt) answers with text from Pim's model, which has no tools and sees only the prompt; " +
	"pim.tools.call(name, input) runs one of the user's app tools that runs without asking, by its tool name, and answers with its result as text. " +
	"The user is asked once per version before ask or a tool first runs; tools that ask before they run can't be used. Show a message when a call fails. " +
	"On a dashboard (see update_dashboard), pim.chat(text) puts a message about the artifact in the box under it, for the user to send or change, such as \"Tell me more about <headline>\" when they click one; it sends nothing itself, and fails anywhere else. " +
	`A jsx artifact is a React app, App.jsx: \`export default function App() { ... }\`, with hooks from "react". It may import ${JSX_MODULES.map((name) => `"${name}"`).join(", ")} (charts and icons), and its own files, and is styled with Tailwind classes. It's compiled when you save it: a compile error comes back to you to fix. ` +
	"HTML and JSX artifacts can have more files than the main one, by relative path (\"app.js\", \"components/Chart.jsx\", \"data.json\", \"images/logo.png\"): " +
	"a page loads its own with <script src=\"app.js\">, <link rel=\"stylesheet\" href=\"style.css\"> and <img src=\"images/logo.png\">, and reads data from <script type=\"application/json\" id=\"data\" src=\"data.json\"> (JSON.parse(document.getElementById(\"data\").textContent)), and keeps markup it reuses in <template> elements in index.html, not files of its own; " +
	"an app imports them: import Chart from \"./components/Chart\", import rows from \"./data.json\", import \"./styles.css\", import logo from \"./logo.png\" (a URL). " +
	"Give a file's content as text, or from_file: a path in the user's files (/workspace/...) to copy, for an image or a dataset the user has. Split a large app into files, and change one with edits and path.";

/** A new file, as the model gives it: text, or a copy of one of the user's files. */
const FileInput = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 200 }),
	content: Type.Optional(Type.String()),
	from_file: Type.Optional(Type.String({ description: "A path in the user's files, such as /workspace/photos/logo.png, to copy." })),
});

/** A tool's answer about a version: a reference the app shows as the artifact, never its content. */
function reference(version: ArtifactVersion, title: string, kind: string, note: string) {
	return text(
		JSON.stringify({
			artifact: {
				id: version.artifact,
				title,
				kind,
				version: version.version,
				sha256: version.sha256,
				size: version.size,
				...(version.files.length > 1 ? { files: version.files.map((file) => file.path) } : {}),
			},
			note,
		}),
	);
}

function failure(error: unknown) {
	if (error instanceof HttpError) return text(error.message, true);
	throw error;
}

export function artifactsExtension({ artifacts, assertOpen, readFile }: ArtifactServices) {
	/** The files the model gave, as contents by path. */
	const contentsOf = async (files: readonly { path: string; content?: string; from_file?: string }[] = []): Promise<Record<string, string | Uint8Array>> => {
		if (files.length > MAX_ARTIFACT_FILES) throw new HttpError(413, `An artifact can have at most ${MAX_ARTIFACT_FILES} files.`);
		const contents: Record<string, string | Uint8Array> = {};
		for (const file of files) {
			const path = checkPath(file.path);
			if ((file.content === undefined) === (file.from_file === undefined)) throw new HttpError(400, `${path}: give either content or from_file.`);
			contents[path] = file.content ?? (await readFile(file.from_file!));
		}
		return contents;
	};

	/** Refuses a version its kind can't show, checked with all its files. */
	const check = async (kind: ArtifactKind, put: FileContents, base?: { id: string; version: number }, remove: readonly string[] = []) => {
		const encoder = new TextEncoder();
		const files = new Map(base ? await artifacts.read(base.id, base.version) : []);
		for (const path of remove) files.delete(path);
		for (const [path, content] of Object.entries(put)) {
			files.set(path, { type: fileType(path), bytes: typeof content === "string" ? encoder.encode(content) : content });
		}
		checkFiles(kind, files);
	};

	const create = defineTool({
		name: "artifact_create",
		description: `Make an artifact: a document or small interactive page (an app, a chart, a game, a report) the user can open, keep, and get new versions of. Use it for anything the user will look at or use again, rather than pasting long HTML into the chat. content is its main file. ${HOW_IT_RUNS}`,
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 200 }),
			kind: Type.Union(ARTIFACT_KINDS.map((kind) => Type.Literal(kind))),
			content: Type.String({ description: "The main file: index.html, README.md, image.svg, diagram.mmd or App.jsx, by kind." }),
			files: Type.Optional(Type.Array(FileInput, { maxItems: MAX_ARTIFACT_FILES, description: "Its other files, for an HTML or JSX artifact." })),
		}),
		replay: "safe",
		async execute({ title, kind, content, files }, api, context) {
			const id = await api.memo("artifact", crypto.randomUUID(), context);
			try {
				assertOpen();
				const name = checkTitle(title);
				const others = await contentsOf(files);
				if (ENTRY_FILES[checkKind(kind)] in others) throw new HttpError(400, `${ENTRY_FILES[kind]} is the main file: give it as content.`);
				await check(kind, { ...others, [ENTRY_FILES[kind]]: content });
				const version = await artifacts.create({ id, title: name, kind, content, files: others, session: String(api.conversationId) });
				return reference(version, name, kind, `Created artifact ${id}, version 1. The user sees it in the chat.`);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const update = defineTool({
		name: "artifact_update",
		description:
			"Make a new version of an artifact. Give base_version, the version you read or made last; if it's no longer the latest, read the artifact again. " +
			"Change one file with edits (each find text must appear exactly once; best for small changes) or its whole new content: the main file, unless path names another. " +
			"files adds or replaces whole files, and delete_files removes them. Files you don't mention stay as they are. Older versions are kept.",
		parameters: Type.Object({
			id: Type.String(),
			base_version: Type.Integer({ minimum: 1 }),
			path: Type.Optional(Type.String({ description: "The file edits or content change; the main file when left out." })),
			edits: Type.Optional(Type.Array(Type.Object({ find: Type.String({ minLength: 1 }), replace: Type.String() }), { minItems: 1, maxItems: 50 })),
			content: Type.Optional(Type.String()),
			files: Type.Optional(Type.Array(FileInput, { maxItems: MAX_ARTIFACT_FILES })),
			delete_files: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_ARTIFACT_FILES })),
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		}),
		replay: "safe",
		async execute({ id, base_version, path, edits, content, files, delete_files, title }, api) {
			try {
				assertOpen();
				if (edits !== undefined && content !== undefined) throw new HttpError(400, "Send either edits or content, not both.");
				if (edits === undefined && content === undefined && files === undefined && delete_files === undefined && title === undefined) {
					throw new HttpError(400, "Send edits, content, files or delete_files: something to change.");
				}
				const latest = artifacts.version(id);
				if (!latest) throw new HttpError(404, `No artifact ${id}. List the artifacts to find it.`);
				const kind = artifacts.get(id)!.kind;
				const target = path === undefined ? ENTRY_FILES[kind] : checkPath(path);
				const put: Record<string, string | Uint8Array> = await contentsOf(files);
				// Edits apply to the version they were based on, which must be the latest; append checks that again.
				const base = base_version === latest.version ? latest : undefined;
				if (content !== undefined) put[target] = content;
				else if (edits !== undefined && base) {
					if (!base.files.some((file) => file.path === target)) throw new HttpError(404, `Version ${base.version} has no file ${target}.`);
					put[target] = applyEdits(await artifacts.text(id, base.version, target), edits);
				}
				if (base) await check(kind, put, { id, version: base.version }, delete_files);
				const { version, changed } = await artifacts.append(id, {
					baseVersion: base_version,
					files: put,
					...(delete_files ? { remove: delete_files } : {}),
					source: "agent",
					callId: api.callId,
					...(title !== undefined ? { title: checkTitle(title) } : {}),
				});
				const summary = artifacts.get(id)!;
				return reference(
					version,
					summary.title,
					summary.kind,
					changed ? `Made version ${version.version}.` : `The content is unchanged, so this is still version ${version.version}.`,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const read = defineTool({
		name: "artifact_read",
		description: `Read an artifact's source: the latest version, or the one asked for; its main file, unless path names another. Long ones come in parts of ${READ_CHARS} characters: pass offset for the next.`,
		parameters: Type.Object({
			id: Type.String(),
			version: Type.Optional(Type.Integer({ minimum: 1 })),
			path: Type.Optional(Type.String()),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		replay: "safe",
		async execute({ id, version, path, offset = 0 }) {
			const found = artifacts.version(id, version);
			if (!found) return text(version === undefined ? `No artifact ${id}.` : `No version ${version} of artifact ${id}.`, true);
			const summary = artifacts.get(id)!;
			const target = path ?? ENTRY_FILES[summary.kind];
			const file = found.files.find((candidate) => candidate.path === target);
			if (!file) return text(`Version ${found.version} has no file ${target}. Its files: ${found.files.map((candidate) => candidate.path).join(", ")}.`, true);
			const by = found.source === "person" ? " (edited by the user)" : found.source === "restore" ? ` (the user restored version ${found.restoredFrom})` : "";
			const listing =
				found.files.length > 1 ? `\nIts files: ${found.files.map((candidate) => `${candidate.path} (${candidate.size} bytes)`).join(", ")}.` : "";
			if (!isTextType(file.type)) {
				return text(`Artifact ${id} "${summary.title}" (${summary.kind}), version ${found.version} of ${summary.version}${by}: ${target} is a ${file.type} file of ${file.size} bytes, not text.${listing}`);
			}
			const content = await artifacts.text(id, found.version, target);
			const part = content.slice(offset, offset + READ_CHARS);
			const rest = content.length - offset - part.length;
			const header = `Artifact ${id} "${summary.title}" (${summary.kind}), version ${found.version} of ${summary.version}${by}, ${target}, ${content.length} characters${offset > 0 ? `, from ${offset}` : ""}:${listing}`;
			const more = rest > 0 ? `\n[... ${rest} more characters: read again with offset ${offset + part.length}]` : "";
			return text(`${header}\n${part}${more}`);
		},
	});

	const show = defineTool({
		name: "artifact_show",
		description:
			"Show the user an artifact that already exists, such as one made in another chat, as the card in this chat that opens it beside the chat: the latest version, or the one asked for. It changes nothing; don't make a new version just to show one. Find its id with artifact_list.",
		parameters: Type.Object({
			id: Type.String(),
			version: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
		replay: "safe",
		async execute({ id, version }) {
			const found = artifacts.version(id, version);
			if (!found) return text(version === undefined ? `No artifact ${id}.` : `No version ${version} of artifact ${id}.`, true);
			const summary = artifacts.get(id)!;
			return reference(found, summary.title, summary.kind, `Showed version ${found.version}. The user sees it in the chat.`);
		},
	});

	const list = defineTool({
		name: "artifact_list",
		description: "List the user's artifacts, made in any chat: id, title, kind, latest version and size, most recently changed first. Give query to find ones by title.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Words the title has, in any case and order." })),
		}),
		replay: "safe",
		async execute({ query }) {
			const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const all = artifacts.list().filter((artifact) => words.every((word) => artifact.title.toLowerCase().includes(word)));
			if (all.length === 0) return text(words.length > 0 ? `No artifact's title has ${words.join(" and ")}.` : "No artifacts yet.");
			return text(
				all
					.map(
						(artifact) =>
							`- ${artifact.title} (id ${artifact.id}, ${artifact.kind}, version ${artifact.version}, ${artifact.size} bytes${artifact.files > 1 ? `, ${artifact.files} files` : ""})`,
					)
					.join("\n"),
			);
		},
	});

	return defineExtension({ name: "pim.artifacts", tools: [create, update, read, show, list] });
}

const KIND_NAMES: Record<ArtifactKind, string> = { html: "HTML", markdown: "Markdown", svg: "SVG", mermaid: "Diagram", jsx: "App" };

/**
 * On a dashboard: what the space made most recently. Artifacts made outside
 * any chat are the majordomo's. It has no description, so agents don't show
 * it in chats: it leaves out what other agents' chats made, so an agent
 * shows one artifact with `artifact_show` instead.
 */
export function artifactsWidgets(artifacts: ArtifactStore) {
	return definePimExtension({
		id: "pim.artifacts",
		name: "Artifacts",
		description: "Documents and small pages Pim makes, with every version kept.",
		widgets: {
			recent: {
				title: { en: "Recently made", es: "Hecho recientemente" },
				empty: { en: "Nothing made yet. Ask for a document, a checklist or a small page.", es: "Nada hecho aún. Pide un documento, una lista o una página pequeña." },
				load: ({ agent, chatOf }) => ({
					kind: "list",
					items: artifacts
						.list()
						.filter((artifact) => (artifact.session === null ? agent.majordomo : chatOf(artifact.session) !== null))
						.sort((a, b) => b.updatedAt - a.updatedAt)
						.slice(0, 5)
						.map((artifact) => {
							const chat = artifact.session === null ? null : chatOf(artifact.session);
							return {
								title: artifact.title,
								detail: `${KIND_NAMES[artifact.kind]} · v${artifact.version}`,
								time: new Date(artifact.updatedAt).toISOString(),
								link: chat === null ? { artifact: artifact.id } : { artifact: artifact.id, chat },
							};
						}),
				}),
			},
		},
	});
}
