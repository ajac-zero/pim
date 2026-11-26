#!/usr/bin/env node
// What an image is made of, so an image that was already built from the same inputs is reused rather than built again (docs/v2-operations.md, "What CI runs").
//
// An image's identity is a hash of everything its Dockerfile can read: the Dockerfile, `.dockerignore`, `deploy/IMAGE_EPOCH` and every file the Dockerfile copies
// from the build context (its `COPY` sources, minus what `.dockerignore` leaves out), each by its committed content. It names nothing else: not the commit, not the build
// arguments (the version and revision, which are labels), so two commits with the same inputs have the same identity and the second builds nothing. The image is tagged
// `input-<identity>` when it is built, and a later commit with the same identity finds that tag and points its own tags at that same image. Its labels still say which
// commit built it: it is the older artifact, reused, never presented as built by the newer commit.
//
// The base images (node:*) are named by tag, so a rebuilt base image does not change an identity: bump `deploy/IMAGE_EPOCH` (or run the publish workflow by hand with
// `force`) to rebuild every image on purpose, for a security update of the base.
//
//   node scripts/image-identity.mjs <backend|web|computer>        prints the identity of the image at HEAD
//   node scripts/image-identity.mjs plan                           the publish workflow's plan (see `plan` below); writes `plan=<json>` to $GITHUB_OUTPUT
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copySources, IMAGES } from "./ci-scope.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EPOCH = "deploy/IMAGE_EPOCH";

/** `.dockerignore`'s rules, as the last matching one decides: a pattern, and whether it re-includes (`!`). */
function rules(text) {
	return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => ({ negate: l.startsWith("!"), pattern: l.replace(/^!/, "").replace(/^\//, "").replace(/\/$/, "") }));
}

const matches = (path, pattern) => path === pattern || path.startsWith(`${pattern}/`) || globToRegExp(pattern).test(path) || path.split("/").some((_, i, parts) => globToRegExp(pattern).test(parts.slice(0, i + 1).join("/")));

function globToRegExp(pattern) {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			source += ".*";
			i++;
			if (pattern[i + 1] === "/") i++;
		} else if (c === "*") source += "[^/]*";
		else if (c === "?") source += "[^/]";
		else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/** Whether `.dockerignore` leaves a file out of the build context: it, or a directory above it, matched by the last rule that names it. */
export function ignored(path, dockerignore) {
	let out = false;
	for (const { negate, pattern } of dockerignore) if (matches(path, pattern)) out = !negate;
	return out;
}

/** The identity of the image `dockerfile` builds, from the repository's committed files at `ref`. */
export function identity({ root = ROOT, dockerfile, ref = "HEAD" }) {
	const show = (path) => execFileSync("git", ["show", `${ref}:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const tracked = (path) => execFileSync("git", ["ls-tree", "-r", ref, "--", path], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
	const dockerignore = rules(show(".dockerignore"));
	const hash = createHash("sha256");
	hash.update(`dockerfile\0${show(dockerfile)}\0dockerignore\0${show(".dockerignore")}\0epoch\0${show(EPOCH)}\0`);
	const lines = new Set();
	for (const source of copySources(dockerfile, root)) {
		for (const line of source === "." ? tracked(".") : tracked(source)) {
			const [meta, path] = line.split("\t");
			if (!ignored(path, dockerignore)) lines.add(`${meta.split(" ")[2]} ${path}`);
		}
	}
	for (const line of [...lines].sort()) hash.update(`${line}\n`);
	return hash.digest("hex").slice(0, 16);
}

/** Whether `<repository>:input-<identity>` is in the registry. */
function published(repository, id) {
	try {
		execFileSync("docker", ["buildx", "imagetools", "inspect", `${repository}:input-${id}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * What a publish run builds: one entry per image with its identity and whether it must be built. An image is built when its identity is not in the registry yet; the backend
 * is also built for every release tag, because its version is baked into it (PIM_VERSION), and every image is built when `force` is set.
 */
export function plan({ owner, release, force, exists = published, root = ROOT }) {
	return Object.entries(IMAGES).map(([name, dockerfile]) => {
		const image = name === "backend" ? "pim" : `pim-${name}`;
		const repository = `ghcr.io/${owner}/${image}`;
		const id = identity({ root, dockerfile });
		const reused = !force && !(release && name === "backend") && exists(repository, id);
		return { name, image, repository, dockerfile, identity: id, build: !reused };
	});
}

function main() {
	const [command] = process.argv.slice(2);
	if (command === "plan") {
		const owner = (process.env.IMAGE_OWNER ?? "").toLowerCase();
		const result = plan({ owner, release: process.env.RELEASE === "true", force: process.env.FORCE === "true" });
		console.log(JSON.stringify(result, null, 2));
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(result)}\nbuild=${JSON.stringify(result.filter((i) => i.build))}\n`);
		return;
	}
	if (!IMAGES[command]) throw new Error("usage: image-identity.mjs <backend|web|computer|plan>");
	console.log(identity({ dockerfile: IMAGES[command] }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
