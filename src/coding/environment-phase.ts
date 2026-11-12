import type { TranscriptMessage } from "../transcript";
import type { CodingEvent } from "./thread-store";
import { redact } from "./tools/output";

/**
 * The environment phase as the transcript shows it: what the thread did to
 * ready its workspace (restore a snapshot, provision toolchains and
 * dependencies, run the setup script) is recorded as log events by
 * ./thread-do.ts, and turned into notices here, so a person reading the
 * thread sees what ran, how it ended and what it printed.
 */

/** The most of a step's output kept: its end. */
export const STEP_OUTPUT_CHARS = 2048;
const COMMAND_CHARS = 240;

export type StepName = "restore" | "provision" | "setup";

/** What the log keeps of a step: flat, so it is an event's data. */
export type StepRecord = {
	readonly step: StepName;
	readonly command: string;
	readonly outcome: "ok" | "failed" | "skipped";
	readonly exitCode: number | null;
	readonly ms: number;
	readonly output: string;
	readonly outputChars: number;
	readonly truncated: boolean;
};

/** A step's event data: the command is cut and redacted, the output cleaned of control characters, redacted and cut to its last 2 KiB. `outputChars` is how much the step printed before the cut, when the caller knows it. */
export function stepRecord(input: { step: StepName; command: string; outcome: "ok" | "failed" | "skipped"; exitCode: number | null; ms: number; output: string; outputChars?: number }): StepRecord {
	const clean = redact(
		input.output
			.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
			.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
			.replace(/\r/g, ""),
	).trim();
	const total = Math.max(input.outputChars ?? 0, clean.length);
	const command = redact(input.command).slice(0, COMMAND_CHARS);
	return { step: input.step, command, outcome: input.outcome, exitCode: input.exitCode, ms: Math.max(0, Math.round(input.ms)), output: clean.slice(-STEP_OUTPUT_CHARS), outputChars: total, truncated: total > STEP_OUTPUT_CHARS };
}

function duration(ms: number): string {
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const LABELS: Record<StepName, string> = { restore: "Environment restore", provision: "Environment provisioning", setup: "Environment setup" };

function stepText(data: Record<string, unknown>): string {
	const step = (data.step as StepName) in LABELS ? (data.step as StepName) : "setup";
	const outcome = String(data.outcome);
	const head =
		outcome === "skipped"
			? `${LABELS[step]}: skipped`
			: `${LABELS[step]}: ${data.exitCode === null || data.exitCode === undefined ? "no exit" : `exit ${data.exitCode}`}, ${duration(Number(data.ms) || 0)}`;
	const lines = [head, `$ ${data.command}`];
	if (data.output) lines.push(String(data.output));
	if (data.truncated) lines.push(`[Output truncated to its last ${STEP_OUTPUT_CHARS} of ${data.outputChars} characters]`);
	return lines.join("\n");
}

/** The environment's log events as transcript notices, oldest first. `environment.started` is the log's own: nothing of it is said to the person. */
export function environmentNotices(events: readonly CodingEvent[]): TranscriptMessage[] {
	const notices: TranscriptMessage[] = [];
	for (const event of events) {
		const data = (event.data ?? {}) as Record<string, unknown>;
		let text: string | null = null;
		if (event.kind === "environment.step") text = stepText(data);
		else if (event.kind === "environment.restored") text = "Environment: restored from a snapshot";
		else if (event.kind === "environment.built") text = "Environment: ready";
		else if (event.kind === "environment.failed") text = `Environment: failed: ${data.error}\nThe agent starts anyway, in the workspace as it is. Retry the environment to run the setup again.`;
		if (text !== null) notices.push({ id: `environment-${event.seq}`, role: "notice", parts: [{ type: "text", text }], timestamp: event.at });
	}
	return notices;
}

/**
 * The automatic push's failures as transcript notices: one per failure streak, at its first failure that is
 * repeated or is a turn's last try, and one when a push works again after a streak that was told.
 */
export function pushNotices(events: readonly CodingEvent[]): TranscriptMessage[] {
	const notices: TranscriptMessage[] = [];
	let told = false;
	for (const event of events) {
		const data = (event.data ?? {}) as Record<string, unknown>;
		let text: string | null = null;
		if (event.kind === "thread.autopush_failed") {
			const failures = Number(data.failures) || 1;
			if (!told && (failures >= 2 || data.final === true)) {
				told = true;
				text = `Couldn't save commits to GitHub: ${String(data.error ?? "unknown error").slice(0, 200)}; ${failures} ${failures === 1 ? "failure" : "failures"}; the work is still in the workspace`;
			}
		} else if (event.kind === "thread.autopush_recovered") {
			if (told) text = `Saved commits to GitHub at ${String(data.sha ?? "").slice(0, 7)}`;
			told = false;
		}
		if (text !== null) notices.push({ id: `autopush-${event.seq}`, role: "notice", parts: [{ type: "text", text }], timestamp: event.at });
	}
	return notices;
}
