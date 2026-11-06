import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { MANIFEST_FILE, parseManifest } from "../app-manifest";
import { type ArtifactStore, checkTitle, MAX_ARTIFACT_FILES } from "../artifacts";
import type { Computer } from "../computer";
import { FILES_ROOT, filesPath } from "../files";
import { HttpError } from "../http";
import { type HostedApps, readFolder } from "../hosted";
import { defineGatedAction, type GatedAction } from "./approvals";
import { text } from "./services";

/**
 * Apps with a backend (see ../hosted.ts) as tools. `app_deploy` is a gated
 * action: it saves a folder of the person's files as a version of an app and
 * runs its backend on their computer, where it can do what any program
 * there can, so they approve each deploy. Looking at an app's backend and
 * stopping it need no approval.
 */
export const APP_DEPLOY = "app_deploy";

export type HostedServices = {
	readonly computer: Computer;
	readonly artifacts: ArtifactStore;
	readonly hosted: HostedApps;
	/** Throws once the space is being erased: work still under way then writes nothing. */
	assertOpen(): void;
};

const HOW = `An app with a backend is a folder in the person's files (${FILES_ROOT}/…) with a ${MANIFEST_FILE} at its root: {"backend": {"command": "node server.js", "install": "npm ci"}}. command starts the backend, from a copy of the folder, and it must listen on 127.0.0.1 at the port in $PORT; install runs first, in the same copy (a copy has no node_modules or .git, so install what it needs there). The app is its frontend and its backend in one folder: whatever the backend answers at / is the app's page, shown beside the chat. Use relative addresses in the page (fetch("api/items"), not fetch("/api/items")), because it isn't served from the root of an address. The page runs in a sandbox and can reach only its own backend. The backend keeps what it needs in $PIM_APP_DATA, a folder that stays across versions. The folder may hold up to ${MAX_ARTIFACT_FILES} files. Only the person can open it.`;

/** Deploying: the folder becomes a version, and its backend runs on the computer, once the person approves. */
export function appDeployAction(services: HostedServices): GatedAction {
	const { computer, artifacts, hosted } = services;
	return defineGatedAction({
		name: APP_DEPLOY,
		description: `Deploy an app with a backend: save a folder of the person's files as a new version of an app and run its backend on their computer. ${HOW} Give id to deploy a new version of an app you deployed before; without it a new app is made, with title as its name. Returns the version and what the backend printed if it didn't start. Show it in the chat with app_show.`,
		parameters: Type.Object({
			path: Type.String({ minLength: 1, description: `The folder, under ${FILES_ROOT}.` }),
			id: Type.Optional(Type.String({ description: "The app to deploy a new version of, from app_list." })),
			title: Type.Optional(Type.String({ maxLength: 200, description: "A new app's name; the folder's name if left out." })),
		}),
		summarize: ({ path, id, title }) => {
			const known = id === undefined ? undefined : artifacts.get(id);
			return known ? `Deploy ${path} as a new version of ${known.title}, and run its backend on your computer` : `Deploy ${path} as ${title ? `the app ${title}` : "an app"}, and run its backend on your computer`;
		},
		async run({ path, id, title }, request) {
			services.assertOpen();
			if (filesPath(path) === null) throw new Error(`${path} is not a folder under ${FILES_ROOT}.`);
			const folder = path.replace(/\/+$/, "");
			// The files, as the version will hold them.
			const files = await readFolder(computer, folder, MAX_ARTIFACT_FILES + 1).catch((error) => {
				throw error instanceof Error ? error : new Error(String(error));
			});
			const manifest = files.get(MANIFEST_FILE);
			if (!manifest) throw new Error(`${folder} has no ${MANIFEST_FILE}. ${HOW}`);
			files.delete(MANIFEST_FILE);
			const content = new TextDecoder().decode(manifest);
			parseManifest(content);
			const put = Object.fromEntries(files);
			let made: { artifact: string; version: number };
			if (id !== undefined) {
				const current = artifacts.get(id);
				if (!current || current.kind !== "hosted") throw new Error(`${id} is not an app with a backend. Leave id out to make a new one.`);
				const latest = artifacts.version(id)!;
				const remove = latest.files.map((file) => file.path).filter((file) => file !== MANIFEST_FILE && !files.has(file));
				const { version } = await artifacts.append(id, { baseVersion: current.version, content, files: put, remove, source: "agent", ...(title ? { title: checkTitle(title) } : {}) });
				made = version;
			} else {
				made = await artifacts.create({ id: crypto.randomUUID(), title: checkTitle(title ?? folder.slice(folder.lastIndexOf("/") + 1)), kind: "hosted", content, files: put, session: request.session });
			}
			try {
				await hosted.run(made.artifact, made.version);
			} catch (error) {
				const said = error instanceof Error ? error.message : String(error);
				throw new Error(`Saved ${made.artifact} version ${made.version}, but its backend didn't start: ${said}`);
			}
			return `Deployed app ${made.artifact}, version ${made.version}: its backend is running on the person's computer. Show it in the chat with app_show.`;
		},
	});
}

/** Looking at an app's backend, and stopping it: tools only while the person has a computer, as the file tools are. */
export function hostedExtension({ hosted, artifacts, computer }: HostedServices) {
	if (!computer.paired()) return defineExtension({ name: "pim.hosted", tools: [] });
	const known = (id: string) => {
		const app = artifacts.get(id);
		if (!app || app.kind !== "hosted") throw new HttpError(404, `${id} is not an app with a backend.`);
		return app;
	};
	const logs = defineTool({
		name: "app_logs",
		description: "How an app's backend is doing: whether it runs, how often it restarted, and the end of what it printed. For debugging an app you deployed with app_deploy.",
		parameters: Type.Object({ id: Type.String() }),
		replay: "safe",
		async execute({ id }) {
			try {
				known(id);
				const status = await hosted.status(id);
				if (!status) return text("This app's backend hasn't run, or the computer is offline.");
				const log = await hosted.logs(id, 8_000).catch((error: unknown) => `(no log: ${error instanceof Error ? error.message : String(error)})`);
				return text(`${status.state}, restarted ${status.restarts} times, version ${hosted.version(id)}.\n${log}`);
			} catch (error) {
				if (error instanceof HttpError) return text(error.message, true);
				throw error;
			}
		},
	});
	const stop = defineTool({
		name: "app_stop",
		description: "Stop an app's backend. The app, its versions and its data stay; app_deploy runs it again.",
		parameters: Type.Object({ id: Type.String() }),
		replay: "safe",
		async execute({ id }) {
			try {
				known(id);
				await hosted.stop(id);
				return text("Stopped.");
			} catch (error) {
				if (error instanceof Error) return text(error.message, true);
				throw error;
			}
		},
	});
	return defineExtension({ name: "pim.hosted", tools: [logs, stop] });
}
