#!/usr/bin/env node
// The one check that says whether CI passed (the `CI result` job): it always runs, and it fails unless every job the change selected succeeded.
//
// A job a change did not select is skipped, and a skipped job is fine. A job it did select must have succeeded: failed, cancelled and *skipped* all fail it, so a job that was
// skipped for a reason other than not being selected (a failed `changes` job, a broken `if`) cannot pass. Branch protection can require this one check by name, so adding or
// removing a job never changes what the repository requires, and a workflow that selects nothing still reports it.
//
//   NEEDS='<toJSON(needs)>' node scripts/ci-aggregate.mjs
import { pathToFileURL } from "node:url";

/**
 * @param {Record<string, { result: string, outputs?: Record<string, string> }>} needs the results of the jobs this one waits for, as `toJSON(needs)` has them
 * @param {string} [selectionJob] the job whose `scope` output says which jobs were selected
 * @returns {{ ok: boolean, problems: string[], selected: string[], skipped: string[] }}
 */
export function aggregate(needs, selectionJob = "changes") {
	const problems = [];
	const selection = needs[selectionJob];
	if (!selection || selection.result !== "success") return { ok: false, problems: [`${selectionJob} did not succeed (${selection?.result ?? "missing"}), so nothing was selected`], selected: [], skipped: [] };
	let scope;
	try {
		scope = JSON.parse(selection.outputs?.scope ?? "");
	} catch {
		return { ok: false, problems: [`${selectionJob} gave no readable scope`], selected: [], skipped: [] };
	}
	const selected = [];
	const skipped = [];
	for (const [job, { result }] of Object.entries(needs)) {
		if (job === selectionJob) continue;
		const wanted = scope.jobs?.[job];
		if (wanted === undefined) problems.push(`${job} is not in the scope's table of jobs`);
		else if (result === "failure" || result === "cancelled") problems.push(`${job} ${result}`);
		else if (wanted && result !== "success") problems.push(`${job} was selected but ${result}`);
		(wanted ? selected : skipped).push(job);
	}
	return { ok: problems.length === 0, problems, selected, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = aggregate(JSON.parse(process.env.NEEDS ?? "{}"));
	console.log(`selected: ${result.selected.join(", ") || "none"}\nskipped: ${result.skipped.join(", ") || "none"}`);
	for (const problem of result.problems) console.error(`::error::${problem}`);
	process.exit(result.ok ? 0 : 1);
}
