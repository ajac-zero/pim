/**
 * The operator's side of a Cua evaluation VM's installation
 * (docs/cua-eval-install.md), run on the operator's machine, never on the VM:
 *
 *   node operator.ts bundle --commit <sha> --ws-tarball <ws-8.22.0.tgz> --out <new directory>
 *   node operator.ts digest --dir <bundle directory>
 *   node operator.ts render --config <config.json> --out <new directory>
 *
 * `bundle` makes the directory the VM runs: the programs' files exactly as
 * they are at the commit (read from git's objects, not the working tree),
 * and `ws` from the npm tarball the operator supplies, which must match the
 * integrity the commit's pnpm-lock.yaml pins. It extracts only regular
 * files and directories under `package/`, and fetches nothing. It prints
 * the bundle's tree digest, which the operator pins in the configuration:
 * that pin, not anything inside the bundle, is what the VM trusts.
 *
 * `digest` prints the tree digest of a directory, to check a copy.
 *
 * `render` checks a configuration and writes, into a new private directory
 * (0700, each file 0600), the management scripts for
 * Azure Run Command (`plan.sh`, `install.sh`, `seal.sh`, `start.sh`,
 * `status.sh`) and a cloud-init `cloud-config.yaml` that places the same
 * scripts on the VM. They hold no secret, run nothing they read from a
 * request, and make no call to the cloud. Each checks the pinned Node and
 * the bundle's tree digest before it runs anything from them.
 *
 * Importing it does nothing.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as zlib from "node:zlib";
import { ACCOUNTS, BRIDGE_CERT_DAYS, BUNDLE_FILES, BUNDLE_FORMAT, type Config, isPlainPath, PATHS, parseConfig, Refusal, TOOLS, VIEWER_ACCOUNTS, VIEWER_ASSET_DIR, VIEWER_ASSET_NAMES, VIEWER_ASSET_SHA256, VIEWER_BUNDLE_FILES, VIEWER_PATHS, viewerBundleFiles } from "./config.ts";
import { integrityHex, missingPins, PINS, type Pins } from "./pins.ts";

/** The repository's files a bundle holds, as they are at its commit. */
export const BUNDLE_SOURCES = [
	"package.json",
	"computer/pim-computer.ts",
	"computer/cua-bridge.ts",
	"computer/native-outcome.ts",
	"computer/cua-host/package.json",
	"computer/cua-host/bridge.ts",
	"computer/cua-host/desktop.ts",
	"computer/cua-host/cua-credential.ts",
	"computer/cua-host/session.ts",
	"computer/cua-host/host.ts",
	"computer/cua-host/origin.ts",
	"computer/cua-host/eval-credentials.ts",
	"computer/cua-host/eval-install/config.ts",
	"computer/cua-host/eval-install/install.ts",
] as const;

const WS_DIR = "computer/cua-host/node_modules/ws";
const MAX_TARBALL_BYTES = 1024 * 1024;
const MAX_UNPACKED_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 256;
const ENTRY = /^[A-Za-z0-9._@-]+$/;

// ---- The tree digest ----

/**
 * A directory's tree digest: the SHA-256 of one line per entry under it,
 * sorted by relative path (bytewise), `d <mode> <path>` for a directory and
 * `f <mode> <sha256> <path>` for a regular file, the mode in octal as
 * `stat -c %a` prints it, each line ended by `\n`. Links and anything else
 * are refused, as are names outside `[A-Za-z0-9._@-]`. `TREE_DIGEST_BASH`
 * computes the same on the VM.
 */
export function treeDigest(dir: string): string {
	const entries: string[] = [];
	const walk = (relative: string) => {
		for (const name of fs.readdirSync(path.join(dir, relative))) {
			if (!ENTRY.test(name)) throw new Refusal("bundle-name");
			const child = relative ? `${relative}/${name}` : name;
			entries.push(child);
			const stat = fs.lstatSync(path.join(dir, child));
			if (stat.isDirectory()) walk(child);
			else if (!stat.isFile()) throw new Refusal("bundle-type");
		}
	};
	walk("");
	if (entries.length === 0) throw new Refusal("bundle-empty");
	entries.sort();
	const lines = entries.map((entry) => {
		const full = path.join(dir, entry);
		const stat = fs.lstatSync(full);
		const mode = (stat.mode & 0o7777).toString(8);
		if (stat.isDirectory()) return `d ${mode} ${entry}\n`;
		if (!stat.isFile()) throw new Refusal("bundle-type");
		return `f ${mode} ${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")} ${entry}\n`;
	});
	return crypto.createHash("sha256").update(lines.join("")).digest("hex");
}

/** The same digest in bash, for the management scripts: GNU find, sort, stat and sha256sum, as Ubuntu has them. */
export const TREE_DIGEST_BASH = `# The bundle's tree digest (computer/cua-host/eval-install/operator.ts, treeDigest).
tree_lines() {
	local entry
	while IFS= read -r -d '' entry; do
		[[ "$entry" =~ ^[A-Za-z0-9._@-]+(/[A-Za-z0-9._@-]+)*$ ]] || return 1
		if [[ -L "$entry" ]]; then
			return 1
		elif [[ -d "$entry" ]]; then
			printf 'd %s %s\\n' "$(stat -c %a -- "$entry")" "$entry"
		elif [[ -f "$entry" ]]; then
			printf 'f %s %s %s\\n' "$(stat -c %a -- "$entry")" "$(sha256sum <"$entry" | cut -d' ' -f1)" "$entry"
		else
			return 1
		fi
	done
}
tree_digest() {
	local listing
	listing="$(cd -- "$1" && find . -mindepth 1 -printf '%P\\0' | LC_ALL=C sort -z | tree_lines)" || return 1
	[[ -n "$listing" ]] || return 1
	printf '%s\\n' "$listing" | sha256sum | cut -d' ' -f1
}`;

// ---- The bundle ----

/** The integrity pnpm-lock.yaml pins for `ws@<version>`. */
export function lockedIntegrity(lockfile: string, version: string): string {
	const escaped = version.replace(/\./g, "\\.");
	const match = new RegExp(`^  ws@${escaped}:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/]{86}==)\\}$`, "m").exec(lockfile);
	if (!match) throw new Refusal("ws-lock");
	return match[1]!;
}

/** The integrity pnpm-lock.yaml pins for any package at an exact version (a scoped name is quoted there). */
export function lockedPackageIntegrity(lockfile: string, name: string, version: string): string {
	const escape = (text: string) => text.replace(/[.\\/@]/g, "\\$&");
	const match = new RegExp(`^  '?${escape(name)}@${escape(version)}'?:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/]{86}==)\\}$`, "m").exec(lockfile);
	if (!match) throw new Refusal("package-lock");
	return match[1]!;
}

function octal(header: Buffer, start: number, length: number, reason = "ws-tarball"): number {
	const text = header.subarray(start, start + length).toString("latin1").replace(/[\0 ]+$/, "");
	if (!/^[0-7]{1,12}$/.test(text)) throw new Refusal(reason);
	return Number.parseInt(text, 8);
}

function cString(header: Buffer, start: number, length: number): string {
	const field = header.subarray(start, start + length);
	const end = field.indexOf(0);
	return field.subarray(0, end < 0 ? length : end).toString("latin1");
}

/**
 * The regular files of an npm package tarball (gzip, ustar), by their path
 * under `package/`. Refused: anything but regular files and directories
 * (links, devices, PAX or GNU headers), a bad checksum, a name outside
 * `package/` or with `..`, `.` or an unusual character, a duplicate, and
 * more than the bounds allow.
 */
