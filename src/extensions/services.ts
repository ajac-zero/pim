import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Schedule } from "agents";
import type { Approval, ApprovalMember, Notification, PimStore, ToolPermission } from "../store";
import type { ShownWidget } from "./define";

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
	/** This deployment can send email; each person must also confirm an address. */
	readonly emailEnabled: boolean;
	/**
	 * Emails the person at their confirmed address a message from `session`;
	 * the same `id` again sends nothing. Says where it went, or why it can't.
	 */
	sendEmail(mail: { id: string; session: string; subject: string; text: string }): Promise<{ to: string } | { error: string }>;
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
	/** The team member a conversation is, and the chat it works for; null for a chat of the person's. */
	teamMember(session: string): ApprovalMember | null;
	/**
	 * The widgets a chat can show with its messages: Pim's own, and those of
	 * the extensions its Pim builds on and uses, that describe themselves to
	 * the model. None in a visit, which talks with someone else's Pim.
	 */
	widgetsFor(session: string): { ref: string; description: string }[];
	/** Loads one of them for the chat's Pim, as the person will see it with the message. */
	showWidget(session: string, ref: string): Promise<ShownWidget>;
};

export function text(value: string, isError = false): ToolExecutionResult {
	return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

export function json(value: unknown): ToolExecutionResult {
	return text(JSON.stringify(value, null, 2));
}
