#!/usr/bin/env node
// Moves `edge` to a commit's images, or writes the first record of where it stands (publish.yml, the `edge` and `bootstrap-edge` jobs). Both run in the one `publish-edge` concurrency group, so
// the record is read, judged and written by one run at a time; nothing else in the repository writes `edge` or `edge-commit`. The judgement itself is scripts/edge-order.mjs.
//
//   node scripts/edge-promote.mjs promote <owner> <commit>        moves edge if the commit comes after the one that last promoted it
//   node scripts/edge-promote.mjs bootstrap <owner> <commit>      writes the first record, for an edge that predates it, after a person checked which commit edge serves
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { decideInRepo } from "./edge-order.mjs";
import { IMAGE_NAMES, registry } from "./registry.mjs";

export const RECORD_LABEL = "dev.pim.edge-commit";
const sha12 = (sha) => sha.slice(0, 12);

/** @returns {{ action: "promoted" | "skipped" | "refused", why: string }} */
export function promoteEdge({ owner, sha, reg = registry(), decide = decideInRepo, cwd }) {
	const record = `ghcr.io/${owner}/pim:edge-commit`;
	const promoted = reg.label(record, RECORD_LABEL) ?? undefined;
	const edgeExists = IMAGE_NAMES.some((name) => reg.exists(`ghcr.io/${owner}/${name}:edge`));
	const decision = decide(sha, promoted, cwd, edgeExists);
	if (decision.action !== "promote") return { action: decision.action === "refuse" ? "refused" : "skipped", why: decision.why };
	for (const name of IMAGE_NAMES) {
		const image = `ghcr.io/${owner}/${name}`;
		if (!reg.exists(`${image}:sha-${sha12(sha)}`)) throw new Error(`${image}:sha-${sha12(sha)} does not exist: edge is not moved to an image that was not published for this commit`);
	}
	for (const name of IMAGE_NAMES) reg.tag(`ghcr.io/${owner}/${name}:sha-${sha12(sha)}`, `ghcr.io/${owner}/${name}:edge`);
	// Written last: a promotion that stopped halfway leaves the record on the commit before it, so the next run does it again rather than believing it done.
	reg.writeRecord(record, RECORD_LABEL, sha);
	return { action: "promoted", why: decision.why };
}

/** The first record: refused when one exists (it would be a rewrite of history), when edge does not exist (there is nothing to record) or when the commit is not on this history. */
export function bootstrapEdge({ owner, commit, head, reg = registry(), cwd }) {
	const record = `ghcr.io/${owner}/pim:edge-commit`;
	if (reg.exists(record)) throw new Error(`${record} exists: it already says which commit promoted edge, and a bootstrap would rewrite it`);
	if (!IMAGE_NAMES.some((name) => reg.exists(`ghcr.io/${owner}/${name}:edge`))) throw new Error("there is no edge to record: the first promotion needs no bootstrap");
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("bootstrap_edge_commit must be a full commit ID");
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", commit, head], { cwd, stdio: "ignore" });
	} catch {
		throw new Error(`${commit} is not in the history of ${head}`);
	}
	reg.writeRecord(record, RECORD_LABEL, commit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, owner, commit] = process.argv.slice(2);
	if (!owner || !commit) throw new Error("usage: edge-promote.mjs promote|bootstrap <owner> <commit>");
	try {
		if (command === "promote") {
			const result = promoteEdge({ owner: owner.toLowerCase(), sha: commit });
			console.log(`edge ${result.action}: ${result.why}`);
			if (result.action === "refused") {
				console.log(`::error::${result.why}`);
				process.exit(1);
			}
		} else if (command === "bootstrap") {
			bootstrapEdge({ owner: owner.toLowerCase(), commit, head: process.env.GITHUB_SHA ?? "HEAD" });
			console.log(`edge's first record written: ${commit}`);
		} else throw new Error("usage: edge-promote.mjs promote|bootstrap <owner> <commit>");
	} catch (error) {
		console.log(`::error::${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}
