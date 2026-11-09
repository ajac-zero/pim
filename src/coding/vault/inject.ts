import { WORKSPACE_ROOT, type Workspace, WorkspaceFileError, type WorkspaceRef } from "../workspace/types";
import { ArchiveError, type ArchiveFile, MAX_ARCHIVE_BYTES, packArchive } from "./archive";
import { HARNESS_FILES, type Harness } from "./harnesses";
import type { CodingVault, Ownership } from "./vault";

/**
 * Puts a person's harness login (./vault.ts) into one of their workspaces
 * before the harness runs, and keeps what the CLI changed, such as refreshed
 * tokens, afterwards. Both refuse a workspace whose session isn't one of the
 * person's own coding threads, so one person's login never reaches another
 * person's workspace.
 *
 * The files go in the CLI's config directory under the workspace's home,
 * which is the workspace root, outside the repository's checkout; a harness
 * run points the CLI at it with `harnessEnv`. After the run they are
 * removed again, so they don't sit in the workspace, or its snapshots,
 * between runs.
 */

/** The home the harnesses' config directories are in. */
export const HARNESS_HOME = WORKSPACE_ROOT;

/** Where a harness's config directory is in a workspace. */
export function harnessConfigDir(harness: Harness): string {
	return `${HARNESS_HOME}/${HARNESS_FILES[harness].dir}`;
}

/** The environment a harness run sets, so the CLI finds its config directory. */
export function harnessEnv(harness: Harness): Record<string, string> {
	return { [HARNESS_FILES[harness].env]: harnessConfigDir(harness) };
}

/** A workspace, and the person it is being used for. */
export type HarnessTarget = { readonly userId: string; readonly ref: WorkspaceRef; readonly workspace: Workspace };

/** The workspace isn't one of the person's coding threads. */
export class VaultOwnershipError extends Error {
	constructor() {
		super("This workspace isn't one of this person's coding threads, so their harness logins can't go in it");
		this.name = "VaultOwnershipError";
	}
}

/** What `restoreHarnessCredentials` put in a workspace, to hand to `writeBackHarnessCredentials` after the run. */
export type Restored = {
	readonly userId: string;
	readonly sessionId: string;
	readonly harness: Harness;
	/** The entry's version when read: the write-back is refused if it has moved on. */
	readonly version: number;
	/** Whether a login was put in. */
	readonly connected: boolean;
	/** The SHA-256 of the archive as written, or null when none was, to tell whether the CLI changed anything. */
	readonly fingerprint: string | null;
};

/** What a write-back did: kept a changed login, found nothing changed or nothing there, was refused for an unsafe file, or lost to a newer write. */
export type WriteBack = { readonly outcome: "saved" | "unchanged" | "absent" | "refused" | "conflict"; readonly version: number };

async function assertOwned(owns: Ownership, target: HarnessTarget): Promise<void> {
	if (typeof target.userId !== "string" || target.userId === "" || !(await owns(target.userId, target.ref.sessionId))) throw new VaultOwnershipError();
}

/** Files are written for their owner alone. */
const ownerOnly = (mode: number) => mode & 0o700 || 0o600;