export function untarPackage(tarball: Buffer, limits: { maxUnpacked?: number; maxEntries?: number; reason?: string } = {}): Map<string, Buffer> {
	const { maxUnpacked = MAX_UNPACKED_BYTES, maxEntries = MAX_ENTRIES, reason = "ws-tarball" } = limits;
	let tar: Buffer;
	try {
		tar = zlib.gunzipSync(tarball, { maxOutputLength: maxUnpacked });
	} catch {
		throw new Refusal(reason);
	}
	const files = new Map<string, Buffer>();
	let offset = 0;
	let entries = 0;
	let ended = false;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			ended = true;
			break;
		}
		if (++entries > maxEntries) throw new Refusal(reason);
		const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 0x20 : byte), 0);
		if (sum !== octal(header, 148, 8, reason)) throw new Refusal(reason);
		if (header.subarray(257, 262).toString("latin1") !== "ustar") throw new Refusal(reason);
		const name = cString(header, 0, 100);
		const prefix = cString(header, 345, 155);
		const full = prefix ? `${prefix}/${name}` : name;
		const size = octal(header, 124, 12, reason);
		const type = String.fromCharCode(header[156]!);
		const start = offset + 512;
		offset = start + Math.ceil(size / 512) * 512;
		if (offset > tar.length) throw new Refusal(reason);
		const parts = full.replace(/\/$/, "").split("/");
		if (type === "5" && size === 0 && parts.length === 1 && parts[0] === "package") continue;
		if (parts[0] !== "package" || parts.length < 2 || !parts.slice(1).every((part) => ENTRY.test(part) && part !== "." && part !== "..")) throw new Refusal(reason);
		const relative = parts.slice(1).join("/");
		if (type === "5") {
			if (size !== 0) throw new Refusal(reason);
			continue;
		}
		if ((type !== "0" && type !== "\0") || full.endsWith("/")) throw new Refusal(reason);
		if (files.has(relative)) throw new Refusal(reason);
		files.set(relative, Buffer.from(tar.subarray(start, start + size)));
	}
	if (!ended || files.size === 0) throw new Refusal(reason);
	// No file may also be a directory of another.
	for (const file of files.keys()) {
		if ([...files.keys()].some((other) => other.startsWith(`${file}/`))) throw new Refusal(reason);
	}
	return files;
}

/**
 * Every file of a bundle, by its path in it: the repository's sources at
 * the commit, `ws` from its tarball once its SHA-512 is the locked
 * integrity, and the `BUNDLE` marker naming the commit and `ws`.
 */
export function bundleEntries(options: { commit: string; sources: ReadonlyMap<string, Buffer>; wsVersion: string; wsIntegrity: string; wsTarball: Buffer; viewer?: ViewerBundle }): Map<string, Buffer> {
	const { commit, sources, wsVersion, wsIntegrity, wsTarball } = options;
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Refusal("commit");
	if (wsTarball.length > MAX_TARBALL_BYTES) throw new Refusal("ws-tarball");
	const actual = `sha512-${crypto.createHash("sha512").update(wsTarball).digest("base64")}`;
	if (actual !== wsIntegrity) throw new Refusal("ws-integrity");
	const entries = new Map<string, Buffer>();
	for (const source of BUNDLE_SOURCES) {
		const content = sources.get(source);
		if (!content) throw new Refusal("source");
		entries.set(source, content);
	}
	const ws = untarPackage(wsTarball);
	const manifest = JSON.parse(ws.get("package.json")?.toString("utf8") ?? "null") as { name?: unknown; version?: unknown } | null;
	if (manifest?.name !== "ws" || manifest.version !== wsVersion) throw new Refusal("ws-package");
	for (const [file, content] of ws) entries.set(`${WS_DIR}/${file}`, content);
	// Without a viewer the marker is exactly what it always was.
	const viewerMarker = options.viewer ? addViewer(entries, sources, options.viewer) : "";
	entries.set(BUNDLE_FILES.marker, Buffer.from(`${BUNDLE_FORMAT}\ncommit ${commit}\nws ${wsVersion} ${wsIntegrity}\n${viewerMarker}`));
	return entries;
}

/** What a bundle with the viewer adds: the one package it needs, from its tarball at the locked integrity. */
export type ViewerBundle = { readonly protobufVersion: string; readonly protobufIntegrity: string; readonly protobufTarball: Buffer };

/** The viewer's own sources in the repository at the commit: everything it adds to the bundle but the pinned package's files. */
export const VIEWER_SOURCES = viewerBundleFiles().filter((file) => file !== VIEWER_BUNDLE_FILES.protobuf);

const PROTOBUF_DIR = "computer/cua-host/node_modules/@bufbuild/protobuf";
const MAX_PROTOBUF_TARBALL_BYTES = 4 * 1024 * 1024;

/**
 * Adds the viewer's programs, its pinned page and scripts (each checked against its pinned SHA-256: nothing
 * about them is taken on trust) and the pinned `@bufbuild/protobuf` (its tarball's SHA-512 must be the locked
 * integrity). Answers the marker line that names the package. Nothing is fetched and no package manager runs.
 */
function addViewer(entries: Map<string, Buffer>, sources: ReadonlyMap<string, Buffer>, viewer: ViewerBundle): string {
	for (const source of VIEWER_SOURCES) {
		const content = sources.get(source);
		if (!content) throw new Refusal("source");
		entries.set(source, content);
	}
	for (const name of VIEWER_ASSET_NAMES) {
		const content = entries.get(`${VIEWER_ASSET_DIR}/assets/${name}`)!;
		if (crypto.createHash("sha256").update(content).digest("hex") !== VIEWER_ASSET_SHA256[name]) throw new Refusal("viewer-asset");
	}
	if (viewer.protobufTarball.length > MAX_PROTOBUF_TARBALL_BYTES) throw new Refusal("protobuf-tarball");
	if (`sha512-${crypto.createHash("sha512").update(viewer.protobufTarball).digest("base64")}` !== viewer.protobufIntegrity) throw new Refusal("protobuf-integrity");
	// The package has hundreds of files, so its bounds are wider than `ws`'s; every other rule of `untarPackage` holds.
	const files = untarPackage(viewer.protobufTarball, { maxUnpacked: 16 * 1024 * 1024, maxEntries: 4096, reason: "protobuf-tarball" });
	const manifest = JSON.parse(files.get("package.json")?.toString("utf8") ?? "null") as { name?: unknown; version?: unknown } | null;
	if (manifest?.name !== "@bufbuild/protobuf" || manifest.version !== viewer.protobufVersion) throw new Refusal("protobuf-package");
	for (const [file, content] of files) entries.set(`${PROTOBUF_DIR}/${file}`, content);
	return `protobuf ${viewer.protobufVersion} ${viewer.protobufIntegrity}\n`;
}

// ---- The import closure ----

const PACKAGES_DIR = "computer/cua-host/node_modules";

/**
 * Each runtime import of a TypeScript source, as Node would load it: static `import`/`export … from` and `import "x"`, and a dynamic `import("x")` of a string.
 * An `import type`/`export type … from` is erased by Node's type stripping and is not one. An inline `import { type A } from "x"` is NOT erased whole (it becomes
 * `import {} from "x"`, which still loads the module), so it counts. A `typeof import("x")` in a type position is read as a dynamic import and so counts too, which can only over-report.
 */
