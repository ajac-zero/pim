import type { AuditResult } from "./audit.ts";
import type { ImportSummary } from "./import.ts";

export type CutoverReport = {
	readonly format: 1;
	readonly generatedAt: string;
	readonly verdict: "pass" | "fail";
	readonly import: ImportSummary;
	readonly audit: AuditResult;
	/** What an operator must still do before a Runner starts. */
	readonly beforeRunner: readonly string[];
};

export function buildReport(summary: ImportSummary, audit: AuditResult, now = new Date()): CutoverReport {
	const todo = [
		"Keep the maintenance fence deployed and legacy ingress closed until activation (docs/v2-operations.md, cutover runbook).",
		"Resolve every needs_reconciliation operation, or leave it: no Runner executes one.",
		"Confirm the key backup (keys.backup.json, sealed under the operator passphrase) is stored away from this host.",
	];
	if (summary.warnings.length > 0) todo.unshift(...summary.warnings.map((w) => `Warning: ${w}`));
	if (summary.quiescence.remoteThreadsAdopted > 0) todo.push(`Check ${summary.quiescence.remoteThreadsAdopted} adopted remote coding session(s) in the provider's own list; the legacy system may have left them working.`);
	return { format: 1, generatedAt: now.toISOString(), verdict: audit.ok ? "pass" : "fail", import: summary, audit, beforeRunner: todo };
}

export function reportMarkdown(report: CutoverReport): string {
	const { import: i, audit } = report;
	const lines = [
		`# Cutover report: ${i.cutoverId}`,
		"",
		`**Verdict: ${report.verdict.toUpperCase()}** (${audit.checks.filter((c) => c.ok).length}/${audit.checks.length} checks passed). Generated ${report.generatedAt}.`,
		"",
		`Cutover instant: ${new Date(i.cutoverAt).toISOString()}. Snapshot identity (SHA-256 of its manifest): \`${i.manifestSha256}\`.`,
		"",
		"## What was imported",
		"",
		`- Spaces: ${i.tenants}`,
		...Object.entries(i.partitions).map(([tenant, parts]) => `- ${tenant}: ${parts.length} partition(s): ${parts.join(", ")}`),
		`- Objects copied and re-read: ${i.objects}`,
		`- Accounts the fence had suspended, active again: ${i.normalizedFenceSuspensions.length ? i.normalizedFenceSuspensions.join(", ") : "none"}`,
		"",
		"## Quiescence",
		"",
		`- Operations held for reconciliation: ${i.quiescence.needsReconciliation} (never executed by a Runner)`,
		`- Schedules recorded: ${i.quiescence.dueWork}; occurrences missed during the fence and skipped: ${i.quiescence.missedOccurrences}`,
		`- Remote coding sessions adopted without a new start: ${i.quiescence.remoteThreadsAdopted}`,
		`- Tasks held: ${i.quiescence.heldTasks}; other unfinished tasks a Runner may resume: ${Object.values(i.quiescence.resumableTasks).reduce((a, b) => a + b, 0)}`,
		"",
		"## Counts (source / target)",
		"",
		"| Table | Source | Target |",
		"|---|---:|---:|",
		...Object.entries(audit.counts).map(([name, c]) => `| ${name} | ${c.source} | ${c.target} |`),
		"",
		"## Checks",
		"",
		...audit.checks.map((c) => `- [${c.ok ? "x" : " "}] ${c.name}${c.ok ? "" : ` (expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)})`}`),
		"",
		"## Before any Runner starts",
		"",
		...report.beforeRunner.map((t) => `- ${t}`),
		"",
	];
	return lines.join("\n");
}
