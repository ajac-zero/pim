/** Declarations the space's collaborators and `Pim` itself all use (src/space/). */
import type { PiModel } from "agents/harness/pi";
import type { ResolvedPermission } from "../extensions/approvals";
import type { BotTool } from "../extensions/bot-tools";
import type { ToolPermission } from "../store";

/** Marks a chat that is archived as soon as it stops working: its meta key, then the chat's id. */
export const ARCHIVE_WHEN_IDLE_KEY = "archive-when-idle:";

/**
 * Set by the Worker, and only by it, on API requests from the person's
 * signed-in browser rather than an API token: what runs this Pim, such as
 * approving a connector for everyone on it, needs that, as the admin API does.
 */
export const SIGNED_IN_HEADER = "x-pim-signed-in";

/** Where connectors' sign-ins return, as `/mcp/callback/<owner>`, so the Worker knows whose space the callback is for. */
export const MCP_CALLBACK_PATH = "/mcp/callback";

/**
 * Where sign-ins to the connectors extensions implement return, the same for
 * everyone so services can have it registered: `state` names the owner,
 * `<owner>.<nonce>`. Owner ids start with `o_`, so it is nobody's `/mcp/callback/<owner>`.
 */
export const APPS_CALLBACK_PATH = `${MCP_CALLBACK_PATH}/apps`;

/** Where the Worker sends `/mcp`: this space as an MCP server (./mcp-server.ts). */
export const MCP_SERVER_PATH = "/mcp-server";

/** Where connectors deliver event webhooks, as `/mcp/events/<owner>/<key>`, the key of a trigger's subscription; signed, so served without the API token. The space sees `/mcp/events/<key>`. */
export const MCP_EVENTS_PATH = "/mcp/events/";

/** Decides an approval its timeout reached, as it was filed to be decided. */
export const APPROVAL_EXPIRY_CALLBACK = "expireApproval";

/** Set while a chat has a message from the person that no reply has settled (see `pushReply`). */
export const awaitingKey = (session: string) => `awaiting:${session}`;

/** The page a browser lands on after signing in to a connector: what happened, and a way back to Pim. */
export function signInResultPage(connected: boolean, home: string | undefined, error?: string): Response {
	const escape = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
	const title = connected ? "Connected" : "Not connected";
	const detail = connected ? "The connector is ready to use. You can close this tab or go back to Pim." : `Sign-in failed: ${escape(error ?? "unknown error")}`;
	const back = home ? `<a href="${escape(home)}">Back to Pim</a>` : "";
	const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;text-align:center;padding:1.5rem;box-sizing:border-box}
