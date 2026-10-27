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
import { ACCOUNTS, BUNDLE_FILES, BUNDLE_FORMAT, type Config, isPlainPath, PATHS, parseConfig, Refusal, TOOLS, VIEWER_ASSET_DIR, VIEWER_ASSET_NAMES, VIEWER_ASSET_SHA256, VIEWER_BUNDLE_FILES, viewerBundleFiles } from "./config.ts";

/** The repository's files a bundle holds, as they are at its commit. */
export const BUNDLE_SOURCES = [
	"package.json",
	"computer/pim-computer.ts",
	"computer/cua-bridge.ts",
	"computer/cua-host/package.json",
	"computer/cua-host/bridge.ts",
	"computer/cua-host/desktop.ts",
	"computer/cua-host/session.ts",
	"computer/cua-host/host.ts",
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

function prologue(config: Config, command: string): string {
	return `#!/bin/bash
# Pim Cua evaluation: ${command} (docs/cua-eval-install.md), for evaluation ${config.evaluation}.
# Rendered by computer/cua-host/eval-install/operator.ts. It holds no secret and prints none.
# Before running anything from them, it checks the pinned Node and the bundle's tree digest.
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
trusted_file "$NODE" || fail node-path
[[ "$(sha256sum <"$NODE" | cut -d' ' -f1)" == "$NODE_SHA256" ]] || fail node-digest
trusted_dirs "$BUNDLE" || fail bundle-path
# Everything in the bundle is root's, a regular file or a directory, with no write for others and no special bits.
unexpected="$(find "$BUNDLE" \\( ! -uid 0 -o -perm /022 -o -perm /7000 -o \\( ! -type f ! -type d \\) \\) -print -quit)" || fail bundle-ownership
[[ -z "$unexpected" ]] || fail bundle-ownership
digest="$(tree_digest "$BUNDLE")" || fail bundle-digest
[[ "$digest" == "$BUNDLE_SHA256" ]] || fail bundle-digest
`;
}

/**
 * The management scripts, by file name. `plan`, `install`, `start` and
 * `status` run the installer as root with the configuration on standard
 * input, from a quoted here-document (nothing in it is expanded). `seal`
 * runs eval-credentials.ts's `seal` once, as the bridge's account, with
 * fixed arguments; its standard output is the envelope and nothing else.
 */
export function renderScripts(config: Config): Record<string, string> {
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
	// Only with a viewer: makes its journal once, as root, from the bundle's own copy of the program (docs/cua-viewer-first-startup.md).
	const journal = `${prologue(config, "journal")}
exec "$NODE" "$BUNDLE/${VIEWER_BUNDLE_FILES.provision}" <<'${HEREDOC}'
${json}
${HEREDOC}
`;
	return {
		"plan.sh": installer("plan"),
		"install.sh": installer("install"),
		"seal.sh": seal,
		"start.sh": installer("start"),
		"status.sh": installer("status"),
		...(config.viewer ? { "journal.sh": journal } : {}),
	};
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

function bundle(commit: string, wsTarball: string, out: string, protobufTarball?: string): string {
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Refusal("commit");
	let resolved: string;
	try {
		resolved = git(["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`]).toString("utf8").trim();
	} catch {
		throw new Refusal("commit");
	}
	if (resolved !== commit) throw new Refusal("commit");
	const sources = new Map<string, Buffer>();
	for (const source of BUNDLE_SOURCES) {
		try {
			sources.set(source, git(["show", `${commit}:${source}`]));
		} catch {
			throw new Refusal("source");
		}
	}
	const hostPackage = JSON.parse(sources.get("computer/cua-host/package.json")!.toString("utf8")) as { dependencies?: Record<string, string> };
	const wsVersion = hostPackage.dependencies?.ws;
	if (typeof wsVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(wsVersion)) throw new Refusal("ws-version");
	const wsIntegrity = lockedIntegrity(git(["show", `${commit}:pnpm-lock.yaml`]).toString("utf8"), wsVersion);
	if (!isPlainPath(wsTarball)) throw new Refusal("ws-tarball");
	const tarball = fs.readFileSync(wsTarball);
	let viewer: ViewerBundle | undefined;
	if (protobufTarball !== undefined) {
		// The viewer's files are read from the commit's objects too, and its one package is locked like `ws`.
		for (const source of VIEWER_SOURCES) {
			try {
				sources.set(source, git(["show", `${commit}:${source}`]));
			} catch {
				throw new Refusal("source");
			}
		}
		const protobufVersion = hostPackage.dependencies?.["@bufbuild/protobuf"];
		if (typeof protobufVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(protobufVersion)) throw new Refusal("protobuf-version");
		const protobufIntegrity = lockedPackageIntegrity(git(["show", `${commit}:pnpm-lock.yaml`]).toString("utf8"), "@bufbuild/protobuf", protobufVersion);
		if (!isPlainPath(protobufTarball)) throw new Refusal("protobuf-tarball");
		viewer = { protobufVersion, protobufIntegrity, protobufTarball: fs.readFileSync(protobufTarball) };
	}
	writeTree(out, bundleEntries({ commit, sources, wsVersion, wsIntegrity, wsTarball: tarball, ...(viewer ? { viewer } : {}) }));
	return treeDigest(out);
}

function render(configFile: string, out: string): string[] {
	const stat = fs.statSync(configFile);
	if (!stat.isFile() || stat.size > 64 * 1024) throw new Refusal("config");
	const config = parseConfig(fs.readFileSync(configFile, "utf8"));
	const scripts = renderScripts(config);
	const files = { ...scripts, "cloud-config.yaml": renderCloudConfig(scripts) };
	writePrivate(out, new Map(Object.entries(files).map(([name, content]) => [name, Buffer.from(content)])));
	return Object.keys(files);
}

const USAGE = `The operator's side of a Cua evaluation VM's installation. See docs/cua-eval-install.md.

  node operator.ts bundle --commit <sha> --ws-tarball <file> --out <new directory> [--protobuf-tarball <file>]
  node operator.ts digest --dir <directory>
  node operator.ts render --config <file> --out <new directory>`;

const COMMANDS = { bundle: ["commit", "ws-tarball", "out"], digest: ["dir"], render: ["config", "out"] } as const;
/** Options a command may also take; `--protobuf-tarball` makes the bundle carry the viewer. */
const OPTIONAL: Record<string, readonly string[]> = { bundle: ["protobuf-tarball"] };

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
			const sha256 = bundle(values.commit!, values["ws-tarball"]!, values.out!, values["protobuf-tarball"]);
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
