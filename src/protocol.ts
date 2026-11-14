import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import type { CanvasAnswer } from "./extensions/canvas";
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
	| { readonly type: "snapshot"; readonly id?: string; readonly session: string }
	/**
	 * Hear of changes to a file the app has open (an absolute path under
	 * /workspace). Each `watch_file` of a path is one hold, taken away by one
	 * `unwatch_file`, and all a socket's holds go when it closes. The file as
	 * it is comes back as a `file_changed`.
	 */
	| { readonly type: "watch_file"; readonly id?: string; readonly path: string }
	| { readonly type: "unwatch_file"; readonly id?: string; readonly path: string }
	/** The app's answer to a `canvas_query`. */
	| ({ readonly type: "canvas_answer"; readonly id?: string; readonly request: string } & CanvasAnswer);

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
	/** The person's computer was paired or removed, connected or dropped off, or its files changed under the app. */
	| { readonly type: "computer" }
	/** The person's settings changed, such as the look of the app. */
	| { readonly type: "settings" }
	/**
	 * A file the socket watches changed: `sha256` and `size` are what it is
	 * now (null when it is gone), and `kind` says how. `unwatched` means the
	 * computer can no longer watch it, and the socket no longer hears of it.
	 */
	| { readonly type: "file_changed"; readonly path: string; readonly kind: "modified" | "created" | "deleted" | "renamed" | "unwatched"; readonly sha256: string | null; readonly size: number | null }
	/** The server lost track of what the socket watches (it restarted): the app asks for its files again. */
	| { readonly type: "file_resync" }
	/** An agent opened a file in the canvas of the chat the socket follows. */
	| { readonly type: "canvas_open"; readonly session: string; readonly path: string; readonly line?: number }
	/** An agent asks what the canvas shows, or where the selection is; the app answers with `canvas_answer`. */
	| { readonly type: "canvas_query"; readonly session: string; readonly request: string; readonly what: "tabs" | "selection" }
	| { readonly type: "result"; readonly id: string; readonly result: JsonValue }
	| { readonly type: "error"; readonly id?: string; readonly message: string };
