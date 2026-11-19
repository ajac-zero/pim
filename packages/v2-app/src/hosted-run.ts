import { type AppFiles, bytesOf } from "./app-files.ts";
import type { Computer } from "./relay.ts";

/** Where the computer keeps an app's releases and data, under the person's files (the same as v1's). */
export const APPS_ROOT = "/workspace/.pim/apps";
/** The ports Pim gives backends on a computer, one each. */
export const PORT_FROM = 18_000;
export const PORT_TO = 18_999;
/** What starting may take: its install step may be five minutes, and it then waits for the backend to listen. */
const START_CALL_MS = 6 * 60_000 + 40_000;
const PART_BYTES = 512 * 1024;

/** The id a computer knows an app by: Pim's own without its `ar_` prefix, which is what `pim-computer`'s ids (hex and dashes, as v1's were) allow. */
export const computerAppId = (id: string) => id.replace(/^ar_/, "");

export const releasePath = (id: string, version: number) => `${APPS_ROOT}/${id}/v${version}`;

/** Copies a version's files to a release folder of its own on the computer, unless it is there already. A release is whole or not there, and never changes. */
async function release(computer: Computer, id: string, version: number, files: AppFiles): Promise<string> {
	const dir = releasePath(computerAppId(id), version);
	const there = await computer.call<{ isDirectory: boolean }>("stat", { path: dir }).then((s) => s.isDirectory, () => false);
	if (there) return dir;
	const draft = `${dir}.${Math.random().toString(36).slice(2, 10)}`;
	try {
		await computer.call("mkdir", { path: draft, recursive: true });
		for (const [path, value] of Object.entries(files)) {
			const slash = path.lastIndexOf("/");
			if (slash > 0) await computer.call("mkdir", { path: `${draft}/${path.slice(0, slash)}`, recursive: true });
			const bytes = bytesOf(value);
			if (bytes.length <= PART_BYTES) await computer.call("write", { path: `${draft}/${path}`, data: bytes.toString("base64") });
			else for (let at = 0; at < bytes.length; at += PART_BYTES) await computer.call("write", { path: `${draft}/${path}`, data: bytes.subarray(at, at + PART_BYTES).toString("base64"), append: at > 0 });
		}
		await computer.call("rename", { from: draft, to: dir });
	} catch (error) {
		await computer.call("rm", { path: draft, recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return dir;
}

/**
 * Runs a version of an app with a backend: its release is put on the computer and `pim-computer` starts the backend there from it, in place of any running
 * one. The backend keeps what it needs in a folder beside the releases that no release replaces. Fails with what the backend said when it does not come up.
 */
export async function runBackend(computer: Computer, app: { id: string; version: number; files: AppFiles; backend: { command: string; install?: string }; port: number; secret: string }): Promise<unknown> {
	const dir = await release(computer, app.id, app.version, app.files);
	return computer.call("app_start", { id: computerAppId(app.id), dir, command: app.backend.command, ...(app.backend.install ? { install: app.backend.install } : {}), port: app.port, data: `${APPS_ROOT}/${computerAppId(app.id)}/data`, env: { PIM_APP_ID: app.id, PIM_APP_SECRET: app.secret } }, START_CALL_MS);
}
