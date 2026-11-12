import { MAX_SETUP_SCRIPT_BYTES } from "./environment-cache";
import type { ConfiguredSetup } from "./repo-environment";
import type { Workspace } from "./workspace/types";

/**
 * A repository's declarative environment contract, `.pim/env.json`: the
 * setup to run, the files whose contents the cached environment depends on,
 * the paths worth caching, the services a thread can start, and the
 * commands that check the repository. The file is read strictly: one wrong
 * field makes the whole file ignored, with the reasons said, so a typo
 * never half-applies. Fields this version doesn't know are ignored with a
 * note, so a newer file still works on an older Pim.
 */

/** Where the contract is, relative to the repository's root. */
export const ENV_CONFIG_PATH = ".pim/env.json";

/** The largest `.pim/env.json`, in bytes. */
export const MAX_ENV_CONFIG_BYTES = 32 * 1024;
export const MAX_SERVICES = 20;
export const MAX_CHECK_COMMANDS = 50;
export const MAX_CHECK_COMMAND_CHARS = 200;
export const MAX_CACHE_KEYS = 50;
export const MAX_CACHE_PATHS = 50;
const MAX_REASONS = 5;
const MAX_PATH_CHARS = 200;
const MAX_COMMAND_CHARS = 2000;

/** A long-running process of the repository, such as its dev server, that listens on a port. */
export type EnvService = {
	readonly name: string;
	readonly command: string;
	readonly port: number;
	/** A command that succeeds once the service is ready to be used. */
	readonly ready?: string;
	/** Whether the service is what the person previews. */
	readonly preview?: boolean;
};

export type EnvConfig = {
	/** The setup script: a list is joined into one that stops at the first failing line. */
	readonly setup?: string;
	readonly cacheKeys: readonly string[];
	readonly cachePaths: readonly string[];
	readonly services: readonly EnvService[];
	readonly check: readonly string[];
};

export type ParsedEnvConfig = { readonly ok: true; readonly config: EnvConfig; readonly notes: readonly string[] } | { readonly ok: false; readonly error: string };

const KNOWN = new Set(["setup", "cacheKeys", "cachePaths", "services", "check"]);
const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const SERVICE_KEYS = new Set(["name", "command", "port", "ready", "preview"]);

/** Reads the text of a `.pim/env.json`. Never throws. */
export function parseEnvConfig(text: string): ParsedEnvConfig {
	if (new TextEncoder().encode(text).length > MAX_ENV_CONFIG_BYTES) return invalid([`it is larger than ${MAX_ENV_CONFIG_BYTES / 1024} KiB`]);
	let value: unknown;
	try {
		value = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return invalid(["it is not valid JSON"]);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(["it must be a JSON object"]);
	const object = value as Record<string, unknown>;
	const reasons: string[] = [];
	const notes: string[] = [];
	for (const key of Object.keys(object)) if (!KNOWN.has(key)) notes.push(`${ENV_CONFIG_PATH}: the unknown field ${safe(key)} is ignored`);

	let setup: string | undefined;
	if (object.setup !== undefined) {
		const raw = object.setup;
		if (typeof raw === "string" && raw.trim()) setup = raw;
		else if (Array.isArray(raw) && raw.length > 0 && raw.every((line) => typeof line === "string" && line.trim())) setup = `set -e\n${(raw as string[]).join("\n")}\n`;
		else reasons.push("setup must be a non-empty string or a list of non-empty strings");
		if (setup !== undefined && new TextEncoder().encode(setup).length > MAX_SETUP_SCRIPT_BYTES) {
			reasons.push(`setup is larger than ${MAX_SETUP_SCRIPT_BYTES / 1024} KiB`);
			setup = undefined;
		}
	}
	const cacheKeys = pathList(object, "cacheKeys", MAX_CACHE_KEYS, reasons);
	const cachePaths = pathList(object, "cachePaths", MAX_CACHE_PATHS, reasons);
	const check = commandList(object, reasons);
	const services = serviceList(object, reasons);
	if (reasons.length > 0) return invalid(reasons);
	return { ok: true, config: { ...(setup === undefined ? {} : { setup }), cacheKeys, cachePaths, services, check }, notes };
}

function invalid(reasons: readonly string[]): ParsedEnvConfig {
	const shown = reasons.slice(0, MAX_REASONS).join("; ");
	return { ok: false, error: `${ENV_CONFIG_PATH} is ignored: ${shown}${reasons.length > MAX_REASONS ? `; and ${reasons.length - MAX_REASONS} more` : ""}` };
}

/** A name from the file, as safe to show: printable and short. */
function safe(text: string): string {
	return JSON.stringify(text.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 60));
}

/** Whether a path or glob is relative and stays inside the repository. */
function relativePath(path: string): boolean {
	return path.length > 0 && path.length <= MAX_PATH_CHARS && !path.startsWith("/") && !path.startsWith("~") && !path.includes("\\") && !/[\u0000-\u001f\u007f]/.test(path) && !path.split("/").includes("..");
}

function pathList(object: Record<string, unknown>, field: "cacheKeys" | "cachePaths", max: number, reasons: string[]): string[] {
	const raw = object[field];
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || !raw.every((each) => typeof each === "string")) {
		reasons.push(`${field} must be a list of strings`);
		return [];
	}
	if (raw.length > max) reasons.push(`${field} has more than ${max} entries`);
	const bad = raw.filter((each) => !relativePath(each));
	if (bad.length > 0) reasons.push(`${field} must hold relative paths inside the repository, not ${safe(bad[0]!)}`);
	return reasons.length > 0 ? [] : [...new Set(raw)];
}

