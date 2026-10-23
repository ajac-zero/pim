import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Schedule } from "agents";
import type { Approval, ApprovalMember, Notification, PimStore, ToolPermission } from "../store";
import type { ShownWidget, ToolWidget } from "./define";

/** Payload of a schedule created by `schedule_task`. */
export type ScheduledTaskPayload = {
	/** The chat that scheduled it: where it fires, or whose agent starts each new chat. */
	readonly session: string;
	readonly instruction: string;
	readonly label?: string;
	/** Each firing starts a new chat with the scheduling chat's agent instead of continuing that chat. */
	readonly newChat?: true;
	/** The agent each new chat is with, when the majordomo scheduled the work for another of the person's agents. */
	readonly agent?: string;
};

/**
 * What Pim's extensions need from the Durable Object that hosts them. The
 * agent implements it; tests can too.
 */
export type PimServices = {
	readonly store: PimStore;
	/**
	 * Records a delivered reply and refreshes connected clients' conversation
	 * lists. With `alert`, the reply's text, it is also pushed to the person's
	 * devices if no client has read it a few seconds later.
	 */
	responseSent(session: string, at: number, alert?: string): Promise<void>;
	/**
	 * An agent sent a message in a chat, sent at `at`, with Pim's copies of
	 * the images it shows by their addresses: the other agents in the chat
	 * hear it, and those it mentions answer (see ../rooms.ts). The same
	 * message again is heard once.
	 */
	posted(session: string, message: string, at: number, images: Readonly<Record<string, string>>): Promise<void>;
	/** Whether the agent of a chat may take no turn on `input` without sending anything, as an agent in a room may on what wasn't for it. */
	maySkip(session: string, input: string): boolean;
	/** IANA time zone the user lives in, for reading and writing times; it follows their settings. */
	readonly timeZone: string;
	schedule(when: Date | number | string, payload: ScheduledTaskPayload): Promise<Schedule<ScheduledTaskPayload>>;
	listSchedules(): Promise<Schedule<ScheduledTaskPayload>[]>;
	cancelSchedule(id: string): Promise<boolean>;
	/** Deliver a stored notification to the user's connected clients and devices. */
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
	 * Takes a just-filed approval (`isNew`) or one a call woken by its
	 * decision found, and returns the outcome the model reads when it is
	 * decided already or the user lets the tool run without asking. Else it
	 * asks the user, once, and returns null: the call waits for the decision.
	 */
	approvalFiled(approval: Approval, isNew: boolean): Promise<string | null>;
	/** The user's permission for the tool that filed the approval: `on` approves it without asking. */
	permission(approval: Approval): ToolPermission;
	/** The agent at work on a task in a conversation, and the chat the work began in; null for a chat of the person's. */
	taskAgent(session: string): ApprovalMember | null;
	/**
	 * The widgets a chat can show with its messages: Pim's own, and those of
	 * the extensions its agent builds on and uses, that describe themselves to
	 * the model. None in a visit, which talks with someone else's space.
	 */
	widgetsFor(session: string): { ref: string; description: string }[];
	/** Loads one of them, or one kept from a tool's result, for this space, as the person will see it with the message. */
	showWidget(session: string, ref: string): Promise<ShownWidget>;
	/** Keeps what an app tool's result shows, for the chat to put under a message: its ref, `tool:<id>`. */
	keepWidget(session: string, widget: ToolWidget): string;
	/** The refs of the widgets kept from tool results in a chat. */
	keptWidgets(session: string): string[];
	/** Of the images a reply would show, those no tool's result in its chat gave (send_to_user's own refusals aside). */
	unseenImages(session: string, urls: readonly string[]): Promise<string[]>;
	/**
	 * Keeps copies of the images a reply shows, so the person's browser loads
	 * them from Pim, not from elsewhere: each image's address here
	 * (`/api/images/<id>`) by its address on the web, for those that are
	 * images Pim takes and fit in the space's storage. None in a visit.
	 */
	keepImages(session: string, urls: readonly string[]): Promise<Record<string, string>>;
};

export function text(value: string, isError = false): ToolExecutionResult {
	return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

export function json(value: unknown): ToolExecutionResult {
	return text(JSON.stringify(value, null, 2));
}
