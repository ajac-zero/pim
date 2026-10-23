// Writes the configuration one `celld deploy` reads: the profile (deploy/celld/wrangler.jsonc)
// with the operator's variables, their secrets, PIM_INGRESS_SECRET and APP_CREDENTIALS_KEY added as `vars`. celld
// v0.6.3 has no store for secrets: `celld deploy` keeps every var in the deployment's manifest in
// the fleet bucket, and nowhere else, so this file is written only for the length of one deploy,
// readable only by its owner, and deploy.sh deletes it. Nothing here goes into the Worker's
// bundle (no `define`) or the web app's build. It prints the names it sets, never their values.
//
//   node render-config.mjs --profile FILE --vars FILE [--secrets FILE] --ingress-secret FILE
//                          [--app-credentials-key FILE] --out FILE
//   node render-config.mjs --print-env FILE
//       checks a private env file, such as celld.env, as parseEnv reads it, and prints its entries
//       as NAME=value, each ending in a NUL byte, for deploy.sh to export without a shell reading them

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * JSONC as celld and Wrangler read it: JSON with `//` and block comments, and commas before a
 * closing `}` or `]`. One pass that knows where strings are, so nothing inside a string, such as
 * `"a,}"`, `"// x"` or an escaped quote, is ever taken for a comment or a trailing comma.
 */
export function parseJsonc(text) {
	let out = "";
	// A comma not yet known to be trailing: kept back until the next character that counts.
	let comma = "";
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (char === "/" && text[i + 1] === "*") {
			const close = text.indexOf("*/", i + 2);
			if (close === -1) throw new Error("unterminated comment");
			i = close + 1;
		} else if (/\s/.test(char)) {
			out += char;
		} else if (char === ",") {
			out += comma;
			comma = ",";
		} else {
			if (char !== "}" && char !== "]") out += comma;
			comma = "";
			if (char === '"') {
				const start = i;
				for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
				if (i >= text.length) throw new Error("unterminated string");
				out += text.slice(start, i + 1);
			} else out += char;
		}
	}
	return JSON.parse(out + comma);
}

const NAME = /^[A-Z][A-Z0-9_]*$/;
// A name like these is a secret, and belongs in the secrets file, not the variables one.
const SECRET_NAME = /SECRET|PASSWORD|TOKEN|_KEY$|_KEY_|^OTEL_EXPORTER_OTLP(_TRACES)?_HEADERS$/;
export const APP_CREDENTIALS_KEY = "APP_CREDENTIALS_KEY";
export const INGRESS_SECRET = "PIM_INGRESS_SECRET";
// Set by the profile, for every celld Pim; never by the operator's files.
const RUNTIME = "PIM_RUNTIME";

/**
 * `NAME=value` lines, in the one form that means the same to everything that may read them:
 * this script, systemd's EnvironmentFile (Caddy reads ingress.env, celld reads celld.env), and a
 * dotenv reader. A value is taken exactly as written, so anything those would read differently
 * is refused rather than changed: quotes, backslashes (escapes, continued lines), `$` and
 * backticks (expansion), whitespace and control characters, characters beyond ASCII, a carriage
 * return, `export`, and a name line or comment that doesn't start the line. Comments are lines
 * whose first character is `#`. None of these files is meant to be `source`d by a shell.
 */
