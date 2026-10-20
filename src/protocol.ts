import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import type { Approval, Notification } from "./store";

/**
 * The WebSocket protocol at `/ws?session=<id>`. A socket follows one
 * session at a time, and can switch with `follow`; notifications and
 * approvals are sent to every socket.
 * UIs can import these types from `pim/src/protocol`.
 */

/**
 * An approval as clients see it. Its `session` is null when a guest asked:
 * their conversation is in their own space.
 */
export type PublicApproval = Omit<Approval, "session"> & { readonly session: string | null };

export type ToolInfo = {
	readonly name: string;
	readonly description: string;
	readonly requiresApproval: boolean;
};

/** Client → server. Commands with an `id` get a `result` or `error` back. */
export type ClientMessage =
	| {
			readonly type: "submit";
			readonly id?: string;
			readonly content: UserInput;
			/** Busy session: `followUp` (default) runs after the current run; `steer` joins it. */
			readonly whenBusy?: "followUp" | "steer";
			/** Idempotency key; the same id twice is one submission. */
			readonly operationId?: string;
	  }
	/** Without `operationId`, stops everything running in the session. */
	| { readonly type: "abort"; readonly id?: string; readonly operationId?: string }
	| { readonly type: "reset"; readonly id?: string; readonly handoff?: string }
	/** Ask for a fresh snapshot. */
	| { readonly type: "resync"; readonly id?: string }
	/** Follow another session on this socket, starting with its snapshot, without connecting again. */
	| { readonly type: "follow"; readonly id?: string; readonly session: string }
	/** Another session's `snapshot` event, as the `result`, without following it: to open it current. */
	| { readonly type: "snapshot"; readonly id?: string; readonly session: string };

/** Server → client. */
export type ServerMessage =
	| { readonly type: "hello"; readonly session: string; readonly tools: readonly ToolInfo[] }
	/**
	 * pi's agent events for the socket's session. The first batch, and any
	 * batch after the server lost its watch, starts with a `snapshot` event
	 * that replaces the client's state.
	 */
	| { readonly type: "events"; readonly session: string; readonly events: readonly AgentEvent[] }
	/**
	 * What the agent of the socket's session is doing, in a few words from
	 * the utility model, while it works with a model that doesn't summarize
	 * its own reasoning: one line for the step that made the tool calls
	 * `calls`, in place of their tools' names. Lines aren't stored: a socket
	 * that connects later doesn't get them.
	 */
	| { readonly type: "progress"; readonly session: string; readonly text: string; readonly calls: readonly string[] }
	| { readonly type: "notification"; readonly notification: Notification }
	/** An approval was requested or decided. */
	| { readonly type: "approval"; readonly approval: PublicApproval }
	/** Spaces shared with this one's owner changed: one was shared, or taken back. */
	| { readonly type: "visits" }
	/** The session list changed outside a run: a session got its title. */
	| { readonly type: "sessions" }
	/** The tasks the work begun in a chat led to changed: one was handed out, waits for an approval, or ended. */
	| { readonly type: "tasks"; readonly session: string }
	| { readonly type: "result"; readonly id: string; readonly result: JsonValue }
	| { readonly type: "error"; readonly id?: string; readonly message: string };
