/**
 * Copying the person's own files into an app, as v1's `from_file` did: a picture or a dataset they have, put in a version of an app by path, text as text and anything else as bytes
 * (`pim-binary:`, see `@pim/v2-app/app-files`). The file is read from their paired computer when there is one, and else from the files Pim keeps for them (`/api/files`).
 */
import { binaryValue, type AppFiles } from "@pim/v2-app/app-files";
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

/** The files `list` names, by the path each is to have in the app: its text, or its bytes when it is not text. */
export async function copiedFiles(deps: { ownerId: string; app: App; relay: (() => Promise<RelayBus>) | undefined }, p: Principal, list: readonly { path: string; from_file: string }[] = []): Promise<AppFiles> {
	const files: AppFiles = {};
	for (const { path, from_file: source } of list) {
		const from = filesPath(source);
		if (from === null) throw new Error(`${source} is not one of the person's files. Use an absolute path under /workspace.`);
		let bytes: Buffer;
		const computer = deps.relay ? await acquireRemote(await deps.relay().catch(() => null), deps.ownerId, "from_file").catch((error) => (error instanceof CapabilityUnavailableError ? null : Promise.reject(error))) : null;
		if (computer) bytes = await fromComputer(computer, from);
		else {
			const served = await deps.app.objects.serve(p, `${deps.ownerId}/files${from}`).catch(() => null);
			if (!served) throw new Error(`No file ${from} in the person's files.`);
			if (served.body.length > MAX_BYTES) throw new Error(`${from} is ${served.body.length} bytes, more than the ${MAX_BYTES} an app holds.`);
			bytes = Buffer.from(served.body);
		}
		try {
			files[path] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			files[path] = binaryValue(bytes);
		}
	}
	return files;
}
