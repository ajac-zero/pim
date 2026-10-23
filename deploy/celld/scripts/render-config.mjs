// Writes the configuration one `celld deploy` reads: the profile (deploy/celld/wrangler.jsonc)
// with the operator's variables, their secrets and APP_CREDENTIALS_KEY added as `vars`. celld
// v0.6.3 has no store for secrets: `celld deploy` keeps every var in the deployment's manifest in
// the fleet bucket, and nowhere else, so this file is written only for the length of one deploy,
// readable only by its owner, and deploy.sh deletes it. Nothing here goes into the Worker's
// bundle (no `define`) or the web app's build. It prints the names it sets, never their values.
//
//   node render-config.mjs --profile FILE --vars FILE [--secrets FILE]
//                          [--app-credentials-key FILE] --out FILE

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** JSONC as celld and Wrangler read it: `//` and block comments outside strings, and trailing commas. */
export function parseJsonc(text) {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === '"') {
			const start = i;
			for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
			out += text.slice(start, i + 1);
		} else if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (char === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2) + 1;
			if (i === 0) throw new Error("unterminated comment");
		} else out += char;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const NAME = /^[A-Z][A-Z0-9_]*$/;
// A name like these is a secret, and belongs in the secrets file, not the variables one.
const SECRET_NAME = /SECRET|PASSWORD|TOKEN|_KEY$|_KEY_|^OTEL_EXPORTER_OTLP(_TRACES)?_HEADERS$/;
export const APP_CREDENTIALS_KEY = "APP_CREDENTIALS_KEY";

/** `NAME=value` lines, as systemd's EnvironmentFile reads them; `#` comments, blank lines, one pair of surrounding quotes. */
export function parseEnv(text, file) {
	const entries = new Map();
	for (const [index, raw] of text.split("\n").entries()) {
		const line = raw.replace(/\r$/, "");
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const at = `${file}:${index + 1}`;
		const match = /^([^=\s]+)=(.*)$/.exec(line);
		if (!match) throw new Error(`${at}: expected NAME=value`);
		const [, name, rawValue] = match;
		if (!NAME.test(name)) throw new Error(`${at}: ${name} isn't an upper-case variable name`);
		if (entries.has(name)) throw new Error(`${at}: ${name} is set twice`);
		const quoted = /^(["'])(.*)\1$/.exec(rawValue);
		const value = quoted ? quoted[2] : rawValue;
		if (value === "") throw new Error(`${at}: ${name} is empty; remove the line to leave it unset`);
		entries.set(name, value);
	}
	return entries;
}

/** A file only its owner can read, as a secret's must be. */
function readPrivate(file) {
	const { mode } = statSync(file);
	if (mode & 0o077) throw new Error(`${file} can be read by others (mode ${(mode & 0o777).toString(8)}); chmod 600 it`);
	return readFileSync(file, "utf8");
}

/** The key that encrypts people's sign-ins to apps: 32 random bytes in base64, alone in its file. */
export function readAppCredentialsKey(text, file) {
	const key = text.trim();
	if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32) {
		throw new Error(`${file} must hold 32 random bytes in base64 and nothing else, as gen-app-credentials-key.sh writes it`);
	}
	return key;
}

/**
 * The profile with `vars` from each source, in order: the profile's own defaults, then the
 * variables, the secrets and the key. Returns the config and, for each name, where it came from.
 */
export function render({ profile, vars, secrets = new Map(), appCredentialsKey = null }) {
	const config = structuredClone(profile);
	const bindings = new Set([
		...(config.durable_objects?.bindings ?? []).map((binding) => binding.name),
		...(config.kv_namespaces ?? []).map((binding) => binding.binding),
		...(config.r2_buckets ?? []).map((binding) => binding.binding),
		config.assets?.binding,
	]);
	const sources = new Map(Object.keys(config.vars ?? {}).map((name) => [name, "profile"]));
	const merged = { ...config.vars };
	for (const [name, value] of vars) {
		if (SECRET_NAME.test(name)) throw new Error(`${name} looks like a secret: put it in the secrets file`);
		merged[name] = value;
		sources.set(name, "variables");
	}
	for (const [name, value] of secrets) {
		if (vars.has(name)) throw new Error(`${name} is in both the variables and the secrets file`);
		merged[name] = value;
		sources.set(name, "secrets");
	}
	for (const [name, source] of sources) {
		if (bindings.has(name)) throw new Error(`${name} (${source}) is the name of a binding`);
		if (name === APP_CREDENTIALS_KEY) throw new Error(`${APP_CREDENTIALS_KEY} comes only from its own file (--app-credentials-key)`);
	}
	if (appCredentialsKey !== null) {
		merged[APP_CREDENTIALS_KEY] = appCredentialsKey;
		sources.set(APP_CREDENTIALS_KEY, "key file");
	}
	if (!merged.PIM_PUBLIC_URL) throw new Error("PIM_PUBLIC_URL isn't set: Pim answers nowhere without its address");
	config.vars = merged;
	return { config, sources };
}

function main() {
	const { values } = parseArgs({
		options: {
			profile: { type: "string" },
			vars: { type: "string" },
			secrets: { type: "string" },
			"app-credentials-key": { type: "string" },
			out: { type: "string" },
		},
	});
	if (!values.profile || !values.vars || !values.out) throw new Error("--profile, --vars and --out are required");
	const keyFile = values["app-credentials-key"];
	const { config, sources } = render({
		profile: parseJsonc(readFileSync(values.profile, "utf8")),
		vars: parseEnv(readFileSync(values.vars, "utf8"), values.vars),
		secrets: values.secrets ? parseEnv(readPrivate(values.secrets), values.secrets) : new Map(),
		appCredentialsKey: keyFile ? readAppCredentialsKey(readPrivate(keyFile), keyFile) : null,
	});
	// `wx`: never over an existing file, and never readable by anyone else, even for a moment.
	writeFileSync(values.out, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	for (const [name, source] of [...sources].sort()) process.stderr.write(`  ${name.padEnd(36)} ${source}\n`);
	if (!keyFile) process.stderr.write(`  (no ${APP_CREDENTIALS_KEY}: Gmail and Google Drive aren't offered, other apps' sign-ins aren't encrypted)\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`render-config: ${error.message}\n`);
		process.exit(1);
	}
}