export function parseEnv(text, file) {
	const entries = new Map();
	for (const [index, line] of text.split("\n").entries()) {
		const at = `${file}:${index + 1}`;
		if (line.includes("\r")) throw new Error(`${at}: has a carriage return (Windows line ends); save the file with \\n alone`);
		if (line === "" || line.startsWith("#")) continue;
		if (/^\s/.test(line)) throw new Error(`${at}: starts with whitespace; start each line with its name or #`);
		const match = /^([^=]*)=(.*)$/.exec(line);
		if (!match) throw new Error(`${at}: expected NAME=value`);
		const [, name, value] = match;
		if (name.startsWith("export ")) throw new Error(`${at}: drop "export"; the line is NAME=value alone`);
		if (!NAME.test(name)) throw new Error(`${at}: ${JSON.stringify(name)} isn't an upper-case variable name`);
		if (entries.has(name)) throw new Error(`${at}: ${name} is set twice`);
		if (value === "") throw new Error(`${at}: ${name} is empty; remove the line to leave it unset`);
		const odd = /["'\\$`]|[^\x21-\x7e]/.exec(value);
		if (odd) {
			const named = { '"': "a double quote", "'": "a single quote", "\\": "a backslash", $: "a dollar sign", "`": "a backtick" };
			const what = named[odd[0]] ?? (/\s/.test(odd[0]) ? "whitespace" : "a character beyond visible ASCII");
			throw new Error(`${at}: ${name}'s value has ${what}, which systemd or a shell would read differently; write the value bare, without quotes, backslashes, dollar signs, backticks or spaces`);
		}
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
 * The secret only the TLS proxy and Pim share (Pim's celld runtime): `PIM_INGRESS_SECRET=` and at
 * least 32 visible ASCII characters, alone in its file, which Caddy reads too.
 */
export function readIngressSecret(text, file) {
	const entries = parseEnv(text, file);
	const secret = entries.get(INGRESS_SECRET);
	if (entries.size !== 1 || secret === undefined || !/^[\x21-\x7e]{32,}$/.test(secret)) {
		throw new Error(`${file} must hold one line, ${INGRESS_SECRET}= and at least 32 visible ASCII characters, as gen-ingress-secret.sh writes it`);
	}
	return secret;
}

/**
 * The profile with `vars` from each source, in order: the profile's own defaults, then the
 * variables, the secrets and the key. Returns the config and, for each name, where it came from.
 */
export function render({ profile, vars, secrets = new Map(), ingressSecret = null, appCredentialsKey = null }) {
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
		if (name === INGRESS_SECRET) throw new Error(`${INGRESS_SECRET} comes only from its own file (--ingress-secret)`);
		if (name === RUNTIME && source !== "profile") throw new Error(`${RUNTIME} is the profile's to set, not the ${source} file's`);
	}
	if (merged[RUNTIME] === "celld") {
		if (ingressSecret === null) throw new Error(`${INGRESS_SECRET} isn't set (--ingress-secret): Pim's celld runtime refuses every request without it`);
		if (ingressSecret === appCredentialsKey) throw new Error(`${INGRESS_SECRET} must differ from ${APP_CREDENTIALS_KEY}`);
		merged[INGRESS_SECRET] = ingressSecret;
		sources.set(INGRESS_SECRET, "ingress secret file");
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
			"ingress-secret": { type: "string" },
			out: { type: "string" },
			"print-env": { type: "string" },
		},
	});
	if (values["print-env"]) {
		const file = values["print-env"];
		for (const [name, value] of parseEnv(readPrivate(file), file)) process.stdout.write(`${name}=${value}\0`);
		return;
	}
	if (!values.profile || !values.vars || !values.out) throw new Error("--profile, --vars and --out are required");
	const keyFile = values["app-credentials-key"];
	const ingressFile = values["ingress-secret"];
	const { config, sources } = render({
		profile: parseJsonc(readFileSync(values.profile, "utf8")),
		vars: parseEnv(readFileSync(values.vars, "utf8"), values.vars),
		secrets: values.secrets ? parseEnv(readPrivate(values.secrets), values.secrets) : new Map(),
		ingressSecret: ingressFile ? readIngressSecret(readPrivate(ingressFile), ingressFile) : null,
		appCredentialsKey: keyFile ? readAppCredentialsKey(readPrivate(keyFile), keyFile) : null,
	});
	// `wx`: never over an existing file, and never readable by anyone else, even for a moment.
	writeFileSync(values.out, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	for (const [name, source] of [...sources].sort()) process.stderr.write(`  ${name.padEnd(36)} ${source}\n`);
	if (!keyFile) process.stderr.write(`  (no ${APP_CREDENTIALS_KEY}: Gmail and Google Drive aren't offered, other apps' sign-ins aren't encrypted)\n`);
}

// Run as a command, not when imported (by the checks, or `node -e`, where there is no argv[1]).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`render-config: ${error.message}\n`);
		process.exit(1);
	}
}