main{max-width:22rem}
.logo{width:4rem;display:block;margin:0 auto 2rem}
.mark{width:3rem;height:3rem;border-radius:50%;margin:0 auto 1.25rem;display:grid;place-items:center;font-size:1.5rem;color:#fff;background:${connected ? "#2e9e5b" : "#d1434b"}}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0 0 1.5rem;opacity:.7;line-height:1.5}
a{display:inline-block;padding:.6rem 1.2rem;border-radius:999px;background:#3d59a1;color:#fff;text-decoration:none;font-weight:500}
</style>
<main><svg class="logo" viewBox="0 0 8 4" shape-rendering="crispEdges" aria-hidden="true"><path fill="#e48a7a" d="M0 0h3v1H0zM2 1h1v1H2z"/><path fill="#4f8eb3" d="M0 1h1v3H0zM1 2h1v1H1z"/><path fill="#eab65d" d="M3 2h1v2H3z"/><path fill="#a88cd6" d="M4 1h4v1H4zM5 2h1v2H5zM7 2h1v2H7z"/></svg><div class="mark">${connected ? "&#10003;" : "!"}</div><h1>${title}</h1><p>${detail}</p>${back}</main>`;
	return new Response(body, { status: connected ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/** A memory scope as the API shows it. */
export type MemoryScopeInfo = {
	readonly key: string;
	/**
	 * `private`: the majordomo's own; `everyone`: every agent reads it;
	 * `agent`: an agent's own, which copies of it share; `named`: one the
	 * person made, for the agents they choose; `former`: left by an agent or
	 * named scope since deleted, which only the majordomo reads.
	 */
	readonly kind: "private" | "everyone" | "agent" | "named" | "former";
	/** A named scope's name, or the names of the agents whose own scope it is; null for the others. */
	readonly name: string | null;
	/** The agents whose own scope it is, by id. */
	readonly agents: readonly string[];
	/** The agents that read it, by id: the majordomo reads every scope. */
	readonly readers: readonly string[];
	/** The memories in it, those forgotten too. */
	readonly count: number;
};

/** Why an approval was decided without the user deciding: it timed out, or the user always approves its tool. */
export type AutoApproval = "timeout" | "always" | "majordomo";

/** A tool a permission can be set for, as the API shows it. */
export type ToolPermissionInfo = ResolvedPermission & {
	/** The connector's id; null for Pim's own tools. */
	readonly app: string | null;
	readonly appName: string | null;
	/** The tool's own name, which its permission is set by. */
	readonly tool: string;
	/** The name the model sees. */
	readonly name: string;
	readonly description: string | null;
	/** The connector says the tool only reads. */
	readonly readOnly: boolean;
	/** The connector says the tool may delete or overwrite things. */
	readonly destructive: boolean;
	/** The permissions it can have. */
	readonly choices: readonly ToolPermission[];
};

/** Whether the space works: a suspended one answers nothing and runs nothing until its operator lifts it. */
export type OwnerStatus = "active" | "suspended";

/** What registration tells a space about its owner when it provisions it. */
export type OwnerProfile = { readonly ownerId: string; readonly username: string };

/** A guest's bot: its id in the gallery, their copy of it, and when the sharing their copy follows was made. */
/**
 * In a guest's space, the bot they joined through: its id, the guest's copy
 * of it, which sharing of it the copy follows, its author's owner id, and the
 * tools it shares, which run in the author's space. Guests who joined before
 * bots shared tools have neither until the bot is shared again.
 */
export type GuestBot = {
	readonly bot: string;
	readonly agent: string;
	readonly sharedAt: number;
	readonly owner?: string;
	readonly tools?: readonly BotTool[];
};

/** What a deployment without the `AI` binding has for Workers AI: it fails every request with a way forward. */
export type AiEnv = { readonly AI?: Ai };

export const UTILITY_MODEL_KEY = "utility_model";

/** `pim_meta` keys of the messages suggested under a chat (see `Pim.#suggestions`) start with this, then its session id. */
export const SUGGESTIONS_KEY = "suggestions:";

/** The numbered title a fork starts with, by session, until the person's first message in it names it anew. */
export const FORK_KEY = "fork:";

/** What the person told their majordomo to call them, when they set it up. */
export const PERSON_NAME_KEY = "person_name";

export const LIMITS_KEY = "limits";

/** Subscribing to a connector's events needs no approval, so its setting is only Off or On, and Ask (from before) counts as On. */
export const WATCH_APP_EVENT = "watch_connector_event";

/** "1" when the owner is this Pim's admin, as last read from the directory with the admin's connectors. */
export const OWNER_ADMIN_KEY = "owner_admin";

/** The person's own model providers (./providers.ts), keys included. */
export const OWN_PROVIDERS_KEY = "own_providers";

/** The admin's model providers, as last read from the gallery. */
export const SHARED_PROVIDERS_KEY = "shared_providers";

export const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const VERSION = /^[1-9][0-9]{0,8}$/;

/** A socket's chat, or for an app showing the computer's desktop, the channel its stream comes on and the thread whose display it shows, if not the primary desktop. */
export type SocketState = { readonly session: string; readonly channel?: number; readonly display?: string };

/** A socket editing a note: which one. */
export type NoteSocketState = { readonly note: string };

/** Whether `work` settled within `ms`; it goes on either way. */
export async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([work.then(() => true, () => true), late]);
	} finally {
		clearTimeout(timer);
	}
}

export function clipTitle(text: string): string {
	const line = text.trim().split(/\r?\n/)[0]!.trim();
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

export function sameModel(a: PiModel, b: PiModel): boolean {
	return a.provider === b.provider && a.id === b.id;
}

/** A model as the API shows it; `images` says whether it can see them. */
export function describeModel(model: PiModel) {
	return {
		provider: model.provider,
		id: model.id,
		name: "name" in model && typeof model.name === "string" ? model.name : model.id,
		images: "input" in model && Array.isArray(model.input) && model.input.includes("image"),
	};
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
