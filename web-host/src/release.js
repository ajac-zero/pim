/**
 * Releases of the web app, in the directory the web host serves from (the `pim-web` volume):
 *
 *   <root>/releases/<id>/   one complete build, named by a hash of its files (so publishing the same build twice is one release)
 *   <root>/current          a symbolic link to the release being served
 *   <root>/previous         a symbolic link to the release served before it
 *
 * The web host publishes the build its own image carries and activates it as it starts; this is how the interface is released, with the backend
 * left running. Releases already there stay, so a page opened before a release can still get the scripts it asks for by name: a built file is named by its
 * content, so the same name in any release is the same bytes, and the host serves a missing `/assets/` file from the other releases (`assets.js`).
 * `prune` is the only thing that deletes a release, and keeps the current and previous ones, the newest few, and every one used recently;
 * the web host runs it after each activation.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const releasesDir = (root) => join(root, "releases");

function filesOf(dir) {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((file) => file !== "release.json" && file !== ".activated" && statSync(join(dir, file)).isFile())
		.sort();
}

/** A hash of every file's path and bytes: the same build always has the same id, and any changed file changes it. */
export function releaseId(dir) {
	const hash = createHash("sha256");
	for (const file of filesOf(dir)) hash.update(file).update("\0").update(readFileSync(join(dir, file))).update("\0");
	return hash.digest("hex").slice(0, 16);
}

export function readRelease(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/** Where the link `name` points, as a release id; undefined when there is no link or it points at nothing. */
export function linked(root, name) {
	try {
		const id = basename(readlinkSync(join(root, name)));
		return existsSync(join(releasesDir(root), id, "index.html")) ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Every release on disk, the one most recently activated (or published) first. */
export function listReleases(root) {
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
export function publish(dist, root, now = new Date()) {
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
	const release = {
		id,
		...(built?.version ? { version: built.version } : {}),
		...(built?.revision ? { revision: built.revision } : {}),
		...(built?.builtAt ? { builtAt: built.builtAt } : {}),
		publishedAt: now.toISOString(),
		files: files.length,
		bytes: files.reduce((sum, file) => sum + statSync(join(staging, file)).size, 0),
	};
	writeFileSync(join(staging, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
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
function point(root, name, id) {
	const temporary = join(root, `.${name}-${process.pid}`);
	rmSync(temporary, { force: true });
	symlinkSync(join("releases", id), temporary);
	renameSync(temporary, join(root, name));
}

/** Serves `id` from the next request on; the release served until now is kept as `previous`. */
export function activate(root, id, now = new Date()) {
	if (!ID.test(id) || !existsSync(join(releasesDir(root), id, "index.html"))) throw new Error(`There is no release ${id} in ${root}`);
	const before = linked(root, "current");
	const mark = join(releasesDir(root), id, ".activated");
	writeFileSync(mark, "");
	utimesSync(mark, now, now);
	if (before === id) return;
	if (before) point(root, "previous", before);
	point(root, "current", id);
}

/**
 * Deletes releases nothing needs: the current and previous ones always stay, and so do the `keep` most recently activated and every one
 * activated within `minAgeDays`, which is how long a tab opened before a release is expected to keep asking for its files. Returns the ids deleted.
 */
export function prune(root, options = {}) {
	const keep = options.keep ?? 5;
	const cutoff = (options.now ?? new Date()).getTime() - (options.minAgeDays ?? 7) * 86_400_000;
	const deleted = [];
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
