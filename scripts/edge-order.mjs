#!/usr/bin/env node
// In which order `edge` moves (publish.yml). `edge` is the newest push to `main` that passed CI and the smoke test, and pushes to `main` finish out of order, so each promotion asks
// whether it would move `edge` backwards. The answer comes from the commit that last promoted `edge`, which is recorded on its own (a label of `pim:edge-commit`, written after every
// promotion), and from git's history of those commits. It never comes from an image: an image that was reused carries the labels of the commit that built it, which says nothing
// about which commit released it, so a promotion judged by those labels can move `edge` to the content of an older commit.
//
// The record is the only thing that can say where `edge` stands, so a missing one is not "nothing was promoted" when `edge` already exists: that is refused, and an operator writes the first
// record by hand (the Publish workflow's `bootstrap_edge_commit`) after checking which commit `edge` serves. Only a registry with no `edge` at all starts without one.
//
//   node scripts/edge-order.mjs decide <commit> [<promoted commit>] [<edge exists: true|false>]    prints `promote`, `skip` or `refuse`
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Whether promoting `sha` would be right, given the commit that last promoted `edge` (`promoted`, absent when none did) and a way to ask whether one commit is an ancestor of another
 * (`known` says whether a commit is in the history at all). A commit already promoted or older than the one that was is skipped; one that comes after it is promoted; a promoted
 * commit that history no longer holds (main was rewritten) cannot be newer than anything, so it is replaced.
 */
export function decide({ sha, promoted, isAncestor, known, edgeExists = false }) {
	if (!promoted) return edgeExists ? { action: "refuse", why: "edge exists but no commit is recorded as having promoted it: write the first record with Publish's bootstrap_edge_commit" } : { action: "promote", why: "nothing was promoted before" };
	if (promoted === sha) return { action: "skip", why: "edge was promoted for this commit already" };
	if (!known(promoted)) return { action: "promote", why: `${promoted.slice(0, 12)} is not in this history` };
	if (isAncestor(sha, promoted)) return { action: "skip", why: `edge was promoted for ${promoted.slice(0, 12)}, which comes after ${sha.slice(0, 12)}` };
	if (isAncestor(promoted, sha)) return { action: "promote", why: `${sha.slice(0, 12)} comes after ${promoted.slice(0, 12)}` };
	return { action: "skip", why: `${sha.slice(0, 12)} and ${promoted.slice(0, 12)} are not on one line of history` };
}

/** `decide` against the repository in `cwd`. */
export function decideInRepo(sha, promoted, cwd = process.cwd(), edgeExists = false) {
	const git = (...args) => {
		try {
			execFileSync("git", args, { cwd, stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};
	return decide({ sha, promoted: promoted || undefined, edgeExists, isAncestor: (a, b) => git("merge-base", "--is-ancestor", a, b), known: (c) => git("cat-file", "-e", `${c}^{commit}`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, sha, promoted, edgeExists] = process.argv.slice(2);
	if (command !== "decide" || !sha) throw new Error("usage: edge-order.mjs decide <commit> [<promoted commit>] [<edge exists: true|false>]");
	const result = decideInRepo(sha, promoted, process.cwd(), edgeExists === "true");
	console.error(`${result.action}: ${result.why}`);
	console.log(result.action);
}
