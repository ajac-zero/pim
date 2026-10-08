import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import type { Approval, Notification } from "./store";

/**
 * The WebSocket protocol at `/ws?session=<id>`. A socket
 * follows one session; notifications and approvals are sent to every socket.
 * UIs can import these types from `pim/src/protocol`.
 */

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
	| { readonly type: "resync"; readonly id?: string };

/** Server → client. */
export type ServerMessage =
	| { readonly type: "hello"; readonly session: string; readonly tools: readonly ToolInfo[] }
	/**
	 * pi's agent events for the socket's session. The first batch, and any
	 * batch after the server lost its watch, starts with a `snapshot` event
	 * that replaces the client's state.
	 */
	| { readonly type: "events"; readonly session: string; readonly events: readonly AgentEvent[] }
	| { readonly type: "notification"; readonly notification: Notification }
	/** An approval was requested or decided. */
	| { readonly type: "approval"; readonly approval: Approval }
	| { readonly type: "result"; readonly id: string; readonly result: JsonValue }
	| { readonly type: "error"; readonly id?: string; readonly message: string };
