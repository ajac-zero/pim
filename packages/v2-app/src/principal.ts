/** Who is acting. Every surface (HTTP, WebSocket, MCP, agent tools, triggers, hosted apps) builds one and asks the same Authorizer. */
export type PrincipalKind = "session" | "token" | "mcp" | "computer" | "host" | "agent" | "trigger" | "public";

export type Principal = {
	readonly kind: PrincipalKind;
	/** The space the principal acts in. */
	readonly ownerId: string;
	/** What it may do: '*', an exact action, or a prefix such as 'api:*'. A token never exceeds its owner whatever it lists. */
	readonly scopes: readonly string[];
	/** Session id, token id or agent id, to tell two principals of one owner apart (standing approvals name it). */
	readonly subject: string;
	/** Who caused this principal to act: set across `delegate` so privilege is never laundered through a more privileged agent. */
	readonly origin?: Principal;
};

export const principalKey = (p: Principal): string => `${p.kind}:${p.subject}`;

/** Narrows a principal for a delegated task: the new one may do only what both it and its originator may. */
export function delegate(from: Principal, to: { kind: PrincipalKind; subject: string; scopes: readonly string[] }): Principal {
	return { kind: to.kind, ownerId: from.ownerId, scopes: to.scopes, subject: to.subject, origin: from };
}

export function scopeAllows(scopes: readonly string[], action: string): boolean {
	return scopes.some((s) => s === "*" || s === action || (s.endsWith(":*") && action.startsWith(s.slice(0, -1))));
}
