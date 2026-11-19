/**
 * Copying the person's own files into an app, as v1's `from_file` did: a picture or a dataset they have, put in a version of an app by path, text as text and anything else as bytes
 * (`pim-binary:`, see `@pim/v2-app/app-files`). The file is read from their paired computer when there is one, and else from the files Pim keeps for them (`/api/files`).
 */
import { posix } from "node:path";
import { binaryValue, type AppFiles, typeOfFile } from "@pim/v2-app/app-files";
import type { App } from "@pim/v2-app/app";
import { acquireRemote, type Computer, type RelayBus } from "@pim/v2-app/relay";
import { CapabilityUnavailableError } from "@pim/v2-contracts/authz";
import type { Principal } from "@pim/v2-contracts/identity";
import { filesPath } from "./computer-tools.ts";

/** What one app version holds, and so the most one file copied into it may be. */
const MAX_BYTES = 10_000_000;
const PART = 524_288;

async function fromComputer(computer: Computer, path: string): Promise<Buffer> {
	const stat = await computer.call<{ size: number; isDirectory: boolean }>("stat", { path });
	if (stat.isDirectory) throw new Error(`${path} is a folder, not a file.`);
	if (stat.size > MAX_BYTES) throw new Error(`${path} is ${stat.size} bytes, more than the ${MAX_BYTES} an app holds.`);
	const parts: Buffer[] = [];
	for (let offset = 0; offset < stat.size; ) {
		const { data } = await computer.call<{ data: string }>("read", { path, offset, length: PART });
		const bytes = Buffer.from(data, "base64");
		if (bytes.length === 0) break;
		parts.push(bytes);
		offset += bytes.length;
	}
	return Buffer.concat(parts);
}

type FilesDeps = { ownerId: string; app: App; relay: (() => Promise<RelayBus>) | undefined };

/** The person's paired computer, when they have one and it answers. */
const computerOf = async (deps: FilesDeps, purpose: string): Promise<Computer | null> =>
	deps.relay ? await acquireRemote(await deps.relay().catch(() => null), deps.ownerId, purpose).catch((error) => (error instanceof CapabilityUnavailableError ? null : Promise.reject(error))) : null;

/** One of the person's files, as its bytes: from their computer when it is paired, else from the files Pim keeps for them. */
export async function readPersonFile(deps: FilesDeps, p: Principal, source: string, limit = MAX_BYTES): Promise<Buffer> {
	const from = filesPath(source);
	if (from === null) throw new Error(`${source} is not one of the person's files. Use an absolute path under /workspace.`);
	const computer = await computerOf(deps, "from_file");
	if (computer) return fromComputer(computer, from);
	const served = await deps.app.objects.serve(p, `${deps.ownerId}/files${from}`).catch(() => null);
	if (!served) throw new Error(`No file ${from} in the person's files.`);
	if (served.body.length > limit) throw new Error(`${from} is ${served.body.length} bytes, more than the ${limit} allowed.`);
	return Buffer.from(served.body);
}

/** Every file under a folder of the person's files, by its path relative to the folder, with its size; hidden files and folders are left out. */
export async function listPersonFolder(deps: FilesDeps, p: Principal, folder: string, maxEntries = 500): Promise<{ path: string; size: number }[]> {
	const root = filesPath(folder);
	if (root === null) throw new Error(`${folder} is not one of the person's files. Use an absolute path under /workspace.`);
	const found: { path: string; size: number }[] = [];
	const carried = (path: string) => !path.split("/").some((part) => part.startsWith("."));
	const computer = await computerOf(deps, "from_file");
	if (computer) {
		let seen = 0;
		const walk = async (dir: string, prefix: string): Promise<void> => {
			const entries = await computer.call<{ name: string; size: number; isDirectory: boolean }[]>("readdir", { path: dir, limit: 1000 });
			seen += entries.length;
			if (seen > maxEntries) throw new Error(`${folder} has more than ${maxEntries} files and folders: give the skill's own folder`);
			for (const entry of entries) {
				const path = `${prefix}${entry.name}`;
				if (!carried(path)) continue;
				if (entry.isDirectory) await walk(posix.join(dir, entry.name), `${path}/`);
				else found.push({ path, size: entry.size });
			}
		};
		await walk(root, "");
		return found;
	}
	const prefix = `${deps.ownerId}/files${root}/`;
	const rows = await deps.app.db.owner(deps.ownerId, async (tx) => (await tx.query("SELECT key, size FROM pim_app.objects WHERE purpose = 'file' AND deleted_at IS NULL AND left(key, length($1)) = $1 LIMIT $2", [prefix, maxEntries + 1])).rows);
	if (rows.length > maxEntries) throw new Error(`${folder} has more than ${maxEntries} files: give the skill's own folder`);
	for (const r of rows) {
		const path = (r.key as string).slice(prefix.length);
		if (carried(path)) found.push({ path, size: Number(r.size) });
	}
	return found;
}

/** Saves bytes as one of the person's files (replacing the one there): in the files Pim keeps, and on their computer when one is paired. */
export async function savePersonFile(deps: FilesDeps, p: Principal, path: string, bytes: Uint8Array): Promise<{ path: string; size: number }> {
	const to = filesPath(path);
	if (to === null || to === "/workspace") throw new Error(`${path} is not a file under /workspace. Use an absolute path such as /workspace/scripts/convert.py.`);
	await deps.app.objects.put(p, { bytes, contentType: typeOfFile(to), purpose: "file", key: `${deps.ownerId}/files${to}` });
	const computer = await computerOf(deps, "file_write").catch(() => null);
	if (computer) {
		await deps.app.identity.authz.enforce(p, "computer:use");
		await computer.call("mkdir", { path: posix.dirname(to), recursive: true });
		await computer.call("write", { path: to, data: Buffer.from(bytes).toString("base64") });
	}
	return { path: to, size: bytes.length };
}

/** The files `list` names, by the path each is to have in the app: its text, or its bytes when it is not text. */
export async function copiedFiles(deps: FilesDeps, p: Principal, list: readonly { path: string; from_file: string }[] = []): Promise<AppFiles> {
	const files: AppFiles = {};
	for (const { path, from_file: source } of list) {
		const bytes = await readPersonFile(deps, p, source);
		try {
			files[path] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			files[path] = binaryValue(bytes);
		}
	}
	return files;
}
