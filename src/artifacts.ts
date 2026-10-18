/**
 * Artifacts: documents and small interactive pages the agent makes for its
 * owner, kept in the owner's own Durable Object with every version.
 *
 * - Versions are append-only. Editing, or restoring an older version, adds
 *   a new one; nothing rewrites a version, so a version number and its
 *   `sha256` always name the same bytes.
 * - Every write names the version it was based on, and is refused (409)
 *   when that is no longer the latest: the agent and the person can't
 *   overwrite each other's change unseen.
 * - Sizes are bounded per version, per artifact (versions) and in total,
 *   counted from the stored versions themselves, before anything is written.
 *
 * An HTML artifact runs, in the browser, only in a sandbox with an opaque
 * origin (see `artifactHtmlHeaders`); this module only stores it.
 */

import { compileJsx, inlineScript } from "./artifact-jsx";
import { HttpError } from "./http";

export const ARTIFACT_KINDS = ["html", "markdown", "svg", "mermaid", "jsx"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The kinds the app shows in a sandboxed frame; Markdown it renders itself. */
export const FRAMED_KINDS: readonly ArtifactKind[] = ["html", "svg", "mermaid", "jsx"];

/** Each kind's file extension, for downloads. */
const EXTENSIONS: Record<ArtifactKind, string> = { html: "html", markdown: "md", svg: "svg", mermaid: "mmd", jsx: "jsx" };

/** Who made a version: the agent, the person editing it, or the person restoring an older one. */
export type ArtifactSource = "agent" | "person" | "restore";

export type ArtifactSummary = {
	readonly id: string;
	readonly title: string;
	readonly kind: ArtifactKind;
	/** The session it was made in. */
	readonly session: string | null;
	/** The latest version's number. */
	readonly version: number;
	readonly versions: number;
	/** The latest version's size, in UTF-8 bytes. */
	readonly size: number;
	readonly sha256: string;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type ArtifactVersionInfo = {
	readonly version: number;
	readonly sha256: string;
	readonly size: number;
	readonly source: ArtifactSource;
	/** The version a restore copied. */
	readonly restoredFrom: number | null;
	readonly createdAt: number;
};

export type ArtifactVersion = ArtifactVersionInfo & { readonly artifact: string; readonly content: string };

/** The limits artifacts count against; null is none (the hard caps still apply). */
export type ArtifactLimits = {
	readonly artifacts: number | null;
	readonly artifactVersions: number | null;
	readonly artifactBytes: number | null;
	readonly artifactStorageBytes: number | null;
};

/**
 * Caps that hold whatever the limits say. A version is one SQLite row, which
 * can't exceed 2 MB. An export holds every version in memory at once, and
 * the chats that made them hold their text again, so all of them together
 * stay far below a Worker's 128 MB.
 */
export const MAX_ARTIFACT_BYTES = 1_000_000;
export const MAX_ARTIFACT_STORAGE_BYTES = 10_000_000;
export const MAX_TITLE_LENGTH = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_artifacts (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	kind TEXT NOT NULL,
	session TEXT,
	head INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_artifact_versions (
	artifact TEXT NOT NULL,
	version INTEGER NOT NULL,
	content TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	size INTEGER NOT NULL,
	source TEXT NOT NULL,
	restored_from INTEGER,
	call_id TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (artifact, version)
);
-- Ids of deleted artifacts, and when: no title, content or hash. A replayed create of one must not bring it back.
-- Never pruned, since any id may still be replayed. One row (about 100 bytes) exists per artifact that was made and
-- then deleted, and each is made by a model request: the daily request limit caps the rate, and the rows count
-- in the database size the storage quota refuses new artifacts against. (A deletion needs no room.)
CREATE TABLE IF NOT EXISTS pim_artifact_deleted (
	id TEXT PRIMARY KEY,
	deleted_at INTEGER NOT NULL
);
`;

type Row = Record<string, SqlStorageValue>;

const encoder = new TextEncoder();
export const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function versionInfo(row: Row): ArtifactVersionInfo {
	return {
		version: Number(row.version),
		sha256: String(row.sha256),
		size: Number(row.size),
		source: String(row.source) as ArtifactSource,
		restoredFrom: row.restored_from === null ? null : Number(row.restored_from),
		createdAt: Number(row.created_at),
	};
}

export function checkTitle(title: unknown): string {
	if (typeof title !== "string" || title.trim() === "") throw new HttpError(400, "title must be a non-empty string");
	const trimmed = title.trim().replace(/\s+/g, " ");
	if (trimmed.length > MAX_TITLE_LENGTH) throw new HttpError(400, `title must be at most ${MAX_TITLE_LENGTH} characters`);
	return trimmed;
}

export function checkKind(kind: unknown): ArtifactKind {
	if (!ARTIFACT_KINDS.includes(kind as ArtifactKind)) throw new HttpError(400, `kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
	return kind as ArtifactKind;
}

/** An SVG artifact's markup: an `<svg>` element, after at most an XML declaration and comments. */
const SVG_START = /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

/** Refuses content its kind can't show, with what to fix, so a mistake reaches the one who made it. */
export function checkContent(kind: ArtifactKind, content: string): void {
	if (kind === "svg" && !SVG_START.test(content)) throw new HttpError(400, "An SVG artifact must be one <svg> element, starting with <svg.");
	if (kind === "mermaid" && content.trim() === "") throw new HttpError(400, "A Mermaid artifact needs a diagram.");
	if (kind === "jsx") compileJsx(content);
}

/** Search-and-replace edits, each matching exactly once, applied in order. */
export function applyEdits(content: string, edits: readonly { find: string; replace: string }[]): string {
	let result = content;
	edits.forEach(({ find, replace }, index) => {
		if (find === "") throw new HttpError(400, `Edit ${index + 1}: find must not be empty`);
		const first = result.indexOf(find);
		if (first === -1) throw new HttpError(400, `Edit ${index + 1}: its find text is not in the artifact. Read it again and copy the text exactly.`);
		if (result.indexOf(find, first + 1) !== -1) {
			throw new HttpError(400, `Edit ${index + 1}: its find text appears more than once. Include more of the surrounding text so it matches once.`);
		}
		result = result.slice(0, first) + replace + result.slice(first + find.length);
	});
	return result;
}

export type ArtifactWriteOptions = {
	/** Bytes the whole database may still grow by, or null for no limit. */
	readonly storageRoom: () => number | null;
};

export class ArtifactStore {
	readonly #sql: SqlStorage;
	readonly #limits: () => ArtifactLimits;
	readonly #storageRoom: () => number | null;

	constructor(sql: SqlStorage, limits: () => ArtifactLimits, options: ArtifactWriteOptions) {
		this.#sql = sql;
		this.#limits = limits;
		this.#storageRoom = options.storageRoom;
		this.#sql.exec(SCHEMA);
	}

	/** Every artifact, most recently changed first. */
	list(): ArtifactSummary[] {
		return this.#sql
			.exec(
				`SELECT a.*, v.size, v.sha256, (SELECT COUNT(*) FROM pim_artifact_versions c WHERE c.artifact = a.id) AS versions
				FROM pim_artifacts a JOIN pim_artifact_versions v ON v.artifact = a.id AND v.version = a.head
				ORDER BY a.updated_at DESC, a.rowid DESC`,
			)
			.toArray()
			.map((row) => this.#summary(row));
	}

	get(id: string): ArtifactSummary | undefined {
		const [row] = this.#sql
			.exec(
				`SELECT a.*, v.size, v.sha256, (SELECT COUNT(*) FROM pim_artifact_versions c WHERE c.artifact = a.id) AS versions
				FROM pim_artifacts a JOIN pim_artifact_versions v ON v.artifact = a.id AND v.version = a.head
				WHERE a.id = ?`,
				id,
			)
			.toArray();
		return row ? this.#summary(row) : undefined;
	}

	#summary(row: Row): ArtifactSummary {
		return {
			id: String(row.id),
			title: String(row.title),
			kind: String(row.kind) as ArtifactKind,
			session: row.session === null ? null : String(row.session),
			version: Number(row.head),
			versions: Number(row.versions),
			size: Number(row.size),
			sha256: String(row.sha256),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		};
	}

	/** Every version's details, newest first, without content. */
	versions(id: string): ArtifactVersionInfo[] {
		return this.#sql
			.exec("SELECT version, sha256, size, source, restored_from, created_at FROM pim_artifact_versions WHERE artifact = ? ORDER BY version DESC", id)
			.toArray()
			.map(versionInfo);
	}

	/** A version with its content; the latest when `version` is omitted. */
	version(id: string, version?: number): ArtifactVersion | undefined {
		const summary = this.get(id);
		if (!summary) return undefined;
		const [row] = this.#sql
			.exec("SELECT * FROM pim_artifact_versions WHERE artifact = ? AND version = ?", id, version ?? summary.version)
			.toArray();
		return row ? { ...versionInfo(row), artifact: id, content: String(row.content) } : undefined;
	}

	/** Bytes every version of every artifact takes, as stored. */
	totalBytes(): number {
		return Number(this.#sql.exec("SELECT COALESCE(SUM(size), 0) AS total FROM pim_artifact_versions").one().total);
	}

	/** Refuses a version of `size` bytes that would break a limit; `adding` is whether it's a new artifact. */
	#checkRoom(size: number, artifact: string | null): void {
		const limits = this.#limits();
		const perVersion = Math.min(MAX_ARTIFACT_BYTES, limits.artifactBytes ?? MAX_ARTIFACT_BYTES);
		if (size > perVersion) throw new HttpError(413, `An artifact can be at most ${perVersion} bytes; this one is ${size}. Make it smaller.`);
		if (artifact === null) {
			const count = Number(this.#sql.exec("SELECT COUNT(*) AS count FROM pim_artifacts").one().count);
			if (limits.artifacts !== null && count >= limits.artifacts) {
				throw new HttpError(429, `You can keep up to ${limits.artifacts} artifacts. Delete one first.`);
			}
		} else if (limits.artifactVersions !== null) {
			const count = Number(this.#sql.exec("SELECT COUNT(*) AS count FROM pim_artifact_versions WHERE artifact = ?", artifact).one().count);
			if (count >= limits.artifactVersions) {
				throw new HttpError(
					429,
					`This artifact has ${count} versions, the most one can keep. Delete it, or make a new artifact from its latest version.`,
				);
			}
		}
		const total = Math.min(MAX_ARTIFACT_STORAGE_BYTES, limits.artifactStorageBytes ?? MAX_ARTIFACT_STORAGE_BYTES);
		const used = this.totalBytes();
		if (used + size > total) {
			throw new HttpError(429, `Artifacts can take up to ${total} bytes in all; ${used} are used. Delete some first.`);
		}
		const room = this.#storageRoom();
		if (room !== null && size > room) throw new HttpError(429, `Space storage quota exceeded: there is room for ${Math.max(0, room)} more bytes.`);
	}

	/** Makes an artifact with its first version. Run again with the same id, it returns what the first run made, or is refused (410) if that was deleted since. */
	async create(input: { id: string; title: string; kind: ArtifactKind; content: string; session: string | null }): Promise<ArtifactVersion> {
		const hash = await sha256(input.content);
		// Nothing awaits from here on: the checks and the write are one step, which no other write can come between.
		const existing = this.version(input.id, 1);
		if (existing) return existing;
		if (this.#sql.exec("SELECT 1 FROM pim_artifact_deleted WHERE id = ?", input.id).toArray().length > 0) {
			throw new HttpError(410, "This artifact was deleted, so this create, run again, made nothing. Make a new artifact if the user still wants it.");
		}
		const size = utf8Bytes(input.content);
		this.#checkRoom(size, null);
		const now = Date.now();
		this.#sql.exec(
			"INSERT INTO pim_artifacts (id, title, kind, session, head, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
			input.id,
			input.title,
			input.kind,
			input.session,
			now,
			now,
		);
		this.#sql.exec(
			"INSERT INTO pim_artifact_versions (artifact, version, content, sha256, size, source, restored_from, call_id, created_at) VALUES (?, 1, ?, ?, ?, 'agent', NULL, NULL, ?)",
			input.id,
			input.content,
			hash,
			size,
			now,
		);
		return this.version(input.id, 1)!;
	}

	/**
	 * Adds a version to `id`, based on `baseVersion`, which must still be the
	 * latest. `callId` makes a replayed tool call return the version it made
	 * instead of adding another. Content equal to the latest adds nothing.
	 */
	async append(
		id: string,
		input: { baseVersion: number; content: string; source: ArtifactSource; restoredFrom?: number; callId?: string; title?: string },
	): Promise<{ version: ArtifactVersion; changed: boolean }> {
		const hash = await sha256(input.content);
		// Nothing awaits from here on: the checks and the write are one step, which no other write can come between.
		const summary = this.get(id);
		if (!summary) throw new HttpError(404, `No artifact ${id}`);
		if (input.callId !== undefined) {
			const [made] = this.#sql.exec("SELECT version FROM pim_artifact_versions WHERE artifact = ? AND call_id = ?", id, input.callId).toArray();
			if (made) return { version: this.version(id, Number(made.version))!, changed: true };
		}
		if (input.baseVersion !== summary.version) {
			throw new HttpError(409, `Version ${input.baseVersion} is not the latest: version ${summary.version} is. Read it, then edit that.`);
		}
		const latest = this.version(id)!;
		const now = Date.now();
		const title = input.title ?? summary.title;
		if (input.content === latest.content && input.source !== "restore") {
			if (title !== summary.title) this.#sql.exec("UPDATE pim_artifacts SET title = ?, updated_at = ? WHERE id = ?", title, now, id);
			return { version: latest, changed: false };
		}
		// A version that is refused renames nothing.
		const size = utf8Bytes(input.content);
		this.#checkRoom(size, id);
		const next = summary.version + 1;
		this.#sql.exec(
			"INSERT INTO pim_artifact_versions (artifact, version, content, sha256, size, source, restored_from, call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id,
			next,
			input.content,
			hash,
			size,
			input.source,
			input.restoredFrom ?? null,
			input.callId ?? null,
			now,
		);
		this.#sql.exec("UPDATE pim_artifacts SET head = ?, title = ?, updated_at = ? WHERE id = ?", next, title, now, id);
		return { version: this.version(id, next)!, changed: true };
	}

	/** Restores `version` as a new latest version, if `baseVersion` is still the latest. */
	async restore(id: string, version: number, baseVersion: number): Promise<ArtifactVersion> {
		const old = this.version(id, version);
		if (!old) throw new HttpError(404, `No version ${version} of artifact ${id}`);
		return (await this.append(id, { baseVersion, content: old.content, source: "restore", restoredFrom: version })).version;
	}

	/** Deletes an artifact and every version of it. */
	delete(id: string): boolean {
		if (!this.get(id)) return false;
		// The fence first, then the deletion, with nothing awaited between: if the fence can't be written, nothing is deleted.
		this.#sql.exec("INSERT OR IGNORE INTO pim_artifact_deleted (id, deleted_at) VALUES (?, ?)", id, Date.now());
		this.#sql.exec("DELETE FROM pim_artifact_versions WHERE artifact = ?", id);
		this.#sql.exec("DELETE FROM pim_artifacts WHERE id = ?", id);
		return true;
	}

	/** Every artifact with every version, for the owner's export. */
	export() {
		return this.list().map((artifact) => ({
			...artifact,
			versions: this.#sql
				.exec("SELECT * FROM pim_artifact_versions WHERE artifact = ? ORDER BY version", artifact.id)
				.toArray()
				.map((row) => ({ ...versionInfo(row), content: String(row.content) })),
		}));
	}
}

/**
 * Headers for any response that carries an artifact's bytes. HTML in it can
 * only ever run sandboxed, in an opaque origin: even opened directly in a tab,
 * it can't read this origin's cookies or storage, or call its API. The CSP
 * also keeps it from loading anything or connecting anywhere, except, with
 * `runtime`, Pim's own scripts under `RUNTIME_PATH`. That is not a
 * promise it can't send data out: it can still navigate itself away, with
 * what it shows or what someone typed in the address.
 */
export function artifactHeaders(origin: string, contentType: string, options: { runtime?: boolean } = {}): Headers {
	return new Headers({
		"content-type": contentType,
		"content-security-policy": [
			"sandbox allow-scripts",
			"default-src 'none'",
			// A diagram or a JSX artifact also loads the scripts it runs on, Pim's own (see `RUNTIME_PATH`).
			options.runtime ? `script-src 'unsafe-inline' ${origin}${RUNTIME_PATH}` : "script-src 'unsafe-inline'",
			"style-src 'unsafe-inline'",
			"img-src data: blob:",
			"font-src data:",
			"media-src data: blob:",
			"connect-src 'none'",
			"form-action 'none'",
			"base-uri 'none'",
			`frame-ancestors ${origin}`,
		].join("; "),
		"cache-control": "no-store, private",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"cross-origin-resource-policy": "same-origin",
		"permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=(), publickey-credentials-get=(), publickey-credentials-create=()",
	});
}

/**
 * Reports the page's height to the app that shows it, the one message an
 * artifact sends. Added after the artifact's own markup, so it can't change
 * how the document is parsed.
 */
export const RESIZE_SCRIPT = `<script>(()=>{let last=-1;const post=()=>{const h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;parent.postMessage({type:"pim:artifact-height",height:h},"*")}};addEventListener("load",post);new ResizeObserver(post).observe(document.documentElement);post()})()</script>`;

/**
 * Where the scripts that diagrams and JSX artifacts run on are served from:
 * static files the web app's build makes (`web/scripts/build-artifact-runtimes.mjs`),
 * the same for everyone, which load nothing else.
 */
export const RUNTIME_PATH = "/artifact-runtime/";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PAGE_HEAD =
	'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
	"<style>html,body{margin:0;background:#fff}body{font:14px/1.5 system-ui,sans-serif}</style>";

/**
 * The page a framed version is shown as: an HTML artifact as it is; an SVG
 * one in a page that fits it to the frame; a Mermaid one as its source, in
 * text, which the Mermaid runtime draws; a JSX one compiled, after the React
 * runtime and the modules it imports. Each ends with the height script.
 */
export function framePage(kind: ArtifactKind, content: string, origin: string): Response {
	const html = (body: string, runtime = false) =>
		new Response(body + RESIZE_SCRIPT, { headers: artifactHeaders(origin, "text/html; charset=utf-8", { runtime }) });
	switch (kind) {
		case "html":
			return html(content);
		case "svg":
			return html(`${PAGE_HEAD}<style>svg{display:block;max-width:100%;height:auto;margin:0 auto}</style></head><body>${content}</body></html>`);
		case "mermaid":
			return html(
				`${PAGE_HEAD}<style>body{padding:16px}pre.mermaid{margin:0;display:flex;justify-content:center}pre.error{white-space:pre-wrap;color:#991b1b}</style></head>` +
					`<body><pre class="mermaid">${escapeHtml(content)}</pre><script src="${origin}${RUNTIME_PATH}mermaid.js"></script></body></html>`,
				true,
			);
		case "jsx": {
			const { code, runtimes } = compileJsx(content);
			const scripts = [...runtimes, "tailwind"].map((name) => `<script src="${origin}${RUNTIME_PATH}${name}.js"></script>`).join("");
			return html(
				`${PAGE_HEAD}</head><body><div id="root"></div>${scripts}<script>__pimMount(function (require, module, exports) {\n${inlineScript(code)}\n})</script></body></html>`,
				true,
			);
		}
		default:
			throw new HttpError(404, "This kind of artifact isn't shown in a frame");
	}
}

/** A download's name: the title, made safe for a header and a file system, and the version. */
export function downloadName(title: string, version: number, kind: ArtifactKind): { ascii: string; utf8: string } {
	const extension = EXTENSIONS[kind];
	const cleaned = title
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80) || "artifact";
	const utf8 = `${cleaned}-v${version}.${extension}`;
	const ascii = `${cleaned.replace(/[^\x20-\x7e]+/g, "_").replace(/[;%]+/g, "_") || "artifact"}-v${version}.${extension}`;
	return { ascii, utf8 };
}
