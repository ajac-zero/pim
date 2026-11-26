#!/usr/bin/env node
// Moves `stable` and the `X.Y` aliases of the three images (publish.yml, the `release` and `rollback-stable` jobs), as scripts/release-order.mjs decides. Both jobs run in the one `publish-stable`
// concurrency group, so the state is read, judged and written by one run at a time; the state is read from the registry and git tags every time, so a run that was replaced while it waited loses nothing.
//
// Only a release that is complete (its tag, and its three images) and qualified (CI and the Compose smoke test passed on its commit: scripts/ci-status.mjs) is eligible. Which alias points where is
// then repaired image by image and alias by alias, whatever the decision was: a run that stopped after the backend's alias and before the web app's is finished by the next one.
//
//   node scripts/release-promote.mjs reconcile <owner>              after a release was published: stable and X.Y follow the highest eligible versions
//   node scripts/release-promote.mjs rollback <owner> <X.Y.Z>       moves stable (and that version's X.Y) down to an eligible version, and holds it there
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ciStatus } from "./ci-status.mjs";
import { IMAGE_NAMES, registry } from "./registry.mjs";
import { compare, reconcile } from "./release-order.mjs";

export const PIN_LABEL = "dev.pim.stable-pin";

/** The versions whose tag exists and whose three images exist: a tag without all its images is a release that did not finish publishing. */
export function completeVersions({ base, reg, tags }) {
	return tags
		.map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t)?.[1])
		.filter(Boolean)
		.filter((v) => IMAGE_NAMES.every((name) => reg.exists(`${base}/${name}:${v}`)));
}

/**
 * Where each image's `stable` is, as the highest complete version that has its digest (an image reused between releases has the digest of several). `unknown` is true when an image has a `stable`
 * that no complete version has.
 */
function currentStable({ base, reg, complete }) {
	let current = null;
	let unknown = false;
	for (const name of IMAGE_NAMES) {
		const digest = reg.digest(`${base}/${name}:stable`);
		if (!digest) continue;
		const matches = complete.filter((v) => reg.digest(`${base}/${name}:${v}`) === digest);
		if (!matches.length) unknown = true;
		for (const v of matches) if (!current || compare(v, current) > 0) current = v;
	}
	return { current, unknown };
}

export function promoteStable({ owner, tags, qualified, host = "ghcr.io", reg = registry() }) {
	const base = `${host}/${owner}`;
	const complete = completeVersions({ base, reg, tags });
	const published = complete.filter((v) => qualified(v));
	const pin = reg.label(`${base}/pim:stable-pin`, PIN_LABEL);
	const { current, unknown } = currentStable({ base, reg, complete });
	const result = reconcile({ published, current, pin });
	if (result.action === "refuse") return result;
	// A `stable` on an image that is none of the complete releases cannot be judged against one, so it is not moved by a release: a person looks at what it is, and may move it with a rollback.
	if (unknown && !result.pinned) return { action: "refuse", stable: null, minors: {}, why: "stable is on an image that is none of the complete releases (git tags vX.Y.Z with all three images); check it, then move it with rollback_stable_to" };
	if (!result.stable) return result;
	const aliases = { stable: result.stable, ...result.minors };
	for (const name of IMAGE_NAMES) {
		const image = `${base}/${name}`;
		for (const [alias, version] of Object.entries(aliases)) if (reg.digest(`${image}:${alias}`) !== reg.digest(`${image}:${version}`)) reg.tag(`${image}:${version}`, `${image}:${alias}`);
	}
	return result;
}

/** An explicit rollback: `stable` to an eligible `version`, the pin written first so that a run that stops halfway leaves a pin the next reconcile completes. */
export function rollbackStable({ owner, version, tags, qualified, host = "ghcr.io", reg = registry() }) {
	const base = `${host}/${owner}`;
	const published = completeVersions({ base, reg, tags }).filter((v) => qualified(v));
	if (!published.includes(version)) throw new Error(`${version} is not an eligible release: its tag, all three images, and a passing CI and Compose run on its commit must exist`);
	const above = published.reduce((best, v) => (compare(v, best) > 0 ? v : best));
	reg.writeRecord(`${base}/pim:stable-pin`, PIN_LABEL, `${version}@${above}`);
	return promoteStable({ owner, tags, qualified, host, reg });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, ownerArg, version] = process.argv.slice(2);
	if (!ownerArg) throw new Error("usage: release-promote.mjs reconcile|rollback <owner> [<X.Y.Z>]");
	const owner = ownerArg.toLowerCase();
	const tags = execFileSync("git", ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"], { encoding: "utf8" }).split("\n").filter(Boolean);
	const memo = new Map();
	const qualified = (v) => {
		if (!memo.has(v)) memo.set(v, ciStatus(execFileSync("git", ["rev-list", "-n1", `v${v}`], { encoding: "utf8" }).trim()) === "success");
		return memo.get(v);
	};
	try {
		const result = command === "rollback" ? rollbackStable({ owner, version, tags, qualified }) : promoteStable({ owner, tags, qualified });
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
