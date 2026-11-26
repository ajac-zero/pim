/**
 * Web releases: the web app (`web/dist`) published into a directory the Gate reads on every request, so the interface can change without
 * replacing or restarting the Gate, Live, the Runner or any other process.
 *
 *   <root>/releases/<id>/   one complete build, named by a hash of its files (so publishing the same build twice is one release)
 *   <root>/current          a symbolic link to the release being served
 *   <root>/previous         a symbolic link to the release served before it, which `rollback` returns to
 *
 * `activate` and `rollback` replace the `current` link with one rename, so a request sees the old release or the new one, never neither.
 * A built file is named by its content, so the same name in any release is the same bytes: the Gate serves a missing `/assets/` file from
 * the other releases still on disk, which keeps a tab opened before a release working until it reloads (`web-assets.ts`). `prune` is the
 * only thing that deletes a release, and keeps the current and previous ones, the newest few, and every one used recently.
 *
 * Command line (see docs/v2-operations.md, "Releasing the web app on its own"):
 *   node --import tsx src/web-release.ts publish <dist> <root> [--activate]
 *   node --import tsx src/web-release.ts activate <id> <root>
 *   node --import tsx src/web-release.ts rollback <root>
 *   node --import tsx src/web-release.ts clear <root>
 *   node --import tsx src/web-release.ts list <root>
 *   node --import tsx src/web-release.ts prune <root> [--keep 5] [--min-age-days 7]
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** What is known of a release: its hash, and what the build said of itself (`release.json`). */
export type WebRelease = { id: string; version?: string; revision?: string; builtAt?: string; publishedAt: string; files: number; bytes: number };

const releasesDir = (root: string) => join(root, "releases");

function filesOf(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((file) => file !== "release.json" && file !== ".activated" && statSync(join(dir, file)).isFile())
		.sort();
}

/** A hash of every file's path and bytes: the same build always has the same id, and any changed file changes it. */
export function releaseId(dir: string): string {
	const hash = createHash("sha256");
	for (const file of filesOf(dir)) hash.update(file).update("\0").update(readFileSync(join(dir, file))).update("\0");
	return hash.digest("hex").slice(0, 16);
}

export function readRelease(dir: string): WebRelease | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as WebRelease;
	} catch {
		return undefined;
	}
}