export function runtimeImports(source: string): { specifier: string; dynamic: boolean }[] {
	const found: { specifier: string; dynamic: boolean }[] = [];
	for (const match of source.matchAll(/^[ \t]*(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s+["']([^"']+)["']/gm)) if (!match[1]) found.push({ specifier: match[2]!, dynamic: false });
	for (const match of source.matchAll(/^[ \t]*import\s+["']([^"']+)["']/gm)) found.push({ specifier: match[1]!, dynamic: false });
	for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push({ specifier: match[1]!, dynamic: true });
	return found;
}

/** The file a package's `exports` gives `subpath` (`.` or `./name`) under Node's `import` then `default` conditions, or null. */
function exportTarget(exports: unknown, subpath: string): string | null {
	const resolve = (value: unknown): string | null => {
		if (typeof value === "string") return value;
		if (value && typeof value === "object") for (const condition of ["import", "default"]) if (condition in value) return resolve((value as Record<string, unknown>)[condition]);
		return null;
	};
	if (!exports || typeof exports !== "object" || Array.isArray(exports)) return null;
	return Object.hasOwn(exports, subpath) ? resolve((exports as Record<string, unknown>)[subpath]) : null;
}

/**
 * The runtime imports of the bundle's own TypeScript sources that its entries do not satisfy, each as `importer>specifier`: a relative import with no such
 * entry, or a package (and subpath) that is not in the bundle's `node_modules` with its target file. Built-ins (`node:`) are not the bundle's. A dynamic import
 * of one of the viewer's files is not required of a bundle with no viewer, which never loads it. Reads the assembled entries, not the repository.
 */
export function unresolvedImports(entries: ReadonlyMap<string, Buffer>, withViewer: boolean): string[] {
	const viewerFiles = new Set<string>(VIEWER_SOURCES);
	const missing: string[] = [];
	for (const [file, content] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (!file.endsWith(".ts") || file.startsWith(`${PACKAGES_DIR}/`)) continue;
		for (const { specifier, dynamic } of runtimeImports(content.toString("utf8"))) {
			if (specifier.startsWith("node:")) continue;
			if (specifier.startsWith(".")) {
				const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
				if (entries.has(target) || (dynamic && !withViewer && viewerFiles.has(target))) continue;
			} else {
				const parts = specifier.split("/");
				const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
				const subpath = parts.length > (specifier.startsWith("@") ? 2 : 1) ? `./${parts.slice(specifier.startsWith("@") ? 2 : 1).join("/")}` : ".";
				const manifest = entries.get(`${PACKAGES_DIR}/${name}/package.json`);
				if (manifest) {
					let exports: unknown;
					try {
						exports = (JSON.parse(manifest.toString("utf8")) as { exports?: unknown }).exports;
					} catch {
						exports = undefined;
					}
					const target = exportTarget(exports, subpath);
					// With no `exports` the package's own entry is its `main`, which the pinned packages' manifests name; a subpath needs a map.
					if (exports === undefined ? subpath === "." : target !== null && entries.has(path.posix.normalize(path.posix.join(PACKAGES_DIR, name, target)))) continue;
				}
			}
			missing.push(`${file}>${specifier}`);
		}
	}
	return missing;
}

/** Writes `entries` into `out`, a new directory: files 0644, directories 0755. */
export function writeTree(out: string, entries: ReadonlyMap<string, Buffer>): void {
	if (!path.isAbsolute(out) || path.normalize(out) !== out) throw new Refusal("out");
	try {
		fs.mkdirSync(out, { mode: 0o755 });
	} catch (error) {
		throw new Refusal((error as NodeJS.ErrnoException).code === "EEXIST" ? "out-exists" : "out");
	}
	fs.chmodSync(out, 0o755);
	for (const [file, content] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const parts = file.split("/");
		for (let i = 1; i < parts.length; i++) {
			const dir = path.join(out, ...parts.slice(0, i));
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir);
				fs.chmodSync(dir, 0o755);
			}
		}
		const target = path.join(out, file);
		fs.writeFileSync(target, content, { flag: "wx", mode: 0o644 });
		fs.chmodSync(target, 0o644);
	}
}

/**
 * Writes `files` (flat names) into `out`, a new directory of this account's
 * (0700), each new (never over or through anything) and 0600: the
 * operator's own copies of the rendered scripts, kept private like the rest
 * of an evaluation's state. `out`'s parent must be this account's and
 * writable by no one else, and every directory above it this account's or
 * root's, not a link, and writable by no one else unless sticky (as /tmp).
 */