async function fingerprint(archive: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", archive as BufferSource));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Removes a harness's allowlisted files; a symlink is removed itself, never what it points to. */
async function clear(workspace: Workspace, harness: Harness): Promise<void> {
	const home = await workspace.list(HARNESS_HOME);
	const dir = home.find((entry) => entry.name === HARNESS_FILES[harness].dir);
	if (!dir) return;
	if (dir.type !== "dir") {
		await workspace.remove(harnessConfigDir(harness));
		return;
	}
	for (const path of HARNESS_FILES[harness].files) {
		try {
			await workspace.remove(`${harnessConfigDir(harness)}/${path}`);
		} catch (error) {
			if (!(error instanceof WorkspaceFileError)) throw error;
		}
	}
}

/**
 * Puts the person's login for `harness` into their workspace, replacing
 * whatever of its allowlisted files was there; with no login, it only
 * clears them. Throws `VaultOwnershipError` for someone else's workspace.
 */
export async function restoreHarnessCredentials(vault: CodingVault, owns: Ownership, target: HarnessTarget, harness: Harness): Promise<Restored> {
	await assertOwned(owns, target);
	const entry = await vault.load(target.userId, harness);
	await clear(target.workspace, harness);
	const restored = { userId: target.userId, sessionId: target.ref.sessionId, harness, version: entry.version };
	if (!entry.files) return { ...restored, connected: false, fingerprint: null };
	const files = entry.files.map((file) => ({ ...file, mode: ownerOnly(file.mode) }));
	for (const file of files) await target.workspace.writeFile(`${harnessConfigDir(harness)}/${file.path}`, file.data, file.mode);
	console.info(JSON.stringify({ event: "pim.coding.vault_restored", user: target.userId, session: target.ref.sessionId, harness, version: entry.version }));
	return { ...restored, connected: true, fingerprint: await fingerprint(packArchive(files, HARNESS_FILES[harness].files)) };
}

/** The allowlisted files as the CLI left them, or a reason they can't be kept. */
async function readBack(workspace: Workspace, harness: Harness): Promise<ArchiveFile[] | { refused: string }> {
	const dir = harnessConfigDir(harness);
	const home = await workspace.list(HARNESS_HOME);
	const entry = home.find((item) => item.name === HARNESS_FILES[harness].dir);
	if (!entry) return [];
	if (entry.type !== "dir") return { refused: "config directory isn't a directory" };
	const listed = await workspace.list(dir);
	const files: ArchiveFile[] = [];
	for (const path of HARNESS_FILES[harness].files) {
		const slash = path.lastIndexOf("/");
		const parent = slash < 0 ? listed : await workspace.list(`${dir}/${path.slice(0, slash)}`).catch(() => []);
		const stat = parent.find((item) => item.name === path.slice(slash + 1));
		if (!stat) continue;
		if (stat.type !== "file") return { refused: `${path} isn't a regular file` };
		if (stat.size > MAX_ARCHIVE_BYTES) return { refused: `${path} is too big` };
		files.push({ path, mode: ownerOnly(stat.mode), data: await workspace.readFile(`${dir}/${path}`) });
	}
	return files;
}

/**
 * After a harness run, keeps what the CLI changed of its allowlisted files,
 * if the person's entry is still the version that was restored: a newer
 * login, another workspace's newer write, or a disconnect wins, and this
 * one is dropped. Then the files are removed from the workspace, unless
 * `scrub` is false. Throws `VaultOwnershipError` when the workspace isn't
 * the one the login was restored into or isn't the person's.
 */
export async function writeBackHarnessCredentials(
	vault: CodingVault,
	owns: Ownership,
	restored: Restored,
	target: HarnessTarget,
	options: { scrub?: boolean } = {},
): Promise<WriteBack> {
	if (target.userId !== restored.userId || target.ref.sessionId !== restored.sessionId) throw new VaultOwnershipError();
	await assertOwned(owns, target);
	const { harness } = restored;
	const log = (outcome: WriteBack["outcome"], version: number, reason?: string): WriteBack => {
		console.info(JSON.stringify({ event: "pim.coding.vault_write_back", user: restored.userId, session: restored.sessionId, harness, outcome, version, ...(reason ? { reason } : {}) }));
		return { outcome, version };
	};
	try {
		const files = await readBack(target.workspace, harness);
		if (!Array.isArray(files)) return log("refused", restored.version, files.refused);
		if (files.length === 0) return log("absent", restored.version);
		let archive: Uint8Array;
		try {
			archive = packArchive(files, HARNESS_FILES[harness].files);
		} catch (error) {
			if (error instanceof ArchiveError) return log("refused", restored.version, error.message);
			throw error;
		}
		if ((await fingerprint(archive)) === restored.fingerprint) return log("unchanged", restored.version);
		const written = await vault.save(restored.userId, harness, files, restored.version);
		return log(written.ok ? "saved" : "conflict", written.version);
	} finally {
		if (options.scrub !== false) await clear(target.workspace, harness);
	}
}
