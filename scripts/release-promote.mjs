#!/usr/bin/env node
// Moves `stable` and the `X.Y` aliases of the three images (publish.yml, the `release` and `rollback-stable` jobs), as scripts/release-order.mjs decides. Both jobs run in the one `publish-stable`
// concurrency group, so the state is read, judged and written by one run at a time; the state is read from the registry and git tags every time, so a run that was replaced while it waited loses nothing.
//
//   node scripts/release-promote.mjs reconcile <owner>              after a release was published: stable and X.Y follow the highest published versions
//   node scripts/release-promote.mjs rollback <owner> <X.Y.Z>       moves stable (and that version's X.Y) down to a published version, and holds it there
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { IMAGE_NAMES, registry } from "./registry.mjs";
import { compare, reconcile } from "./release-order.mjs";

export const PIN_LABEL = "dev.pim.stable-pin";
const minorOf = (v) => v.split(".").slice(0, 2).join(".");

/** The versions whose three images exist, in git's tags `vX.Y.Z` (a tag without all its images is a release that did not finish publishing). */
export function publishedVersions({ owner, reg, tags }) {
	return tags
		.map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t)?.[1])
		.filter(Boolean)
		.filter((v) => IMAGE_NAMES.every((name) => reg.exists(`ghcr.io/${owner}/${name}:${v}`)));
}

/** The published version `stable` is on, by digest of the backend image; null when it is on none (or does not exist). */
function currentStable({ owner, reg, published }) {
	const stable = reg.digest(`ghcr.io/${owner}/pim:stable`);
	return stable ? (published.find((v) => reg.digest(`ghcr.io/${owner}/pim:${v}`) === stable) ?? null) : null;
}

export function promoteStable({ owner, tags, reg = registry(), rollback = false }) {
	const published = publishedVersions({ owner, reg, tags });
	const pin = reg.label(`ghcr.io/${owner}/pim:stable-pin`, PIN_LABEL);
	const current = rollback ? null : currentStable({ owner, reg, published });
	// A `stable` on an image that is no published release cannot be judged against one, so it is not moved: a person looks at what it is.
	if (!rollback && !current && reg.exists(`ghcr.io/${owner}/pim:stable`)) {
		return { action: "refuse", stable: null, minors: {}, why: "stable is on an image that is none of the published releases (git tags vX.Y.Z with all three images); check it, then move it with rollback_stable_to" };
	}
	const result = reconcile({ published, current, pin });
	if (result.action === "refuse") return result;
	if (result.stable) {
		for (const name of IMAGE_NAMES) {
			const image = `ghcr.io/${owner}/${name}`;
			if (rollback || result.action === "set") reg.tag(`${image}:${result.stable}`, `${image}:stable`);
			for (const [minor, version] of Object.entries(result.minors)) if (reg.digest(`${image}:${minor}`) !== reg.digest(`${image}:${version}`)) reg.tag(`${image}:${version}`, `${image}:${minor}`);
		}
	}
	return result;
}

/** An explicit rollback: `stable` to a published `version`, the pin written first so that a run that stops halfway leaves a pin the next reconcile completes. */
export function rollbackStable({ owner, version, tags, reg = registry() }) {
	const published = publishedVersions({ owner, reg, tags });
	if (!published.includes(version)) throw new Error(`${version} is not a published release: its tag and all three images must exist`);
	const above = published.reduce((best, v) => (compare(v, best) > 0 ? v : best));
	reg.writeRecord(`ghcr.io/${owner}/pim:stable-pin`, PIN_LABEL, `${version}@${above}`);
	return promoteStable({ owner, tags, reg, rollback: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, ownerArg, version] = process.argv.slice(2);
	if (!ownerArg) throw new Error("usage: release-promote.mjs reconcile|rollback <owner> [<X.Y.Z>]");
	const owner = ownerArg.toLowerCase();
	const tags = execFileSync("git", ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"], { encoding: "utf8" }).split("\n").filter(Boolean);
	try {
		const result = command === "rollback" ? rollbackStable({ owner, version, tags }) : promoteStable({ owner, tags });
		console.log(`stable ${result.action}: ${result.why}`);
		if (result.action === "refuse") {
			console.log(`::error::${result.why}`);
			process.exit(1);
		}
	} catch (error) {
		console.log(`::error::${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}
