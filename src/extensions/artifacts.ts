import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { ARTIFACT_KINDS, type ArtifactStore, type ArtifactVersion, applyEdits, checkKind, checkTitle } from "../artifacts";
import { HttpError } from "../http";
import { text } from "./services";

/** What the artifact tools need from the agent. */
export type ArtifactServices = {
	readonly artifacts: ArtifactStore;
	/** Throws once the agent is being erased: work still under way then writes nothing. */
	assertOpen(): void;
};

/** How much of an artifact one read returns, so a large one doesn't fill the context at once. */
const READ_CHARS = 60_000;

const HOW_IT_RUNS =
	"An HTML artifact is one self-contained document: put its CSS in <style> and its JavaScript in <script>, and any data inline. " +
	"It runs in a sandbox: fetch, forms, and external scripts, stylesheets, fonts and images are blocked, and so are cookies, localStorage and alert(). " +
	"That doesn't stop it sending data out: it can still navigate itself away, so treat what it contains, and what the user types into it, as possibly visible to others. " +
	"Don't put passwords, codes or personal details in an artifact unless the user asks. " +
	"Images must be inline (data: URLs or SVG). It shows in the chat and on a full screen, including on phones, so make it responsive. " +
	"Markdown artifacts are documents; images and raw HTML in them aren't rendered.";

/** A tool's answer about a version: a reference the app shows as the artifact, never its content. */
function reference(version: ArtifactVersion, title: string, kind: string, note: string) {
	return text(
		JSON.stringify({
			artifact: { id: version.artifact, title, kind, version: version.version, sha256: version.sha256, size: version.size },
			note,
		}),
	);
}

function failure(error: unknown) {
	if (error instanceof HttpError) return text(error.message, true);
	throw error;
}

export function artifactsExtension({ artifacts, assertOpen }: ArtifactServices) {
	const create = defineTool({
		name: "artifact_create",
		description: `Make an artifact: a document or small interactive page (an app, a chart, a game, a report) the user can open, keep, and get new versions of. Use it for anything the user will look at or use again, rather than pasting long HTML into the chat. ${HOW_IT_RUNS}`,
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 200 }),
			kind: Type.Union(ARTIFACT_KINDS.map((kind) => Type.Literal(kind))),
			content: Type.String(),
		}),
		replay: "safe",
		async execute({ title, kind, content }, api, context) {
			const id = await api.memo("artifact", crypto.randomUUID(), context);
			try {
				assertOpen();
				const name = checkTitle(title);
				const version = await artifacts.create({ id, title: name, kind: checkKind(kind), content, session: String(api.conversationId) });
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
			"Send either edits (each find text must appear exactly once; best for small changes) or the whole new content. Older versions are kept.",
		parameters: Type.Object({
			id: Type.String(),
			base_version: Type.Integer({ minimum: 1 }),
			edits: Type.Optional(Type.Array(Type.Object({ find: Type.String({ minLength: 1 }), replace: Type.String() }), { minItems: 1, maxItems: 50 })),
			content: Type.Optional(Type.String()),
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		}),
		replay: "safe",
		async execute({ id, base_version, edits, content, title }, api) {
			try {
				assertOpen();
				if ((edits === undefined) === (content === undefined)) throw new HttpError(400, "Send either edits or content, not both.");
				const latest = artifacts.version(id);
				if (!latest) throw new HttpError(404, `No artifact ${id}. List the artifacts to find it.`);
				// Edits apply to the version they were based on, which must be the latest; append checks that again.
				const base = base_version === latest.version ? latest : undefined;
				const next = content ?? (base ? applyEdits(base.content, edits!) : latest.content);
				const { version, changed } = await artifacts.append(id, {
					baseVersion: base_version,
					content: next,
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
		description: `Read an artifact's source: the latest version, or the one asked for. Long ones come in parts of ${READ_CHARS} characters: pass offset for the next.`,
		parameters: Type.Object({
			id: Type.String(),
			version: Type.Optional(Type.Integer({ minimum: 1 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		replay: "safe",
		async execute({ id, version, offset = 0 }) {
			const found = artifacts.version(id, version);
			if (!found) return text(version === undefined ? `No artifact ${id}.` : `No version ${version} of artifact ${id}.`, true);
			const summary = artifacts.get(id)!;
			const part = found.content.slice(offset, offset + READ_CHARS);
			const rest = found.content.length - offset - part.length;
			const header = `Artifact ${id} "${summary.title}" (${summary.kind}), version ${found.version} of ${summary.version}, ${found.content.length} characters${offset > 0 ? `, from ${offset}` : ""}:`;
			const more = rest > 0 ? `\n[... ${rest} more characters: read again with offset ${offset + part.length}]` : "";
			return text(`${header}\n${part}${more}`);
		},
	});

	const list = defineTool({
		name: "artifact_list",
		description: "List the user's artifacts: id, title, kind, latest version and size, most recently changed first.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			const all = artifacts.list();
			if (all.length === 0) return text("No artifacts yet.");
			return text(
				all
					.map((artifact) => `- ${artifact.title} (id ${artifact.id}, ${artifact.kind}, version ${artifact.version}, ${artifact.size} bytes)`)
					.join("\n"),
			);
		},
	});

	return defineExtension({ name: "pim.artifacts", tools: [create, update, read, list] });
}
