/**
 * What a person lets Pim's own tools do without asking, and what a connector's tool is held to. A permission is Off, Ask or On. The tools that act outside the
 * conversation each have one (`OWN_TOOLS`), kept in `pim_app.tool_permissions` under the empty connector; without a choice the tool's default applies. What an agent does on
 * the person's computer and its HTTP requests are On, as they run without asking; the rest ask first. A tool whose every call needs the person's own decision (`explicit`) can be
 * Off or Ask, never On.
 */
import { createHash } from "node:crypto";

export type Permission = "off" | "ask" | "on";
export const PERMISSIONS: readonly Permission[] = ["off", "ask", "on"];

export type OwnTool = {
	/** The name the person sees and the model calls. */
	tool: string;
	/** The gated action its calls are filed under. */
	action: string;
	description: string;
	/** What applies until the person chooses. */
	default: Permission;
	/** Every call needs the person's decision: the tool can be switched off or asking, and "Always approve" does not apply. */
	explicit?: true;
};

export const OWN_TOOLS: readonly OwnTool[] = [
	{ tool: "shell", action: "computer:shell", default: "on", description: "Run a command on your computer" },
	{ tool: "file_delete", action: "computer:file_delete", default: "on", description: "Delete a file or folder on your computer" },
	{ tool: "desktop_act", action: "computer:desktop", default: "on", description: "Act in the apps on your computer's desktop: open, click, type, press keys, scroll" },
	{ tool: "browser_click", action: "computer:browser_submit", default: "on", description: "Click a button that sends a form in the agent's browser window" },
	{ tool: "browser_type", action: "computer:browser_submit", default: "on", description: "Press Enter in a field that sends a form in the agent's browser window" },
	{ tool: "browser_upload", action: "computer:browser_submit", default: "on", description: "Upload your files to a page in the agent's browser window" },
	{ tool: "http_request", action: "http:request", default: "on", description: "Send an HTTP request that may change something, such as calling an API or a webhook" },
	{ tool: "write_skill", action: "skill:write", default: "ask", description: "Save a skill for an agent" },
	{ tool: "install_skill", action: "skill:install", default: "ask", explicit: true, description: "Install a skill from a folder on the internet" },
	{ tool: "app_deploy", action: "app:deploy", default: "ask", description: "Run an app's backend on your computer" },
	{ tool: "share_memory_scope", action: "memory:share", default: "ask", description: "Let another agent read one of your named memory scopes" },
	{ tool: "manage_connectors", action: "connector:manage", default: "ask", explicit: true, description: "Change which connectors an agent works with" },
	{ tool: "add_custom_connector", action: "connector:add", default: "ask", explicit: true, description: "Add a connector for everyone on this Pim" },
	{ tool: "trigger_computer_grant", action: "trigger:computer_grant", default: "ask", explicit: true, description: "Let a trigger observe your computer" },
	// What the admin's majordomo asks of the machine Pim runs on: each operation is approved one at a time, so it can be off or asking.
	...["stats", "logs", "restart", "set_slot_limit", "deploy", "update", "rollback", "exec"].map((op): OwnTool => ({ tool: `hostops_${op}`, action: `hostops_${op}`, default: "ask", explicit: true, description: `Ask the host machine for its ${op.replace(/_/g, " ")}` })),
];

/** The own tool a gated call is for: by its name when the action has several, else the action's one. */
export function ownToolOf(action: string, tool?: string): OwnTool | undefined {
	const of = OWN_TOOLS.filter((t) => t.action === action);
	return of.find((t) => t.tool === tool) ?? (of.length === 1 || tool === undefined ? of[0] : undefined);
}

const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
};

/**
 * What a connector's tool is, as a digest: its description, inputs and what it says about itself. A permission given to a tool is tied to it, so a connector that changes a tool
 * the person let run (the owner's Pim asks again, a circle's guests lose it) cannot turn it into something else under a permission given to what it was.
 */
export function toolDefinition(tool: { description?: string; inputSchema?: unknown; annotations?: unknown }): string {
	return createHash("sha256").update(canonical({ description: tool.description ?? null, inputSchema: tool.inputSchema ?? null, annotations: tool.annotations ?? null })).digest("hex");
}

/**
 * Whether a choice made under another definition of the tool no longer holds: for the owner a choice of On, for anyone else any choice but Off. A choice with no definition
 * (made before definitions were kept) is trusted as it stands.
 */
export function choiceChanged(row: { permission: Permission; definition?: string | null } | null | undefined, definition: string | null | undefined, owner: boolean): boolean {
	if (!row || row.definition == null || definition == null || row.definition === definition) return false;
	return owner ? row.permission === "on" : row.permission !== "off";
}