/** Where the link `name` points, as a release id; undefined when there is no link or it points at nothing. */
export function linked(root: string, name: "current" | "previous"): string | undefined {
	try {
		const id = basename(readlinkSync(join(root, name)));
		return existsSync(join(releasesDir(root), id, "index.html")) ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Every release on disk, the one most recently activated (or published) first. */
export function listReleases(root: string): (WebRelease & { current: boolean; previous: boolean; usedAt: number })[] {
	if (!existsSync(releasesDir(root))) return [];
	const current = linked(root, "current");
	const previous = linked(root, "previous");
	return readdirSync(releasesDir(root), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && ID.test(entry.name) && existsSync(join(releasesDir(root), entry.name, "index.html")) && existsSync(join(releasesDir(root), entry.name, "release.json")))
		.map((entry) => {
			const dir = join(releasesDir(root), entry.name);
			const info = readRelease(dir) ?? { id: entry.name, publishedAt: "", files: 0, bytes: 0 };
			// A release's mark is touched when it is activated; before that, when it was published.
			const marked = join(dir, ".activated");
			return { ...info, id: entry.name, current: entry.name === current, previous: entry.name === previous, usedAt: statSync(existsSync(marked) ? marked : join(dir, "release.json")).mtimeMs };
		})
		.sort((a, b) => b.usedAt - a.usedAt);
}

/** Copies a build into `<root>/releases/<id>`, whole or not at all; the same build again changes nothing. */
export function publish(dist: string, root: string, now = new Date()): WebRelease {
	if (!existsSync(join(dist, "index.html"))) throw new Error(`${dist} is not a web build: it has no index.html`);
	const id = releaseId(dist);
	const target = join(releasesDir(root), id);
	const existing = existsSync(join(target, "index.html")) ? readRelease(target) : undefined;
	if (existing) return existing;
	mkdirSync(releasesDir(root), { recursive: true });
	const staging = join(releasesDir(root), `.staging-${id}-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	cpSync(dist, staging, { recursive: true, dereference: true });
	const built = readRelease(staging);
	const files = filesOf(staging);
	const release: WebRelease = {
		id,
		...(built?.version ? { version: built.version } : {}),
		...(built?.revision ? { revision: built.revision } : {}),
		...(built?.builtAt ? { builtAt: built.builtAt } : {}),
		publishedAt: now.toISOString(),
		files: files.length,
		bytes: files.reduce((sum, file) => sum + statSync(join(staging, file)).size, 0),
	};
	writeFileSync(join(staging, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
	// A release is used from when it was published until it is activated.
	utimesSync(join(staging, "release.json"), now, now);
	try {
		renameSync(staging, target);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		// Published by someone else at the same moment: it is the same build.
		if (!existsSync(join(target, "index.html"))) throw error;
	}
	return readRelease(target) ?? release;
}

/** Points `name` at a release with one rename, so no request sees it missing. */
function point(root: string, name: "current" | "previous", id: string): void {
	const temporary = join(root, `.${name}-${process.pid}`);
	rmSync(temporary, { force: true });
	symlinkSync(join("releases", id), temporary);
	renameSync(temporary, join(root, name));
}

/** Serves `id` from the next request on; the release served until now is kept as `previous`. */
export function activate(root: string, id: string, now = new Date()): void {
	if (!ID.test(id) || !existsSync(join(releasesDir(root), id, "index.html"))) throw new Error(`There is no release ${id} in ${root}`);
	const before = linked(root, "current");
	if (before === id) return;
	const mark = join(releasesDir(root), id, ".activated");
	writeFileSync(mark, "");
	utimesSync(mark, now, now);
	if (before) point(root, "previous", before);
	point(root, "current", id);
}

/** Stops serving any release: the Gate serves the web app its image holds again (what to do after the image was updated). The releases stay on disk. */
export function clear(root: string): void {
	for (const name of ["current", "previous"] as const) rmSync(join(root, name), { force: true });
}

/** Serves the release that was served before the current one; they swap, so rolling back twice goes forward again. */
export function rollback(root: string, now = new Date()): string {
	const previous = linked(root, "previous");
	if (!previous) throw new Error(`There is no earlier release to return to in ${root}`);
	activate(root, previous, now);
	return previous;
}

/**
 * Deletes releases nothing needs: the current and previous ones always stay, and so do the `keep` most recently activated and every one
 * activated within `minAgeDays`, which is how long a tab opened before a release is expected to keep asking for its files. Returns the ids deleted.
 */
export function prune(root: string, options: { keep?: number; minAgeDays?: number; now?: Date } = {}): string[] {
	const keep = options.keep ?? 5;
	const cutoff = (options.now ?? new Date()).getTime() - (options.minAgeDays ?? 7) * 86_400_000;
	const deleted: string[] = [];
	listReleases(root).forEach((release, index) => {
		if (release.current || release.previous || index < keep || release.usedAt >= cutoff) return;
		rmSync(join(releasesDir(root), release.id), { recursive: true, force: true });
		deleted.push(release.id);
	});
	// A publish that was cut off leaves its staging directory behind.
	for (const entry of existsSync(releasesDir(root)) ? readdirSync(releasesDir(root)) : []) {
		const path = join(releasesDir(root), entry);
		if (entry.startsWith(".staging-") && lstatSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
	}
	return deleted;
}

function flag(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
}

export function main(argv: string[]): number {
	const [command, ...rest] = argv;
	const positional = rest.filter((arg, i) => !arg.startsWith("--") && !rest[i - 1]?.startsWith("--"));
	const out = (line: string) => process.stdout.write(`${line}\n`);
	try {
		switch (command) {
			case "publish": {
				const [dist, root] = positional;
				if (!dist || !root) throw new Error("usage: publish <dist> <root> [--activate]");
				const release = publish(resolve(dist), resolve(root));
				out(`published ${release.id} (${release.files} files, ${Math.round(release.bytes / 1024)} KiB)`);
				if (rest.includes("--activate")) {
					activate(resolve(root), release.id);
					out(`serving ${release.id}`);
				}
				return 0;
			}
			case "activate": {
				const [id, root] = positional;
				if (!id || !root) throw new Error("usage: activate <id> <root>");
				activate(resolve(root), id);
				out(`serving ${id}`);
				return 0;
			}
			case "rollback": {
				const [root] = positional;
				if (!root) throw new Error("usage: rollback <root>");
				out(`serving ${rollback(resolve(root))}`);
				return 0;
			}
			case "clear": {
				const [root] = positional;
				if (!root) throw new Error("usage: clear <root>");
				clear(resolve(root));
				out("serving the web app of the image");
				return 0;
			}
			case "list": {
				const [root] = positional;
				if (!root) throw new Error("usage: list <root>");
				for (const r of listReleases(resolve(root))) out(`${r.current ? "current " : r.previous ? "previous" : "        "} ${r.id} ${r.version ?? ""} ${r.revision?.slice(0, 7) ?? ""} used ${new Date(r.usedAt).toISOString()}`);
				return 0;
			}
			case "prune": {
				const [root] = positional;
				if (!root) throw new Error("usage: prune <root> [--keep 5] [--min-age-days 7]");
				const keep = flag(rest, "--keep");
				const minAge = flag(rest, "--min-age-days");
				const deleted = prune(resolve(root), { ...(keep ? { keep: Number(keep) } : {}), ...(minAge ? { minAgeDays: Number(minAge) } : {}) });
				out(deleted.length ? `deleted ${deleted.join(", ")}` : "nothing to delete");
				return 0;
			}
			default:
				throw new Error("usage: web-release.ts publish|activate|rollback|clear|list|prune ...");
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
