/**
 * Apps with a backend as the agent's tools, ported from v1 (`src/extensions/hosted.ts`). `app_deploy` is a gated action: it saves a folder of the person's files as a version of an app
 * and runs its backend on their computer, where it can do what any program there can, so they approve each deploy. Looking at an app's backend and stopping it need no approval.
 * The tools are made inside `computerTools`, which gives them its approval and once-only-effect machinery and its way to the computer.
 */
import { Type } from "typebox";
import type { App } from "@pim/v2-app/app";
import { type AppFiles, binaryValue } from "@pim/v2-app/app-files";
import { ACCESS_LEVELS, MANIFEST_FILE, parseManifest } from "@pim/v2-app/apps";
import { computerAppId, runBackend } from "@pim/v2-app/hosted-run";
import type { Computer } from "@pim/v2-app/relay";
import type { Principal } from "@pim/v2-contracts/identity";

type Result = { output: { type: string; [key: string]: unknown }[]; isError?: boolean };
type Prepared = { result: Result } | { summary: string };

/** What the tools take of `computerTools`. */
export type HostedKit = {
	root: string;
	tool(name: string, description: string, parameters: any, execute: (args: any, api: any, context: any) => Promise<Result>, replay?: "safe" | "unsafe"): unknown;
	/** The caller's application, chat and principal, and the owner's computer, checked usable. */
	use(api: any, capability: string): Promise<{ computer: Computer }>;
	gated(api: any, g: { action: string; tool: string; resource?: Record<string, string>; args: Record<string, unknown>; prepare?: () => Promise<Prepared>; run: (computer: Computer) => Promise<{ text: string; isError?: boolean }> }): Promise<Result>;
	caller(api: any): Promise<{ app: App; p: Principal }>;
	confined(...paths: unknown[]): Result | null;
};

const MAX_FILES = 100;
const PART = 524_288;
const EXCLUDED = ["**/node_modules", "**/.git"];
const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

const HOW = (root: string) =>
	`An app with a backend is a folder in the person's files (${root}/…) with a ${MANIFEST_FILE} at its root: {"backend": {"command": "node server.js", "install": "npm ci"}}. command starts the backend, from a copy of the folder, and it must listen on 127.0.0.1 at the port in $PORT; install runs first, in the same copy (a copy has no node_modules or .git, so install what it needs there). The app is its frontend and its backend in one folder: whatever the backend answers at / is the app's page, shown beside the chat. Use relative addresses in the page (fetch("api/items"), not fetch("/api/items")), because it isn't served from the root of an address. The page runs in a sandbox and can reach only its own backend. The backend keeps what it needs in $PIM_APP_DATA, a folder that stays across versions. The folder may hold up to ${MAX_FILES} files. Who may open it is the manifest's "access": "owner" (the default; only the person), "circles" (the people in the circles the person shares it with, who sign in to Pim) or "public" (anyone with the address, signed in or not); the last two work only where this Pim has an address for apps of their own, and the person is told what you give as access when they approve.`;

/** A file of the computer as a version holds it: its text, or `pim-binary:` and its bytes when it is not text. */
async function readOne(computer: Computer, path: string): Promise<string> {
	const parts: Buffer[] = [];
	for (let offset = 0; ; ) {
		const { data, size } = await computer.call<{ data: string; size: number }>("read", { path, offset, length: PART });
		const bytes = Buffer.from(data, "base64");
		if (bytes.length === 0) break;
		parts.push(bytes);
		offset += bytes.length;
		if (offset >= size) break;
	}
	const whole = Buffer.concat(parts);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(whole);
	} catch {
		return binaryValue(whole);
	}
}

/** The files of a folder on the computer, by path relative to it, without what a release installs or a repository keeps. Refused past `MAX_FILES + 1` files, with what to do. */
async function readFolder(computer: Computer, folder: string): Promise<AppFiles> {
	const found = await computer.call<{ path: string; type: string }[]>("find", { pattern: "**", path: folder, limit: MAX_FILES + 2, exclude: EXCLUDED });
	const paths = found.filter((f) => f.type === "file").map((f) => f.path);
	if (paths.length > MAX_FILES + 1) throw new Error(`${folder} has more than ${MAX_FILES} files, the most an app holds. Leave out what's built or installed there: a release installs its own, with "backend".install.`);
	const files: AppFiles = {};
	for (const path of paths) if (path.startsWith(`${folder}/`)) files[path.slice(folder.length + 1)] = await readOne(computer, path);
	return files;
}

