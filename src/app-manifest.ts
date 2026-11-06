import { HttpError } from "./http";

/**
 * The manifest of an app with a backend: `pim.app.json`, the main file of a
 * `hosted` app (see ./hosted.ts). It says how to run the app on the person's
 * computer, and nothing else yet: a field that does nothing is refused, so
 * nobody believes it does.
 *
 * ```json
 * { "backend": { "command": "node server.js", "install": "npm ci" } }
 * ```
 */
export const MANIFEST_FILE = "pim.app.json";

/** How to run the app's backend. */
export type Backend = {
	/** What starts it, run in a login shell in the release's folder; it must listen on `$PORT`, on 127.0.0.1. */
	readonly command: string;
	/** What gets it ready, run first in the same folder, such as `npm ci`; the release has no `node_modules`. */
	readonly install?: string;
};

export type Manifest = { readonly backend: Backend };

const MAX_COMMAND_LENGTH = 1_000;

/** The manifest a text says, or the first thing wrong with it, as a refusal the one who wrote it can act on. */
export function parseManifest(text: string): Manifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new HttpError(400, `${MANIFEST_FILE} must be JSON.`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, `${MANIFEST_FILE} must be a JSON object.`);
	const { backend, ...rest } = parsed as Record<string, unknown>;
	const unknown = Object.keys(rest);
	if (unknown.length > 0) {
		throw new HttpError(400, `${MANIFEST_FILE} has no ${unknown.map((key) => `"${key}"`).join(" or ")} yet: only "backend" is supported, and the app is for its owner alone.`);
	}
	if (typeof backend !== "object" || backend === null || Array.isArray(backend)) {
		throw new HttpError(400, `${MANIFEST_FILE} needs a "backend": { "command": "…" }.`);
	}
	const { command, install, ...other } = backend as Record<string, unknown>;
	if (Object.keys(other).length > 0) {
		throw new HttpError(400, `"backend" has no ${Object.keys(other).map((key) => `"${key}"`).join(" or ")} yet: only "command" and "install" are supported. Pim picks the port and gives it as $PORT.`);
	}
	for (const [name, value] of [["command", command], ["install", install]] as const) {
		if (value === undefined && name === "install") continue;
		if (typeof value !== "string" || value.trim() === "" || value.length > MAX_COMMAND_LENGTH) {
			throw new HttpError(400, `"backend".${name} must be a shell command of at most ${MAX_COMMAND_LENGTH} characters.`);
		}
	}
	return { backend: { command: command as string, ...(install === undefined ? {} : { install: install as string }) } };
}