function commandList(object: Record<string, unknown>, reasons: string[]): string[] {
	const raw = object.check;
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || !raw.every((each) => typeof each === "string" && each.trim() !== "")) {
		reasons.push("check must be a list of non-empty strings");
		return [];
	}
	if (raw.length > MAX_CHECK_COMMANDS) reasons.push(`check has more than ${MAX_CHECK_COMMANDS} commands`);
	if (raw.some((each) => each.length > MAX_CHECK_COMMAND_CHARS)) reasons.push(`a check command is longer than ${MAX_CHECK_COMMAND_CHARS} characters`);
	return raw.map((each) => each.trim());
}

function serviceList(object: Record<string, unknown>, reasons: string[]): EnvService[] {
	const raw = object.services;
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		reasons.push("services must be a list");
		return [];
	}
	if (raw.length > MAX_SERVICES) {
		reasons.push(`services has more than ${MAX_SERVICES} entries`);
		return [];
	}
	const services: EnvService[] = [];
	const names = new Set<string>();
	const ports = new Set<number>();
	const command = (value: unknown) => typeof value === "string" && value.trim() !== "" && value.length <= MAX_COMMAND_CHARS;
	raw.forEach((each, index) => {
		const at = `services[${index}]`;
		if (typeof each !== "object" || each === null || Array.isArray(each)) return void reasons.push(`${at} must be an object`);
		const service = each as Record<string, unknown>;
		let ok = true;
		const fail = (why: string) => {
			ok = false;
			reasons.push(`${at}.${why}`);
		};
		for (const key of Object.keys(service)) if (!SERVICE_KEYS.has(key)) fail(`${safe(key)} is not a service field`);
		if (typeof service.name !== "string" || !SERVICE_NAME.test(service.name)) fail("name must be a letter then up to 39 letters, digits, `_` or `-`");
		else if (names.has(service.name.toLowerCase())) fail("name repeats another service's");
		else names.add(service.name.toLowerCase());
		if (!command(service.command)) fail("command must be a non-empty string");
		if (typeof service.port !== "number" || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) fail("port must be a whole number from 1 to 65535");
		else if (ports.has(service.port)) fail("port repeats another service's");
		else ports.add(service.port);
		if (service.ready !== undefined && !command(service.ready)) fail("ready must be a non-empty string");
		if (service.preview !== undefined && typeof service.preview !== "boolean") fail("preview must be true or false");
		if (ok) services.push({ name: service.name as string, command: (service.command as string).trim(), port: service.port as number, ...(service.ready === undefined ? {} : { ready: (service.ready as string).trim() }), ...(service.preview === undefined ? {} : { preview: service.preview as boolean }) });
	});
	return services;
}

/** What `readEnvConfig` found: no file, a usable one, or one that was ignored (`error` says why). Notes are for the person and the agent. */
export type EnvConfigRead = { readonly config: EnvConfig | null; readonly notes: readonly string[]; readonly error?: string };

/** Reads the repository's `.pim/env.json`. Never throws: a file that can't be read or understood is ignored, with a note. */
export async function readEnvConfig(workspace: Workspace, root: string): Promise<EnvConfigRead> {
	try {
		let stat: Awaited<ReturnType<Workspace["stat"]>>;
		try {
			stat = await workspace.stat(`${root}/${ENV_CONFIG_PATH}`);
		} catch {
			return { config: null, notes: [] };
		}
		if (stat.type !== "file") return { config: null, notes: [] };
		if (stat.size > MAX_ENV_CONFIG_BYTES) {
			const error = invalid([`it is larger than ${MAX_ENV_CONFIG_BYTES / 1024} KiB`]);
			return { config: null, notes: [error.ok ? "" : error.error], error: error.ok ? undefined : error.error };
		}
		const parsed = parseEnvConfig(new TextDecoder().decode(await workspace.readFile(`${root}/${ENV_CONFIG_PATH}`)));
		return parsed.ok ? { config: parsed.config, notes: parsed.notes } : { config: null, notes: [parsed.error], error: parsed.error };
	} catch {
		const error = `${ENV_CONFIG_PATH} is ignored: it couldn't be read`;
		return { config: null, notes: [error], error };
	}
}

/** A setup to run, with where it came from and the text the environment's key covers. */
export type ChosenSetup = { readonly script: string; readonly source: "settings" | "env" | "repository" | "mise" | "devcontainer"; readonly content: string };

/** The setup to run, the highest of: the person's setting, `.pim/env.json`'s `setup`, `.pim/setup.sh`, a mise task, a dev container's commands; null without any. Lower sources are read only when needed. */
export async function chooseSetup(o: { setting: string | null; config: EnvConfig | null; repository: () => Promise<string | null>; configured: () => Promise<ConfiguredSetup | null> }): Promise<ChosenSetup | null> {
	if (o.setting !== null) return { script: o.setting, source: "settings", content: o.setting };
	if (o.config?.setup !== undefined) return { script: o.config.setup, source: "env", content: o.config.setup };
	const own = await o.repository();
	if (own !== null) return { script: own, source: "repository", content: own };
	return o.configured();
}
