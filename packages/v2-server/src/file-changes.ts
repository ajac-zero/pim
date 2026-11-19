/**
 * What an agent is told of the files it has seen that changed since: the person edits them in the app's code editor, or something else on the computer does. A chat remembers each
 * file its agent read or wrote as a hash, and as its text while that is small (`pim_app.file_seen`); the next message the person sends carries a short block with what differs,
 * put before it as a part of their own message, so the prompt a model caches is not touched. The app hides the block from the person's own message (`@pim/shared/transcript`).
 * What the agent did itself to a file is not a change: it saw the file as it left it.
 */
import { createHash } from "node:crypto";
import { FILE_CHANGES } from "@pim/shared/transcript";
import type { App } from "@pim/v2-app/app";
import { ComputerError } from "@pim/v2-app/relay";

/** How many files a chat remembers, the most recently seen first. */
export const MAX_SEEN_FILES = 20;
/** The largest file whose text is kept for a diff; a bigger one is only reported as changed. */
export const MAX_SEEN_BYTES = 64 * 1024;
/** How many files one block names, how many lines of changes each shows, and how long the whole block may be. */
const MAX_BLOCK_FILES = 8;
const MAX_DIFF_LINES = 24;
const MAX_LINE_CHARS = 160;
const MAX_BLOCK_CHARS = 4_000;

/** The text of bytes the diff can show: none when they hold a NUL early on or aren't UTF-8. */
export function textOf(bytes: Uint8Array): string | null {
	if (bytes.subarray(0, 8192).includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

const clip = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line);

/** The changed stretches of two lists of lines: where each starts in the first, what it had there, and what it has now. */
function hunks(before: string[], after: string[]): { at: number; removed: string[]; added: string[] }[] {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let endBefore = before.length;
	let endAfter = after.length;
	while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
		endBefore--;
		endAfter--;
	}
	const a = before.slice(start, endBefore);
	const b = after.slice(start, endAfter);
	// A longest common subsequence of the lines in between: what is not in it was removed or added.
	const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
	const found: { at: number; removed: string[]; added: string[] }[] = [];
	let i = 0;
	let j = 0;
	let open: { at: number; removed: string[]; added: string[] } | null = null;
	const close = () => {
		if (open) found.push(open);
		open = null;
	};
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			close();
			i++;
			j++;
			continue;
		}
		open ??= { at: start + i, removed: [], added: [] };
		if (j >= b.length || (i < a.length && lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) open.removed.push(a[i++]!);
		else open.added.push(b[j++]!);
	}
	close();
	return found;
}

/** The lines that differ between two texts, as `-` and `+` lines under `@@` headings, and none past a few. */
export function smallDiff(before: string, after: string): string {
	const out: string[] = [];
	let shown = 0;
	let hidden = 0;
	for (const hunk of hunks(before.split("\n"), after.split("\n"))) {
		const lines = [...hunk.removed.map((line) => `-${clip(line)}`), ...hunk.added.map((line) => `+${clip(line)}`)];
		if (shown >= MAX_DIFF_LINES) {
			hidden += lines.length;
			continue;
		}
		out.push(`@@ line ${hunk.at + 1} @@`);
		for (const line of lines) {
			if (shown < MAX_DIFF_LINES) {
				out.push(line);
				shown++;
			} else hidden++;
		}
	}
	if (hidden > 0) out.push(`... ${hidden} more changed lines`);
	return out.join("\n");
}

/** One seen file as it is now: gone, or its hash and size, with its text when it is small text. */
export type FileNow = { readonly exists: false } | { readonly exists: true; readonly sha256: string; readonly size: number; readonly text: string | null };

/** What changed in a file since it was seen, as the lines that tell it, or null when nothing did. */
export function changeOf(path: string, seen: { sha256: string; text: string | null }, now: FileNow): string | null {
	if (!now.exists) return `${path} (deleted)`;
	if (now.sha256 === seen.sha256) return null;
	if (seen.text === null || now.text === null) return `${path} (changed, ${now.size} bytes; no diff shown)`;
	const diff = smallDiff(seen.text, now.text);
	return `${path} (changed)${diff === "" ? "" : `\n${diff}`}`;
}

/** The block that goes before the person's message, or null when no file changed. */
export function changesBlock(changes: readonly string[]): string | null {
	if (changes.length === 0) return null;
	const parts: string[] = [];
	let used = FILE_CHANGES.length;
	for (const change of changes.slice(0, MAX_BLOCK_FILES)) {
		const room = Math.max(0, MAX_BLOCK_CHARS - used);
		parts.push(change.length > room ? `${change.slice(0, room)}\n... (cut)` : change);
		used += change.length;
		if (used >= MAX_BLOCK_CHARS) break;
	}
	const left = changes.length - parts.length;
	if (left > 0) parts.push(`... and ${left} more files changed`);
	return `${FILE_CHANGES}\n${parts.join("\n")}\n\n`;
}