export function writePrivate(out: string, files: ReadonlyMap<string, Buffer>): void {
	if (!path.isAbsolute(out) || path.normalize(out) !== out || out.endsWith("/")) throw new Refusal("out");
	const euid = process.geteuid?.() ?? -1;
	const parent = path.dirname(out);
	let current = "";
	for (const part of ["", ...parent.split("/").filter(Boolean)]) {
		current = part ? `${current === "/" ? "" : current}/${part}` : "/";
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch {
			throw new Refusal("out-parent");
		}
		const writable = (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0;
		if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== euid) || writable) throw new Refusal("out-parent");
		if (current === parent && (stat.uid !== euid || (stat.mode & 0o022) !== 0)) throw new Refusal("out-parent");
	}
	try {
		fs.mkdirSync(out, { mode: 0o700 });
	} catch (error) {
		throw new Refusal((error as NodeJS.ErrnoException).code === "EEXIST" ? "out-exists" : "out");
	}
	fs.chmodSync(out, 0o700);
	for (const [name, content] of files) {
		if (!ENTRY.test(name)) throw new Refusal("out");
		const descriptor = fs.openSync(path.join(out, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
		try {
			fs.fchmodSync(descriptor, 0o600);
			fs.writeFileSync(descriptor, content);
		} finally {
			fs.closeSync(descriptor);
		}
	}
}

// ---- The management scripts ----

/** A value for a single-quoted shell word; every value here is already checked to hold no quote. */
function quote(value: string): string {
	if (!/^[A-Za-z0-9._:/@=+-]*$/.test(value)) throw new Refusal("render-value");
	return `'${value}'`;
}

const HEREDOC = "PIM_CUA_EVAL_CONFIG";

/** What every script but `fetch` checks before it runs anything from the bundle: the pinned Node, then the bundle's ownership and tree digest. */
const CHECKS = `trusted_file "$NODE" || fail node-path
[[ "$(sha256sum <"$NODE" | cut -d' ' -f1)" == "$NODE_SHA256" ]] || fail node-digest
trusted_dirs "$BUNDLE" || fail bundle-path
# Everything in the bundle is root's, a regular file or a directory, with no write for others and no special bits.
unexpected="$(find "$BUNDLE" \\( ! -uid 0 -o -perm /022 -o -perm /7000 -o \\( ! -type f ! -type d \\) \\) -print -quit)" || fail bundle-ownership
[[ -z "$unexpected" ]] || fail bundle-ownership
digest="$(tree_digest "$BUNDLE")" || fail bundle-digest
[[ "$digest" == "$BUNDLE_SHA256" ]] || fail bundle-digest
`;

/** With `verify` false (only `fetch.sh`, which runs before Node and the bundle exist) it checks root and nothing else. */
function prologue(config: Config, command: string, verify = true): string {
	return `#!/bin/bash
# Pim Cua evaluation: ${command} (docs/cua-eval-install.md), for evaluation ${config.evaluation}.
# Rendered by computer/cua-host/eval-install/operator.ts. It holds no secret and prints none.
# Before running anything from them, it checks the pinned Node and the bundle's tree digest (all but fetch, which brings them).
if [ -z "\${BASH_VERSION:-}" ]; then exec /bin/bash "$0" "$@"; fi
set -euo pipefail
umask 077
export LC_ALL=C PATH=/usr/sbin:/usr/bin
cd /

readonly COMMAND=${quote(command)}
readonly BUNDLE=${quote(config.bundle.dir)}
readonly BUNDLE_SHA256=${quote(config.bundle.sha256)}
readonly NODE=${quote(config.node.path)}
readonly NODE_SHA256=${quote(config.node.sha256)}

fail() {
	printf '{"event":"pim-cua-eval.failed","command":"%s","reason":"%s"}\\n' "$COMMAND" "$1" >&2
	exit 1
}

# A directory of root's, not a link, that no one else can write.
root_dir() {
	local owner mode
	[[ -d "$1" && ! -L "$1" ]] || return 1
	read -r owner mode < <(stat -c '%u %a' -- "$1") || return 1
	[[ "$owner" == 0 ]] && (( (8#$mode & 8#022) == 0 ))
}

# Every directory from / down to $1 is root_dir.
trusted_dirs() {
	local current="" part
	local -a parts
	root_dir / || return 1
	IFS=/ read -r -a parts <<<"\${1#/}"
	for part in "\${parts[@]}"; do
		[[ -n "$part" && "$part" != . && "$part" != .. ]] || return 1
		current="$current/$part"
		root_dir "$current" || return 1
	done
}

# A regular file of root's, not a link, that no one else can write, in trusted directories.
trusted_file() {
	local owner mode
	trusted_dirs "$(dirname -- "$1")" || return 1
	[[ -f "$1" && ! -L "$1" ]] || return 1
	read -r owner mode < <(stat -c '%u %a' -- "$1") || return 1
	[[ "$owner" == 0 ]] && (( (8#$mode & 8#022) == 0 ))
}

${TREE_DIGEST_BASH}

[[ "$(id -u)" == 0 ]] || fail root-required
${verify ? CHECKS : ""}`;
}

/**
 * The management scripts, by file name. `plan`, `install`, `start` and
 * `status` run the installer as root with the configuration on standard
 * input, from a quoted here-document (nothing in it is expanded). `seal`
 * runs eval-credentials.ts's `seal` once, as the bridge's account, with
 * fixed arguments; its standard output is the envelope and nothing else.
 */
export function renderScripts(config: Config, pins: Pins = PINS): Record<string, string> {
	const json = JSON.stringify(config);
	if (json.split("\n").length !== 1 || json.includes(HEREDOC)) throw new Refusal("render-value");
	const installer = (command: string) =>
		`${prologue(config, command)}
exec "$NODE" "$BUNDLE/${BUNDLE_FILES.installer}" ${command} <<'${HEREDOC}'
${json}
${HEREDOC}
`;
	const seal = `${prologue(config, "seal")}
trusted_file ${TOOLS.runuser} || fail tools
# Once only: seal refuses a token file that is already there, and a failed or lost seal means a new VM (docs/cua-eval-credentials.md).
exec ${TOOLS.runuser} -u ${ACCOUNTS.bridge} -- "$NODE" "$BUNDLE/${BUNDLE_FILES.credentials}" seal \\
	--evaluation ${quote(config.evaluation)} --owner ${quote(config.owner)} \\
	--public-key ${PATHS.publicKey} --fingerprint ${quote(config.evalKey.fingerprint)} \\
	--token-file ${PATHS.token} </dev/null
`;
	// Only with a viewer (docs/cua-viewer-first-startup.md): the journal and spacesd's root token, each made once, as root, from the bundle's own copy of the program;
	// and the bridge's own private certificate, born on the VM so its key never travels.
	// The journal's tombstone is asked for as 0444, and the umask every script starts with (077) would make it 0400. Only `journal` relaxes it, to 022, so the tombstone is 0444 and the journal (0600) and
	// its directory (0700) are as asked; `root-token` stays at 077, with `seal` and the rest, for its 0600 files.
	const provision = (command: string) => `${prologue(config, command)}${command === "journal" ? "umask 022\n" : ""}
exec "$NODE" "$BUNDLE/${VIEWER_BUNDLE_FILES.provision}" ${command} <<'${HEREDOC}'
${json}
${HEREDOC}
`;
	const viewer = config.viewer;
	if (viewer) checkPins(config, viewer, pins);
	const staging = path.posix.dirname(config.tls.cert);
	const bridgeCert = viewer
		? `${prologue(config, "bridge-cert")}
trusted_file /usr/bin/openssl || fail tools
# Once only, into a staging directory made here: new, root's, 0700. The certificate is the bridge's own, private, for the one name Caddy checks it for, valid ${BRIDGE_CERT_DAYS} days.
trusted_dirs ${quote(path.posix.dirname(staging))} || fail staging-parent
[[ ! -e ${quote(staging)} && ! -L ${quote(staging)} ]] || fail staging-exists
mkdir -m 0700 -- ${quote(staging)}
exec /usr/bin/openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days ${BRIDGE_CERT_DAYS} \\
	-subj ${quote(`/CN=${viewer.backendName}`)} -addext ${quote(`subjectAltName=DNS:${viewer.backendName}`)} \\
	-addext extendedKeyUsage=serverAuth -addext basicConstraints=critical,CA:false \\
	-keyout ${quote(config.tls.key)} -out ${quote(config.tls.cert)}
`
		: "";
	return {
		"plan.sh": installer("plan"),
		"install.sh": installer("install"),
		"seal.sh": seal,
		"start.sh": installer("start"),
		"status.sh": installer("status"),
		...(viewer ? { "bridge-cert.sh": bridgeCert, "journal.sh": provision("journal"), "root-token.sh": provision("root-token"), "fetch.sh": renderFetch(config, viewer, pins), "support.sh": renderSupport(config, viewer) } : {}),
	};
}

// ---- The delivery and support scripts (viewer only) ----

/**
 * The Ubuntu packages the base must have: the desktop's (X, a window manager, a session bus), `openssl` and `curl` for the scripts,
 * and what Google's Chrome 156 package lists as its dependencies, by their Ubuntu 24.04 names (`t64` where that release renamed them).
 * `support.sh` checks each is installed.
 */
export const BASE_PACKAGES = [
	"xvfb", "openbox", "dbus-user-session", "x11-xserver-utils", "openssl", "curl", "ca-certificates", "wget", "xdg-utils",
	"fonts-liberation", "libasound2t64", "libatk-bridge2.0-0t64", "libatk1.0-0t64", "libatspi2.0-0t64", "libcairo2", "libcups2t64", "libcurl4t64",
	"libdbus-1-3", "libdrm2", "libexpat1", "libgbm1", "libglib2.0-0t64", "libgtk-3-0t64", "libnspr4", "libnss3", "libpango-1.0-0", "libudev1", "libvulkan1",
	"libx11-6", "libxcb-shm0", "libxcb-xfixes0", "libxcb1", "libxcomposite1", "libxdamage1", "libxext6", "libxfixes3", "libxkbcommon0", "libxrandr2", "libxtst6",
] as const;

/** Where Chrome's package puts its program, and so where `fetch.sh` does. */
const CHROME_DIR = "/opt/google/chrome";

/** Where `fetch.sh` stages everything. It must not exist: a second run, or a leftover, refuses. */
const FETCH_STAGE = "/var/lib/pim-cua-fetch";

/** What `fetch.sh` puts in place, as paths; none may be, or be inside, another. */
function fetchDestinations(config: Config, viewer: NonNullable<Config["viewer"]>): { nodeRoot: string; caddy: string; spacesd: string; chrome: string; bundle: string } {
	const nodeBin = path.posix.dirname(config.node.path);
	const nodeRoot = path.posix.dirname(nodeBin);
	if (path.posix.basename(config.node.path) !== "node" || path.posix.basename(nodeBin) !== "bin" || nodeRoot === "/") throw new Refusal("pin-layout");
	if (config.browser.path !== `${CHROME_DIR}/chrome`) throw new Refusal("pin-layout");
	const all = [nodeRoot, viewer.caddy.path, viewer.spacesd.path, CHROME_DIR, config.bundle.dir];
	for (const a of all) for (const b of all) if (a !== b && (a + "/").startsWith(`${b}/`)) throw new Refusal("pin-layout");
	if (new Set(all).size !== all.length) throw new Refusal("pin-layout");
	return { nodeRoot, caddy: viewer.caddy.path, spacesd: viewer.spacesd.path, chrome: CHROME_DIR, bundle: config.bundle.dir };
}

/** The render's checks of the pins against the configuration; it renders nothing from a pin set that is incomplete or is for something else. */
function checkPins(config: Config, viewer: NonNullable<Config["viewer"]>, pins: Pins): void {
	const missing = missingPins(pins);
	if (missing.length > 0) throw new Refusal(`pin-missing:${missing.join(",")}`);
	if (pins.repository.commit !== config.commit) throw new Refusal("pin-commit");
	if (pins.node.version !== config.node.version || pins.caddy.version !== viewer.caddy.version || pins.spacesd.version !== viewer.spacesd.version || pins.spacesd.sha256 !== viewer.spacesd.sha256) throw new Refusal("pin-mismatch");
	for (const sha of [pins.node.sha256, pins.caddy.sha256, pins.spacesd.sha256, pins.chrome.sha256, pins.repository.sha256!]) if (!/^[0-9a-f]{64}$/.test(sha)) throw new Refusal("pin-mismatch");
	for (const url of [pins.node.url, pins.caddy.url, pins.spacesd.url, pins.chrome.url, pins.ws.url, pins.protobuf.url]) if (!url.startsWith("https://")) throw new Refusal("pin-mismatch");
}

/**
 * `fetch.sh`: delivers the pinned programs and the commit's bundle, once, as root, with nothing from the cloud's user data and no
 * credential. Every artifact is fetched over HTTPS only (no downgrade, TLS 1.2 or later, no proxy, no configuration file, no retry),
 * must answer 200, must be within its size bound (and exactly its size where that is pinned), and must match its pinned digest
 * before one byte of it is unpacked. Everything is staged in a directory made here (new, root's, 0700) and removed on exit, the
 * original failure still reported; a destination that exists is never replaced, and a half-delivered VM is not resumed.
 */
function renderFetch(config: Config, viewer: NonNullable<Config["viewer"]>, pins: Pins): string {
	const dest = fetchDestinations(config, viewer);
	const repository = `https://codeload.github.com/ajac-zero/pim/tar.gz/${config.commit}`;
	const download = (name: string, file: string, url: string, algo: "256" | "512", hex: string, bytes: number | null, max: number) =>
		`download ${quote(name)} ${quote(file)} ${quote(url)} ${algo} ${quote(hex)} ${bytes === null ? "-" : bytes} ${max}\n`;
	const downloads = [
		download("node", "node.tar.gz", pins.node.url, "256", pins.node.sha256, null, pins.node.maxBytes),
		download("caddy", "caddy.tar.gz", pins.caddy.url, "256", pins.caddy.sha256, null, pins.caddy.maxBytes),
		download("spacesd", "spacesd", pins.spacesd.url, "256", pins.spacesd.sha256, pins.spacesd.bytes, pins.spacesd.maxBytes),
		download("chrome", "chrome.deb", pins.chrome.url, "256", pins.chrome.sha256, pins.chrome.bytes, pins.chrome.maxBytes),
		download("repository", "source.tar.gz", repository, "256", pins.repository.sha256!, null, pins.repository.maxBytes),
		download("ws", "ws.tgz", pins.ws.url, "512", integrityHex(pins.ws.sha512), null, pins.ws.maxBytes),
		download("protobuf", "protobuf.tgz", pins.protobuf.url, "512", integrityHex(pins.protobuf.sha512), null, pins.protobuf.maxBytes),
	].join("");
	const tools = ["curl", "tar", "dpkg-deb", "sha256sum", "sha512sum", "stat", "cut", "find", "chmod", "mkdir", "ln", "sort", "cmp", "readlink", "realpath", "tr", "rm", "install", "dirname"].map((tool) => `trusted_file /usr/bin/${tool} || fail tools`).join("\n");
	return `${prologue(config, "fetch", false)}
${tools}
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY no_proxy NO_PROXY CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR

readonly STAGE=${quote(FETCH_STAGE)}
readonly COMMIT=${quote(config.commit)}
readonly NODE_ROOT=${quote(dest.nodeRoot)}
readonly CADDY=${quote(dest.caddy)}
readonly SPACESD=${quote(dest.spacesd)}
readonly CHROME_DIR=${quote(dest.chrome)}
readonly CADDY_SHA256=${quote(viewer.caddy.sha256)}
readonly CHROME_SHA256=${quote(config.browser.sha256)}
readonly SPACESD_SHA256=${quote(pins.spacesd.sha256)}

# Only the stage this run made is removed, on any exit; a failed removal is reported without hiding why the run ended.
# Once placing has begun, a failed run keeps the stage and whatever was placed as evidence, and nothing resumes from it: the next run refuses on both.
CREATED=0
PLACING=0
cleanup() {
	local status="$1"
	if [[ "$PLACING" == 1 && "$status" != 0 ]]; then
		printf '{"event":"pim-cua-eval.failed","command":"%s","reason":"partial-placement-kept"}\\n' "$COMMAND" >&2
	elif [[ "$CREATED" == 1 ]]; then
		rm -rf --one-file-system -- "$STAGE" || { printf '{"event":"pim-cua-eval.failed","command":"%s","reason":"cleanup"}\\n' "$COMMAND" >&2; [[ "$status" != 0 ]] || status=1; }
	fi
	exit "$status"
}
trap 'cleanup $?' EXIT

sum256() { sha256sum <"$1" | cut -d' ' -f1; }
sum512() { sha512sum <"$1" | cut -d' ' -f1; }

# download NAME FILE URL ALGO HEX BYTES MAX: one fetch, no retry, into the stage; every check before the file is used.
download() {
	local name="$1" file="$STAGE/dl/$2" url="$3" algo="$4" hex="$5" bytes="$6" max="$7" status size sum
	status="$(curl -q --noproxy '*' --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 5 --fail --silent --show-error --location \\
		--retry 0 --connect-timeout 20 --max-time 900 --max-filesize "$max" --output "$file" --write-out '%{http_code}' -- "$url")" || fail "download-$name"
	[[ "$status" == 200 ]] || fail "status-$name"
	size="$(stat -c %s -- "$file")"
	(( size > 0 && size <= max )) || fail "size-$name"
	[[ "$bytes" == - || "$size" == "$bytes" ]] || fail "size-$name"
	sum="$("sum$algo" "$file")"
	[[ "$sum" == "$hex" ]] || fail "digest-$name"
}

absent() { [[ ! -e "$1" && ! -L "$1" ]] || fail "exists-$2"; }

# Publication never replaces. A file is published by a hard link, which the kernel refuses if the destination exists, however it appeared; a directory by an
# exclusive mkdir of its destination and then the same for each entry under it. Neither is a check followed by a rename, which would replace a file that appeared between the two.
# The link needs the stage and the destination on one filesystem, as the base has; across two it fails and nothing is copied.
publish_file() {
	ln -P -T -- "$1" "$2" || fail "place-$3"
}
# A tree's listing, written to a file of the stage by a pipeline whose failure is the function's: pipefail makes a failing find or sort fail the subshell,
# which a process substitution feeding a loop would never report. $2 is d (directories) or f (everything else); the file is bounded and, for f, not empty.
list_tree() {
	local size
	if [[ "$2" == d ]]; then
		( cd -- "$1" && find . -mindepth 1 -type d -printf '%P\\0' | LC_ALL=C sort -z >"$3" ) || return 1
	else
		( cd -- "$1" && find . -mindepth 1 ! -type d -printf '%P\\0' | LC_ALL=C sort -z >"$3" ) || return 1
	fi
	size="$(stat -c %s -- "$3")" || return 1
	(( size <= 16777216 )) || return 1
	[[ "$2" == d || "$size" -gt 0 ]]
}

# The listings of a staged tree, made and checked before anything is placed: every name is plain.
prepare_tree() {
	local kind name
	list_tree "$1" d "$STAGE/m/$2.dirs" || fail "manifest-$2"
	list_tree "$1" f "$STAGE/m/$2.files" || fail "manifest-$2"
	for kind in dirs files; do
		while IFS= read -r -d '' name; do
			[[ "$name" =~ ^[A-Za-z0-9._@+-]+(/[A-Za-z0-9._@+-]+)*$ ]] || fail_path "manifest-$2" "$name"
		done <"$STAGE/m/$2.$kind" || fail "manifest-$2"
	done
}

publish_tree() {
	local entry
	mkdir -m 0755 -- "$2" || fail "place-$3"
	while IFS= read -r -d '' entry; do
		mkdir -m "$(stat -c %a -- "$1/$entry")" -- "$2/$entry" || fail "place-$3"
	done <"$STAGE/m/$3.dirs" || fail "place-$3"
	while IFS= read -r -d '' entry; do
		ln -P -T -- "$1/$entry" "$2/$entry" || fail "place-$3"
	done <"$STAGE/m/$3.files" || fail "place-$3"
	# Every listed entry is there and nothing else is: the destination's own listing is the stage's, byte for byte.
	list_tree "$2" d "$STAGE/m/$3.placed.dirs" && list_tree "$2" f "$STAGE/m/$3.placed.files" || fail "placed-$3"
	cmp -s -- "$STAGE/m/$3.dirs" "$STAGE/m/$3.placed.dirs" && cmp -s -- "$STAGE/m/$3.files" "$STAGE/m/$3.placed.files" || fail "placed-$3"
}

# Every directory above $1 exists, made here when missing (root's, 0755), and is root's, not a link, and writable by no one else.
ensure_parent() {
	local dir current="" part
	local -a parts
	dir="$(dirname -- "$1")"
	IFS=/ read -r -a parts <<<"\${dir#/}"
	for part in "\${parts[@]}"; do
		[[ -n "$part" && "$part" != . && "$part" != .. ]] || fail dest-path
		current="$current/$part"
		if [[ ! -e "$current" && ! -L "$current" ]]; then mkdir -m 0755 -- "$current" || fail dest-parent; fi
	done
	trusted_dirs "$dir" || fail dest-parent
}

# A failure that names the entry. The name is under the stage, so it holds no secret; any character outside letters, digits and ._/@+- is shown as a question mark, and it is cut at 200.
fail_path() {
	local shown
	shown="$(printf '%s' "$2" | tr -c 'A-Za-z0-9._/@+-' '?')" || shown="?"
	printf '{"event":"pim-cua-eval.failed","command":"%s","reason":"%s","path":"%s"}\\n' "$COMMAND" "$1" "\${shown:0:200}" >&2
	exit 1
}

# A staged tree is all root's. Its regular files and directories have no write for group or others and no setuid or setgid.
# Its symbolic links are the one thing whose own mode means nothing (Linux gives every link 0777), so they are judged by where they point instead: a relative target,
# which both lexically and as the filesystem really resolves it stays inside the same tree. A link out of the tree, an absolute one or a dangling one fails.
# Each failure names the entry. The list of links is a file of the stage, so a failing find is seen.
staged_ok() {
	local root real entry target
	for root in "$@"; do
		entry="$(find "$root" ! -uid 0 -print -quit)" || fail stage-ownership
		[[ -z "$entry" ]] || fail_path stage-ownership "$entry"
		entry="$(find "$root" ! -type l \\( -perm /022 -o -perm /6000 \\) -print -quit)" || fail stage-mode
		[[ -z "$entry" ]] || fail_path stage-mode "$entry"
		real="$(realpath -e -- "$root")" || fail_path stage-link "$root"
		find "$root" -type l -print0 >"$STAGE/m/links" || fail stage-link
		while IFS= read -r -d '' entry; do
			target="$(readlink -- "$entry")" || fail_path stage-link "$entry"
			[[ -n "$target" && "$target" != /* ]] || fail_path stage-link "$entry"
			[[ "$(realpath -m -s -- "$(dirname -- "$entry")/$target")" == "$root"/* ]] || fail_path stage-link "$entry"
			[[ "$(realpath -e -- "$entry")" == "$real"/* ]] || fail_path stage-link "$entry"
		done <"$STAGE/m/links" || fail stage-link
	done
}

# Nothing is replaced, and nothing is begun if anything is already there.
absent "$NODE_ROOT" node
absent "$CADDY" caddy
absent "$SPACESD" spacesd
absent "$CHROME_DIR" chrome
absent "$BUNDLE" bundle
trusted_dirs /var/lib || fail stage-parent
mkdir -m 0700 -- "$STAGE" || fail stage-exists
CREATED=1
mkdir -m 0700 -- "$STAGE/m" "$STAGE/dl" "$STAGE/node" "$STAGE/caddy" "$STAGE/chrome" "$STAGE/src" "$STAGE/spacesd"

${downloads}
# Unpacked only now: each archive matched its pin, as root, without restoring any owner.
tar --extract --gzip --file "$STAGE/dl/node.tar.gz" --directory "$STAGE/node" --strip-components=1 --no-same-owner --same-permissions || fail unpack-node
tar --extract --gzip --file "$STAGE/dl/caddy.tar.gz" --directory "$STAGE/caddy" --no-same-owner --same-permissions caddy || fail unpack-caddy
tar --extract --gzip --file "$STAGE/dl/source.tar.gz" --directory "$STAGE/src" --strip-components=1 --no-same-owner || fail unpack-repository
dpkg-deb --extract "$STAGE/dl/chrome.deb" "$STAGE/chrome" || fail unpack-chrome
install -m 0755 -o root -g root -- "$STAGE/dl/spacesd" "$STAGE/spacesd/spacesd" || fail unpack-spacesd
# Chrome runs as the desktop account with its own sandbox on: the package's setuid helper is not kept, and the user-namespace sandbox is what the support check proves.
[[ -f "$STAGE/chrome$CHROME_DIR/chrome" && -f "$STAGE/chrome$CHROME_DIR/chrome-sandbox" ]] || fail unpack-chrome
chmod 0755 -- "$STAGE/chrome$CHROME_DIR/chrome-sandbox" || fail unpack-chrome
staged_ok "$STAGE/node" "$STAGE/caddy" "$STAGE/chrome$CHROME_DIR" "$STAGE/spacesd"

# The programs themselves match the digests the configuration records.
[[ -f "$STAGE/node/bin/node" && "$(sum256 "$STAGE/node/bin/node")" == "$NODE_SHA256" ]] || fail digest-node-program
[[ -f "$STAGE/caddy/caddy" && "$(sum256 "$STAGE/caddy/caddy")" == "$CADDY_SHA256" ]] || fail digest-caddy-program
[[ "$(sum256 "$STAGE/chrome$CHROME_DIR/chrome")" == "$CHROME_SHA256" ]] || fail digest-chrome-program
[[ "$(sum256 "$STAGE/spacesd/spacesd")" == "$SPACESD_SHA256" ]] || fail digest-spacesd-program

# The bundle is built from the pinned archive by the archive's own program, with the staged Node and the two pinned packages, and must come to the configured tree digest.
"$STAGE/node/bin/node" "$STAGE/src/computer/cua-host/eval-install/operator.ts" bundle --commit "$COMMIT" --source-dir "$STAGE/src" \\
	--ws-tarball "$STAGE/dl/ws.tgz" --protobuf-tarball "$STAGE/dl/protobuf.tgz" --out "$STAGE/bundle" >/dev/null || fail bundle-build
digest="$(tree_digest "$STAGE/bundle")" || fail bundle-digest
[[ "$digest" == "$BUNDLE_SHA256" ]] || fail bundle-digest
staged_ok "$STAGE/bundle"

# In place, none replacing (publish_file, publish_tree), each tree then compared whole against its listing. A failure partway keeps the stage and what was placed; that VM is discarded, never resumed.
# Every listing is made and checked here, before the first thing is placed.
prepare_tree "$STAGE/node" node
prepare_tree "$STAGE/chrome$CHROME_DIR" chrome
prepare_tree "$STAGE/bundle" bundle
ensure_parent "$NODE_ROOT"; ensure_parent "$CADDY"; ensure_parent "$SPACESD"; ensure_parent "$CHROME_DIR"; ensure_parent "$BUNDLE"
PLACING=1
publish_tree "$STAGE/node" "$NODE_ROOT" node
publish_file "$STAGE/caddy/caddy" "$CADDY" caddy
publish_file "$STAGE/spacesd/spacesd" "$SPACESD" spacesd
publish_tree "$STAGE/chrome$CHROME_DIR" "$CHROME_DIR" chrome
publish_tree "$STAGE/bundle" "$BUNDLE" bundle
# The programs are the ones checked, and (above) every tree's placed listing equals its staged one.
[[ "$(sum256 "$NODE_ROOT/bin/node")" == "$NODE_SHA256" && "$(sum256 "$CADDY")" == "$CADDY_SHA256" && "$(sum256 "$SPACESD")" == "$SPACESD_SHA256" && "$(sum256 "$CHROME_DIR/chrome")" == "$CHROME_SHA256" ]] || fail placed-programs
[[ "$(tree_digest "$BUNDLE")" == "$BUNDLE_SHA256" ]] || fail placed-bundle
PLACING=0
printf '{"event":"pim-cua-eval.fetched","evaluation":"%s"}\\n' ${quote(config.evaluation)}
`;
}

/**
 * `support.sh`: the checks a startup needs to pass before `start`, run as root after `install`: every package of the base is installed,
 * every delivered program resolves its shared libraries, Node and Caddy are the pinned versions, Caddy accepts its configuration
 * (`caddy validate`, as the ingress account with its own state directory), headless Chrome starts as the desktop account with its own
 * sandbox on, and spacesd answers `--help` as that account. It starts no service and opens no port, but it is not data inspection:
 * `ldd` runs the dynamic loader in each program's context and the other checks run the delivered programs. It prints one line per
 * check and exits nonzero if any failed.
 */
function renderSupport(config: Config, viewer: NonNullable<Config["viewer"]>): string {
	const packages = BASE_PACKAGES.map((name) => quote(name)).join(" ");
	const runuser = `${TOOLS.runuser} -u`;
	// One environment for every Caddy command, the ingress unit's own: Caddy warns on stderr when it has neither HOME nor XDG_CONFIG_HOME, and that warning would sit in front of the version.
	const caddyEnv = `env -i PATH=/usr/bin:/bin XDG_DATA_HOME=${VIEWER_PATHS.ingressState} XDG_CONFIG_HOME=${VIEWER_PATHS.ingressState}`;
	return `${prologue(config, "support")}
trusted_file ${TOOLS.runuser} || fail tools
for tool in dpkg-query ldd timeout mktemp chown grep rm basename; do trusted_file "/usr/bin/$tool" || fail tools; done
readonly CADDY=${quote(viewer.caddy.path)}
readonly SPACESD=${quote(viewer.spacesd.path)}
readonly BROWSER=${quote(config.browser.path)}
readonly NODE_VERSION=${quote(config.node.version)}
readonly CADDY_VERSION=${quote(viewer.caddy.version)}

# Fail fast: the first check that fails ends the run, with nothing after it run. bad is only called from this shell, never from a subshell, so its exit is the script's.
ok() { printf '{"event":"pim-cua-eval.support","check":"%s","result":"ok"}\\n' "$1"; }
bad() { printf '{"event":"pim-cua-eval.support","check":"%s","result":"fail"}\\n' "$1" >&2; exit 1; }

# The profile directory Chrome gets is removed on any exit; a failed removal is reported next to the failure that ended the run, never in place of it.
TEMP=""
cleanup() {
	local status="$1"
	if [[ -n "$TEMP" ]]; then
		rm -rf --one-file-system -- "$TEMP" || { printf '{"event":"pim-cua-eval.support","check":"cleanup","result":"fail"}\\n' >&2; [[ "$status" != 0 ]] || status=1; }
	fi
	exit "$status"
}
trap 'cleanup $?' EXIT

# Every program that runs is bounded: a check that doesn't end in its limit is killed and fails. (An absent timeout, a program that ignores TERM: KILL follows 5 seconds later.)
# step NAME SECONDS COMMAND...: one bounded command, output discarded.
step() {
	local name="$1" limit="$2"
	shift 2
	if timeout --kill-after=5 "$limit" "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}
# capture SECONDS COMMAND...: one bounded command whose output (stdout and stderr) is left in $OUT; its failure, including the time limit, is the function's.
capture() {
	local limit="$1"
	shift
	OUT="$(timeout --kill-after=5 "$limit" "$@" 2>&1)"
}

for package in ${packages}; do
	if [[ "$(dpkg-query -W -f='\${db:Status-Status}' -- "$package" 2>/dev/null)" == installed ]]; then ok "package-$package"; else bad "package-$package"; fi
done

# Shared libraries. A program that ldd can't read, or can't run the loader for, fails; "not found" in a successful listing fails. The one thing taken as no missing library is Caddy's
# own static build (Go, no cgo), whose ldd output is exactly "not a dynamic executable" with status 1; Node, spacesd and Chrome are dynamic and have no such exemption.
libraries() {
	local program="$1" name="libraries-$(basename -- "$1")" status=0 static='^[[:space:]]*not a dynamic executable[[:space:]]*$'
	LD_LIBRARY_PATH= capture 20 ldd -- "$program" || status=$?
	if [[ "$status" == 0 ]]; then
		if grep -q 'not found' <<<"$OUT"; then bad "$name"; fi
	elif [[ "$program" == "$CADDY" && "$status" == 1 && "$OUT" =~ $static ]]; then
		:
	else
		bad "$name"
	fi
	ok "$name"
}
libraries "$NODE"
libraries "$CADDY"
libraries "$SPACESD"
libraries "$BROWSER"

capture 20 "$NODE" --version || bad node-version
[[ "$OUT" == "$NODE_VERSION" ]] && ok node-version || bad node-version
capture 20 ${runuser} ${VIEWER_ACCOUNTS.ingress} -- ${caddyEnv} "$CADDY" version || bad caddy-version
[[ "$OUT" == "$CADDY_VERSION "* ]] && ok caddy-version || bad caddy-version

# Caddy parses and provisions the installed Caddyfile as its own account, as the unit does; nothing is started, no certificate is asked for.
step caddy-validate 30 ${runuser} ${VIEWER_ACCOUNTS.ingress} -- ${caddyEnv} "$CADDY" validate --config ${VIEWER_PATHS.caddyfile} --adapter caddyfile

# spacesd runs, as the desktop account, as far as printing its help.
step spacesd-runs 20 ${runuser} ${ACCOUNTS.desktop} -- env -i PATH=/usr/bin:/bin "$SPACESD" --help

# Chrome with its own sandbox left on, as the desktop account, headless, with a profile directory made here and removed on exit.
TEMP="$(mktemp -d)" || bad chrome-profile
chown ${ACCOUNTS.desktop}: -- "$TEMP" || bad chrome-profile
capture 60 ${runuser} ${ACCOUNTS.desktop} -- env -i PATH=/usr/bin:/bin HOME="$TEMP" "$BROWSER" --headless=new --disable-gpu --user-data-dir="$TEMP/profile" --dump-dom about:blank || bad chrome-headless-sandboxed
grep -q '<html' <<<"$OUT" && ok chrome-headless-sandboxed || bad chrome-headless-sandboxed
`;
}

/** The desktop account's UID in the base: above a cloud's own admin user's (1000), and inside what the installer takes (1000 to 59999). */
export const BASE_DESKTOP_UID = 1500;

/**
 * The ordinary desktop base (docs/cua-viewer-first-startup.md, "The base"), as cloud-init user data for the VM's
 * creation: the desktop account (no group but its own, no sudo, no password), the packages an X11 desktop and
 * Chrome and spacesd need, lingering so the account has its runtime directory and session bus, and two system
 * services that run as that account: Xvfb on the configured display, then a window manager. It installs none of
 * the pinned programs (Node, Chrome, Caddy, spacesd, the bundle): those are delivered root-owned with their
 * digests, and the installer refuses a VM without them. The packages come from the Ubuntu archive at first boot,
 * by name, not pinned by version; nothing here has been checked against the image.
 */
export function renderBaseCloudConfig(config: Config): string {
	if (!config.viewer || config.desktop.display === null) throw new Refusal("config-viewer");
	const uid = BASE_DESKTOP_UID;
	const display = config.desktop.display;
	const env = [`Environment=DISPLAY=${display}`, `Environment=XDG_RUNTIME_DIR=/run/user/${uid}`, `Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`];
	const unit = (description: string, after: string, exec: string) =>
		["[Unit]", `Description=${description}`, `After=${after}`, `Requires=${after}`, "", "[Service]", "Type=simple", `User=${ACCOUNTS.desktop}`, `Group=${ACCOUNTS.desktop}`, ...env, `ExecStart=${exec}`, "Restart=no", "", "[Install]", "WantedBy=multi-user.target", ""].join("\n");
	const xvfb = unit("Pim Cua evaluation X11 display", `user@${uid}.service`, `/usr/bin/Xvfb ${display} -screen 0 1920x1080x24 -nolisten tcp`);
	const wm = unit("Pim Cua evaluation window manager", "pim-cua-xvfb.service", "/usr/bin/openbox");
	const data = {
		package_update: true,
		package_upgrade: false,
		disable_root: true,
		ssh_pwauth: false,
		users: ["default", { name: ACCOUNTS.desktop, uid, homedir: `/home/${ACCOUNTS.desktop}`, shell: "/bin/bash", lock_passwd: true, sudo: false }],
		packages: [...BASE_PACKAGES],
		write_files: [
			{ path: "/etc/systemd/system/pim-cua-xvfb.service", owner: "root:root", permissions: "0644", content: xvfb },
			{ path: "/etc/systemd/system/pim-cua-wm.service", owner: "root:root", permissions: "0644", content: wm },
		],
		runcmd: [["loginctl", "enable-linger", ACCOUNTS.desktop], ["systemctl", "daemon-reload"], ["systemctl", "enable", "--now", "pim-cua-xvfb.service", "pim-cua-wm.service"]],
	};
	return `#cloud-config\n${JSON.stringify(data, null, 2)}\n`;
}

/**
 * A cloud-init user-data that only places the scripts on the VM, as
 * `/usr/local/sbin/pim-cua-eval-<name>` (root's, 0700), and runs none of
 * them. JSON is YAML, so it is written as JSON after the header.
 */
export function renderCloudConfig(scripts: Record<string, string>): string {
	const files = Object.entries(scripts).map(([name, content]) => ({ path: `/usr/local/sbin/pim-cua-eval-${name.replace(/\.sh$/, "")}`, owner: "root:root", permissions: "0700", content }));
	return `#cloud-config\n${JSON.stringify({ write_files: files }, null, 2)}\n`;
}

// ---- The program ----

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));

