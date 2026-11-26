#!/usr/bin/env node
// Moves `edge` to a commit's images, or writes the first record of where it stands (publish.yml, the `edge` and `bootstrap-edge` jobs). Both run in the one `publish-edge` concurrency group, so
// the records are read, judged and written by one run at a time; nothing else in the repository writes `edge` or the records. The judgement of order is scripts/edge-order.mjs.
//
// Moving `edge` is three alias writes and cannot be one step, so a promotion is written down before it starts. Two records, each the label of a scratch image:
//   `pim:edge-intent`  the commit being promoted, written BEFORE the first alias moves
//   `pim:edge-commit`  the commit whose promotion finished, written AFTER the last
// A run first finishes any promotion whose intent is not yet the finished commit, then judges its own commit against the intent (which is never behind the finished one), so a promotion that stopped
// halfway is completed by whichever run comes next, and an older commit arriving in between can never move an alias back.
//
//   node scripts/edge-promote.mjs promote <owner> <commit>        moves edge if the commit comes after the one that was promoted last
//   node scripts/edge-promote.mjs bootstrap <owner> <commit>      writes the first record, for an edge that predates it, after a person checked which commit edge serves
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { decideInRepo } from "./edge-order.mjs";
import { IMAGE_NAMES, registry } from "./registry.mjs";

export const RECORD_LABEL = "dev.pim.edge-commit";
export const INTENT_LABEL = "dev.pim.edge-intent";
const sha12 = (sha) => sha.slice(0, 12);

/** Every image's `edge` on the commit's image, written only where it is not already. */
function moveEdge({ base, sha, reg }) {
	for (const name of IMAGE_NAMES) if (!reg.exists(`${base}/${name}:sha-${sha12(sha)}`)) throw new Error(`${base}/${name}:sha-${sha12(sha)} does not exist: edge is not moved to an image that was not published for this commit`);
	for (const name of IMAGE_NAMES) {
		const image = `${base}/${name}`;
		if (reg.digest(`${image}:edge`) !== reg.digest(`${image}:sha-${sha12(sha)}`)) reg.tag(`${image}:sha-${sha12(sha)}`, `${image}:edge`);
	}
}

/** @returns {{ action: "promoted" | "skipped" | "refused", why: string }} */
export function promoteEdge({ owner, sha, host = "ghcr.io", reg = registry(), decide = decideInRepo, cwd }) {
	const base = `${host}/${owner}`;
	const record = `${base}/pim:edge-commit`;
	const intentRef = `${base}/pim:edge-intent`;
	const finished = reg.label(record, RECORD_LABEL) ?? undefined;
	const intent = reg.label(intentRef, INTENT_LABEL) ?? undefined;
	// A promotion that stopped partway is finished first, whoever comes next.
	if (intent && intent !== finished) {
		moveEdge({ base, sha: intent, reg });
		reg.writeRecord(record, RECORD_LABEL, intent);
	}
	const promoted = intent ?? finished;
	const edgeExists = IMAGE_NAMES.some((name) => reg.exists(`${base}/${name}:edge`));
	const decision = decide(sha, promoted, cwd, edgeExists);
	if (decision.action !== "promote") return { action: decision.action === "refuse" ? "refused" : "skipped", why: decision.why };
	for (const name of IMAGE_NAMES) if (!reg.exists(`${base}/${name}:sha-${sha12(sha)}`)) throw new Error(`${base}/${name}:sha-${sha12(sha)} does not exist: edge is not moved to an image that was not published for this commit`);
	reg.writeRecord(intentRef, INTENT_LABEL, sha);
	moveEdge({ base, sha, reg });
	reg.writeRecord(record, RECORD_LABEL, sha);
	return { action: "promoted", why: decision.why };
}

/** The first record: refused when one exists (it would be a rewrite of history), when edge does not exist (there is nothing to record) or when the commit is not on this history. */
export function bootstrapEdge({ owner, commit, head, host = "ghcr.io", reg = registry(), cwd }) {
	const base = `${host}/${owner}`;
	if (reg.exists(`${base}/pim:edge-commit`) || reg.exists(`${base}/pim:edge-intent`)) throw new Error(`${base}/pim already has an edge record: it says which commit promoted edge, and a bootstrap would rewrite it`);
	if (!IMAGE_NAMES.some((name) => reg.exists(`${base}/${name}:edge`))) throw new Error("there is no edge to record: the first promotion needs no bootstrap");
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("bootstrap_edge_commit must be a full commit ID");
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", commit, head], { cwd, stdio: "ignore" });
	} catch {
		throw new Error(`${commit} is not in the history of ${head}`);
	}
	reg.writeRecord(`${base}/pim:edge-commit`, RECORD_LABEL, commit);
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
