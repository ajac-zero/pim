import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Schedule } from "agents";
import type { Approval, Notification, PimStore } from "../store";

/** Payload of a schedule created by `schedule_task`. */
export type ScheduledTaskPayload = {
	readonly session: string;
	readonly instruction: string;
	readonly label?: string;
};

/**
 * What Pim's extensions need from the Durable Object that hosts them. The
 * agent implements it; tests can too.
 */
export type PimServices = {
	readonly store: PimStore;
	/** IANA time zone the user lives in, for reading and writing times. */
	readonly timeZone: string;
	schedule(when: Date | number | string, payload: ScheduledTaskPayload): Promise<Schedule<ScheduledTaskPayload>>;
	listSchedules(): Promise<Schedule<ScheduledTaskPayload>[]>;
	cancelSchedule(id: string): Promise<boolean>;
	/** Deliver a stored notification to the user's connected clients and webhook. */
	notify(notification: Notification): Promise<void>;
	/** How long an approval waits for the user before it is approved automatically. */
	readonly approvalTimeoutMs: number;
	/** Tell the user's clients an approval is waiting. */
	approvalRequested(approval: Approval): Promise<void>;
	/**
	 * Waits for the user to decide on the approval, approving it automatically
	 * once the timeout passes, runs the action if approved, and returns the
	 * outcome for the model, so the turn that asked can carry on.
	 */
	awaitApproval(approval: Approval): Promise<string>;
};

export function text(value: string, isError = false): ToolExecutionResult {
	return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

export function json(value: unknown): ToolExecutionResult {
	return text(JSON.stringify(value, null, 2));
}