export function hostedTools(kit: HostedKit): unknown[] {
	const { root, tool, use, gated, caller, confined } = kit;
	const deploy = tool(
		"app_deploy",
		`Deploy an app with a backend: save a folder of the person's files as a new version of an app and run its backend on their computer. ${HOW(root)} Give id to deploy a new version of an app you deployed before; without it a new app is made, with title as its name. Returns the version and what the backend printed if it didn't start. Show it in the chat with app_show.`,
		Type.Object({
			path: Type.String({ minLength: 1, description: `The folder, under ${root}.` }),
			id: Type.Optional(Type.String({ description: "The app to deploy a new version of, from app_list." })),
			title: Type.Optional(Type.String({ maxLength: 200, description: "A new app's name; the folder's name if left out." })),
			access: Type.Optional(Type.Union(ACCESS_LEVELS.map((level) => Type.Literal(level)), { description: `Who may open the app, the same as the manifest's "access", which must agree: the person reads it when they approve. "owner" if left out.` })),
		}),
		async ({ path, id, title, access }, api) => {
			const bad = confined(path);
			if (bad) return bad;
			const folder = String(path).replace(/\/+$/, "");
			const { app, p } = await caller(api);
			return gated(api, {
				action: "app:deploy",
				tool: "app_deploy",
				resource: { app: id ?? "", access: access ?? "owner" },
				args: { path: folder, ...(id ? { id } : {}), ...(title ? { title } : {}), access: access ?? "owner" },
				prepare: async () => {
					const { computer } = await use(api, "app_deploy");
					const manifest = await readOne(computer, `${folder}/${MANIFEST_FILE}`).catch(() => null);
					if (manifest === null) return { result: text(`${folder} has no ${MANIFEST_FILE}. ${HOW(root)}`, true) };
					const wanted = parseManifest(manifest).access;
					if (wanted !== (access ?? "owner")) return { result: text(`${MANIFEST_FILE} says access is "${wanted}", but this deploy asked for "${access ?? "owner"}". Give access: "${wanted}", so the person is told who will be able to open the app.`, true) };
					const known = id === undefined ? undefined : await app.apps.read(p, id).catch(() => undefined);
					const who = access === "public" ? ". Anyone with its address will be able to open it" : access === "circles" ? ". The people in the circles you share it with will be able to open it" : "";
					return { summary: `${known ? `Deploy ${folder} as a new version of ${known.title}` : `Deploy ${folder} as ${title ? `the app ${title}` : "an app"}`}, and run its backend on your computer${who}` };
				},
				run: async (computer) => {
					const files = await readFolder(computer, folder);
					if (!(MANIFEST_FILE in files)) throw new Error(`${folder} has no ${MANIFEST_FILE}. ${HOW(root)}`);
					let made: { id: string };
					if (id !== undefined) {
						const current = await app.apps.read(p, id);
						if (current.kind !== "backend") throw new Error(`${id} is not an app with a backend. Leave id out to make a new one.`);
						const latest = (await app.apps.versions(p, id)).at(-1)!.version;
						made = await app.apps.update(p, id, { baseVersion: latest, files, deleteFiles: current.files.filter((f) => !(f in files)), ...(title ? { title } : {}) });
					} else made = await app.apps.create(p, { title: title ?? folder.slice(folder.lastIndexOf("/") + 1), kind: "backend", files });
					const go = await app.apps.backendToRun(p, made.id);
					try {
						await runBackend(computer, { id: go.id, version: go.version, files: go.files, backend: go.manifest.backend, port: go.port, secret: app.relay.appSecret(p.ownerId, go.id) });
					} catch (error) {
						throw new Error(`Saved ${go.id} version ${go.version}, but its backend didn't start: ${error instanceof Error ? error.message : String(error)}`);
					}
					await app.apps.backendRan(p, go.id, go.version, go.manifest.access);
					return { text: `Deployed app ${go.id}, version ${go.version}: its backend is running on the person's computer. Show it in the chat with app_show.` };
				},
			});
		},
	);
	const known = async (app: App, p: Principal, id: string) => app.apps.backendOf(p, id);
	const logs = tool(
		"app_logs",
		"How an app's backend is doing: whether it runs, how often it restarted, and the end of what it printed. For debugging an app you deployed with app_deploy.",
		Type.Object({ id: Type.String() }),
		async ({ id }, api) => {
			const { app, p } = await caller(api);
			const info = await known(app, p, id);
			const { computer } = await use(api, "app_logs");
			const { apps } = await computer.call<{ apps: { id: string; state: string; restarts: number }[] }>("app_status", { id: computerAppId(id) });
			const mine = apps.find((a) => a.id === computerAppId(id));
			if (!mine) return text("This app's backend hasn't run, or the computer is offline.");
			const log = await computer.call<{ text: string }>("app_logs", { id: computerAppId(id), bytes: 8_000 }).then((r) => r.text, (error: unknown) => `(no log: ${error instanceof Error ? error.message : String(error)})`);
			return text(`${mine.state}, restarted ${mine.restarts} times, version ${info.version ?? "never run"}.\n${log}`);
		},
	);
	const stop = tool(
		"app_stop",
		"Stop an app's backend. The app, its versions and its data stay; app_deploy runs it again.",
		Type.Object({ id: Type.String() }),
		async ({ id }, api) => {
			const { app, p } = await caller(api);
			await known(app, p, id);
			const { computer } = await use(api, "app_stop");
			await computer.call("app_stop", { id: computerAppId(id) });
			return text("Stopped.");
		},
	);
	return [deploy, logs, stop];
}
