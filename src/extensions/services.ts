import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Schedule } from "agents";
import type { Approval, Notification, PimStore, ToolPermission } from "../store";

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
	/** IANA time zone the user lives in, for reading and writing times; it follows their settings. */
	readonly timeZone: string;
	schedule(when: Date | number | string, payload: ScheduledTaskPayload): Promise<Schedule<ScheduledTaskPayload>>;
	listSchedules(): Promise<Schedule<ScheduledTaskPayload>[]>;
	cancelSchedule(id: string): Promise<boolean>;
	/** Deliver a stored notification to the user's connected clients and webhook. */
	notify(notification: Notification): Promise<void>;
	/**
	 * How long an approval waits before it is approved automatically (the
	 * `auto` policy); null when it waits for the user however long (`explicit`).
	 */
	readonly approvalTimeoutMs: number | null;
	/**
	 * Takes a just-filed approval (`isNew`) or one a replayed call found, and
	 * returns what the model reads: the outcome, when it is decided already
	 * or the user lets the tool run without asking; else that the user was
	 * asked, and is told once, with the decision to come as a message.
	 */
	approvalFiled(approval: Approval, isNew: boolean): Promise<string>;
	/** The user's permission for the tool that filed the approval: `on` approves it without asking. */
	permission(approval: Approval): ToolPermission;
};

export function text(value: string, isError = false): ToolExecutionResult {
	return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

export function json(value: unknown): ToolExecutionResult {
	return text(JSON.stringify(value, null, 2));
}