function git(args: string[]): Buffer {
	return execFileSync("git", ["-C", REPOSITORY, ...args], { maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** A regular file of a source directory (an unpacked archive of the commit), never a link or anything else. */
function readRegular(dir: string, file: string): Buffer {
	const target = path.join(dir, file);
	const stat = fs.lstatSync(target);
	if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Refusal("source");
	return fs.readFileSync(target);
}

/**
 * What a bundle is built from, read through `read` (a commit's git objects, or a source directory): the base's sources,
 * the viewer's too when there is one, the version `ws` and the viewer's package are locked at, and each one's integrity.
 */
export function bundleInputs(read: (file: string) => Buffer, withViewer: boolean): { sources: Map<string, Buffer>; wsVersion: string; wsIntegrity: string; protobuf?: { version: string; integrity: string } } {
	const get = (file: string): Buffer => {
		try {
			return read(file);
		} catch {
			throw new Refusal("source");
		}
	};
	const sources = new Map<string, Buffer>();
	for (const source of BUNDLE_SOURCES) sources.set(source, get(source));
	const hostPackage = JSON.parse(sources.get("computer/cua-host/package.json")!.toString("utf8")) as { dependencies?: Record<string, string> };
	const wsVersion = hostPackage.dependencies?.ws;
	if (typeof wsVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(wsVersion)) throw new Refusal("ws-version");
	const lockfile = get("pnpm-lock.yaml").toString("utf8");
	const wsIntegrity = lockedIntegrity(lockfile, wsVersion);
	if (!withViewer) return { sources, wsVersion, wsIntegrity };
	for (const source of VIEWER_SOURCES) sources.set(source, get(source));
	const version = hostPackage.dependencies?.["@bufbuild/protobuf"];
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Refusal("protobuf-version");
	return { sources, wsVersion, wsIntegrity, protobuf: { version, integrity: lockedPackageIntegrity(lockfile, "@bufbuild/protobuf", version) } };
}

function bundle(commit: string, wsTarball: string, out: string, protobufTarball?: string, sourceDir?: string): string {
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Refusal("commit");
	let read: (file: string) => Buffer;
	if (sourceDir === undefined) {
		let resolved: string;
		try {
			resolved = git(["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`]).toString("utf8").trim();
		} catch {
			throw new Refusal("commit");
		}
		if (resolved !== commit) throw new Refusal("commit");
		read = (file) => git(["show", `${commit}:${file}`]);
	} else {
		// On the VM, with no git: the pinned archive of the commit, unpacked. Its digest was checked before it was unpacked, and the bundle's own digest is checked after.
		if (!isPlainPath(sourceDir)) throw new Refusal("source-dir");
		read = (file) => readRegular(sourceDir, file);
	}
	const inputs = bundleInputs(read, protobufTarball !== undefined);
	if (!isPlainPath(wsTarball)) throw new Refusal("ws-tarball");
	const tarball = fs.readFileSync(wsTarball);
	let viewer: ViewerBundle | undefined;
	if (protobufTarball !== undefined) {
		if (!isPlainPath(protobufTarball)) throw new Refusal("protobuf-tarball");
		viewer = { protobufVersion: inputs.protobuf!.version, protobufIntegrity: inputs.protobuf!.integrity, protobufTarball: fs.readFileSync(protobufTarball) };
	}
	const entries = bundleEntries({ commit, sources: inputs.sources, wsVersion: inputs.wsVersion, wsIntegrity: inputs.wsIntegrity, wsTarball: tarball, ...(viewer ? { viewer } : {}) });
	// The assembled bundle must be able to load everything its programs import: a defective one is refused here, before it is written, not found on a VM.
	const unresolved = unresolvedImports(entries, viewer !== undefined);
	if (unresolved.length > 0) throw new Refusal(`bundle-closure:${unresolved[0]}`);
	writeTree(out, entries);
	return treeDigest(out);
}

function render(configFile: string, out: string): string[] {
	const stat = fs.statSync(configFile);
	if (!stat.isFile() || stat.size > 64 * 1024) throw new Refusal("config");
	const config = parseConfig(fs.readFileSync(configFile, "utf8"));
	const scripts = renderScripts(config);
	const files = { ...scripts, "cloud-config.yaml": renderCloudConfig(scripts), ...(config.viewer ? { "base-cloud-config.yaml": renderBaseCloudConfig(config) } : {}) };
	writePrivate(out, new Map(Object.entries(files).map(([name, content]) => [name, Buffer.from(content)])));
	return Object.keys(files);
}

const USAGE = `The operator's side of a Cua evaluation VM's installation. See docs/cua-eval-install.md.

  node operator.ts bundle --commit <sha> --ws-tarball <file> --out <new directory> [--protobuf-tarball <file>] [--source-dir <directory>]
  node operator.ts digest --dir <directory>
  node operator.ts render --config <file> --out <new directory>`;

const COMMANDS = { bundle: ["commit", "ws-tarball", "out"], digest: ["dir"], render: ["config", "out"] } as const;
/** Options a command may also take; `--protobuf-tarball` makes the bundle carry the viewer, and `--source-dir` reads the sources from an unpacked archive instead of git. */
const OPTIONAL: Record<string, readonly string[]> = { bundle: ["protobuf-tarball", "source-dir"] };

function main(argv: string[]): void {
	const command = argv[0] as keyof typeof COMMANDS;
	const names: readonly string[] | undefined = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
	let values: Record<string, string> = {};
	try {
		if (!names) throw new Error();
		values = parseArgs({ args: argv.slice(1), options: Object.fromEntries([...names, ...(OPTIONAL[command] ?? [])].map((name) => [name, { type: "string" as const }])), strict: true, allowPositionals: false }).values as Record<string, string>;
		if (names.some((name) => !values[name])) throw new Error();
	} catch {
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}
	try {
		if (command === "bundle") {
			const sha256 = bundle(values.commit!, values["ws-tarball"]!, values.out!, values["protobuf-tarball"], values["source-dir"]);
			process.stdout.write(`${JSON.stringify({ event: "pim-cua-eval.bundled", commit: values.commit, sha256 })}\n`);
		} else if (command === "digest") {
			process.stdout.write(`${JSON.stringify({ event: "pim-cua-eval.digest", sha256: treeDigest(values.dir!) })}\n`);
		} else {
			process.stdout.write(`${JSON.stringify({ event: "pim-cua-eval.rendered", files: render(values.config!, values.out!) })}\n`);
		}
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ event: "pim-cua-eval.failed", command, reason: error instanceof Refusal ? error.reason : "internal" })}\n`);
		process.exit(1);
	}
}

// Run as a program, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2));