/** The part of a computer the changes are read through. */
export type SeenComputer = { call<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T> };

/** A file on the computer as it is: gone, or its hash and size, and its text when it is small text. Null when the computer cannot say (it is not reachable): that is no change. */
export async function fileNow(computer: SeenComputer, path: string): Promise<FileNow | null> {
	let stat: { isFile: boolean; size: number; mtime: number; sha256: string | null };
	try {
		stat = await computer.call("stat", { path });
	} catch (error) {
		return error instanceof ComputerError && error.remote?.code === "ENOENT" ? { exists: false } : null;
	}
	if (!stat.isFile) return { exists: false };
	// A file too big to hash stands for itself by its size and time.
	if (stat.size > MAX_SEEN_BYTES) return { exists: true, sha256: stat.sha256 ?? `${stat.size}:${stat.mtime}`, size: stat.size, text: null };
	try {
		const read = await computer.call<{ data: string }>("read", { path, offset: 0, length: MAX_SEEN_BYTES });
		const bytes = Buffer.from(read.data, "base64");
		return { exists: true, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength, text: textOf(bytes) };
	} catch {
		return null;
	}
}

/**
 * Remembers that the agent of `chat` saw `path` as it is on the computer now (or as `sha256`, when it read it): its hash, and its text while it is small, to show later what the
 * person changed. A file that is gone is forgotten. Best effort: remembering never fails the call it follows.
 */
export async function sawFile(app: App, ownerId: string, chat: string, computer: SeenComputer, path: string, sha256?: string): Promise<void> {
	try {
		const now = await fileNow(computer, path);
		if (now === null) return;
		if (!now.exists) return void (await app.db.owner(ownerId, (tx) => tx.query("DELETE FROM pim_app.file_seen WHERE chat_id = $1 AND path = $2", [chat, path])));
		const same = sha256 === undefined || sha256 === now.sha256;
		await keep(app, ownerId, chat, path, same ? now.sha256 : sha256!, same ? now.text : null);
	} catch {
		// What was seen is only for telling the agent later what changed.
	}
}

const keep = (app: App, ownerId: string, chat: string, path: string, sha256: string, text: string | null) =>
	app.db.owner(ownerId, async (tx) => {
		await tx.query("INSERT INTO pim_app.file_seen (owner_id, chat_id, path, sha256, text, seen_at) VALUES ($1,$2,$3,$4,$5, clock_timestamp()) ON CONFLICT (owner_id, chat_id, path) DO UPDATE SET sha256 = excluded.sha256, text = excluded.text, seen_at = excluded.seen_at", [ownerId, chat, path, sha256, text]);
		await tx.query("DELETE FROM pim_app.file_seen WHERE chat_id = $1 AND path NOT IN (SELECT path FROM pim_app.file_seen WHERE chat_id = $1 ORDER BY seen_at DESC LIMIT $2)", [chat, MAX_SEEN_FILES]);
	});

/**
 * The block telling the agent of `chat` which of the files it saw have changed since, and what changed: by the person in the editor, or by any program on the computer other than
 * the agent's own file tools. `taken` takes the files as they are now for what the agent is about to read, so each change is told once. Undefined with nothing changed, or no computer.
 */
export async function fileChangesBlock(app: App, ownerId: string, chat: string, acquire: () => Promise<SeenComputer>): Promise<{ block: string; taken: () => Promise<void> } | undefined> {
	const known = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT path, sha256, text FROM pim_app.file_seen WHERE chat_id = $1 ORDER BY seen_at DESC, path", [chat])).rows)) as { path: string; sha256: string; text: string | null }[];
	if (known.length === 0) return undefined;
	let computer: SeenComputer;
	try {
		computer = await acquire();
	} catch {
		return undefined;
	}
	const now = await Promise.all(known.map((file) => fileNow(computer, file.path)));
	const changes: string[] = [];
	const after: { path: string; now: FileNow }[] = [];
	known.forEach((file, index) => {
		const here = now[index];
		if (!here) return;
		const change = changeOf(file.path, file, here);
		if (change === null) return;
		changes.push(change);
		after.push({ path: file.path, now: here });
	});
	const block = changesBlock(changes);
	if (block === null) return undefined;
	return {
		block,
		taken: async () => {
			for (const { path, now: here } of after) {
				if (here.exists) await keep(app, ownerId, chat, path, here.sha256, here.text);
				else await app.db.owner(ownerId, (tx) => tx.query("DELETE FROM pim_app.file_seen WHERE chat_id = $1 AND path = $2", [chat, path]));
			}
		},
	};
}
