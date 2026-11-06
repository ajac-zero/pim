import { HttpError } from "./http";

/**
 * The manifest of an app with a backend: `pim.app.json`, the main file of a
 * `hosted` app (see ./hosted.ts). It says how to run the app on the person's
 * computer, and who may open it. A field that does nothing is refused, so
 * nobody believes it does.
 *
 * ```json
 * { "backend": { "command": "node server.js", "install": "npm ci" }, "access": "circles" }
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

/**
 * Who may open the app at its own address (see ./hosted.ts): `owner`, the
 * default, only its owner; `circles`, also the people in the circles it is
 * shared with, who sign in to Pim first; `public`, anyone with the address,
 * signed in or not. The last two need the deployment's apps origin.
 */
export const ACCESS_LEVELS = ["owner", "circles", "public"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export type Manifest = { readonly backend: Backend; readonly access: Access };

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
	const { backend, access, ...rest } = parsed as Record<string, unknown>;
	const unknown = Object.keys(rest);
	if (unknown.length > 0) {
		throw new HttpError(400, `${MANIFEST_FILE} has no ${unknown.map((key) => `"${key}"`).join(" or ")} yet: only "backend" and "access" are supported.`);
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
	if (access !== undefined && !ACCESS_LEVELS.includes(access as Access)) {
		throw new HttpError(400, `"access" must be one of ${ACCESS_LEVELS.map((level) => `"${level}"`).join(", ")}: who may open the app. The default is "owner".`);
	}
	return {
		backend: { command: command as string, ...(install === undefined ? {} : { install: install as string }) },
		access: (access as Access | undefined) ?? "owner",
	};
}
