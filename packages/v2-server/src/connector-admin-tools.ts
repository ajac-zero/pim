/**
 * The tools with which an agent finds, connects and manages connectors, ported from v1 (`src/extensions/mcp.ts`, `agents.ts`) onto `ConnectorService` (`./connector-service.ts`), which the
 * web app's Connectors screen uses too: `find_connector` searches what this Pim offers, `list_connectors` says how each connection stands, `connect_connector` starts a connection and gives
 * back the link the person signs in at, `manage_connectors` changes this agent's connector list once the person approves it, and the admin's majordomo has `add_custom_connector`. What a
 * connected service's tools do is `./connector-tools.ts`.
 */
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import { OwnerId, type Principal } from "@pim/v2-contracts/identity";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { rosterOf } from "./agent-team-tools.ts";
import { type CustomApp, CUSTOM_APPS_KEY, customApps } from "./compat/admin-gallery.ts";
import { chatApps, type Transport } from "./connector-tools.ts";
import { ConnectorService, type DirectoryApp } from "./connector-service.ts";
import type { Env } from "./native/native.ts";
import { askFirst, recordResult } from "./tool-approval.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

/** The most connectors one agent lists, as in v1. */
export const MAX_APPS = 10;
const MAX_FOUND = 8;

/** Words of a query or name, for matching. */
const words = (value: string): string[] => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);

/** The connectors a query names: those whose name has its words first, then those whose description does. */
export function findApps(directory: readonly DirectoryApp[], query: string): DirectoryApp[] {
	const wanted = words(query);
	const rank = (app: DirectoryApp) => {
		const name = words(app.name);
		if (name.join(" ") === wanted.join(" ")) return 0;
		if (wanted.every((word) => name.includes(word))) return 1;
		if (wanted.some((word) => name.includes(word))) return 2;
		return wanted.some((word) => words(app.description).includes(word)) ? 3 : undefined;
	};
	return directory
		.flatMap((app) => {
			const score = rank(app);
			return score === undefined ? [] : [{ app, score }];
		})
		.sort((a, b) => a.score - b.score)
		.slice(0, MAX_FOUND)
		.map(({ app }) => app);
}

export function connectorAdminTools(deps: { ownerId: string; runtime: RuntimeDb; read: Define; write: Define; env: Env; transport: Transport; now: () => number }): ToolRegistration[] {
	const { ownerId, runtime, read, write } = deps;
	const S = Type.String;
	const O = Type.Optional;
	const service = (app: App) => new ConnectorService(app, deps.env, deps.transport, deps.now);
	const directoryOf = async (app: App) => service(app).directory(await customApps(app));
	/** The person, for the one thing the sign-in needs of them: a connection can only be made as the person (`ConnectorService.connect`), and its link is theirs to follow. */
	const person: Principal = { kind: "user", ownerId: OwnerId.parse(ownerId), role: "member", sessionId: "agent-connect" };
	const origin = () => (deps.env.PIM_PUBLIC_URL ?? "").replace(/\/$/, "");
	const noAddress = text("This Pim has no public address (PIM_PUBLIC_URL), so it cannot make a sign-in link. The person can connect it in Settings → Connectors.", true);

	/** Connects directory entries not connected yet, saying for each what came of it. */
	async function connectAll(app: App, entries: readonly DirectoryApp[], directory: readonly DirectoryApp[]): Promise<string[]> {
		const out: string[] = [];
		for (const entry of entries) {
			try {
				const result = await service(app).connect(person, origin(), { ref: entry.ref, name: entry.name, url: entry.url }, directory);
				if (result.state === "ready") out.push(`${entry.name} is connected.`);
				else if (result.authUrl) out.push(`${entry.name} needs the person to sign in. Give them this link: ${result.authUrl}`);
				else out.push(`${entry.name} was added, but connecting failed: ${result.error ?? "unknown error"}. Use connect_connector to retry.`);
			} catch (error) {
				out.push(`${entry.name} was added, but connecting failed: ${error instanceof Error ? error.message : String(error)}. Use connect_connector to retry.`);
			}
		}
		return out;
	}
	/** The agent whose connector list a call changes: the chat's own. */
	const selfOf = async (call: Call) => (await rosterOf(runtime, ownerId, call.chat)).self;
	/** Only the person's majordomo, on an active admin's account, runs the deployment. */
	const adminMajordomo = async (app: App, call: Call): Promise<string | undefined> => {
		if (!(await rosterOf(runtime, ownerId, call.chat)).majordomo) return "Only the person's majordomo does that.";
		const account = await app.identity.authz.account(ownerId);
		return account && account.status === "active" && account.role === "admin" ? undefined : "Only the admin of this Pim adds connectors to it.";
	};

	return [
		read("find_connector", "Find a connector this Pim offers by what the person calls it, for its id, which manage_connectors adds and connect_connector connects. Only connectors this Pim offers can be connected.", Type.Object({ connector: S({ minLength: 2, maxLength: 60, description: "The connector's name, like Linear or Notion, or what it does." }) }), async (app, _call, a) => {
			const found = findApps(await directoryOf(app), a.connector);
			if (found.length === 0) return text(`No connector on this Pim matches "${a.connector}". Only the connectors this Pim offers can be connected: tell the person, and that its admin can add one. If you have add_custom_connector, the person is its admin: ask for the connector's MCP server URL and add it.`);
			const connected = new Set((await service(app).list(person, await directoryOf(app))).flatMap((c) => (c.app ? [c.app] : [])));
			return text([`Connectors on this Pim matching "${a.connector}":`, ...found.map((c) => `- ${c.name} [id: ${c.ref}]${connected.has(c.ref) ? " (connected)" : ""}${c.description ? `: ${c.description}` : ""}`), "Use connect_connector with its id to connect it, and manage_connectors to add it to your list."].join("\n"));
		}),
		read("list_connectors", "List the connectors the person has connected, how each stands (ready, waiting for the person to sign in, or failed), and their tools.", Type.Object({}), async (app, call) => {
			const connections = await service(app).list(call.p, await directoryOf(app));
			if (connections.length === 0) return text("Nothing is connected. Find a connector with find_connector, then connect it with connect_connector.");
			return text(JSON.stringify(connections.map((c) => ({ id: c.id, name: c.name, ...(c.app ? { app: c.app } : {}), state: c.state, ...(c.error ? { error: c.error } : {}), tools: c.tools.map((t) => t.name) })), null, 1));
		}),
		write("connect_connector", "Connect a connector this Pim offers that isn't connected yet, giving you its tools. If the person must sign in first, you get a link to give them. Find a connector's id with find_connector.", Type.Object({ connector: S({ description: "The connector's id or name, as find_connector or list_connectors gives it." }) }), async (app, call, a) => {
			if (!origin()) return noAddress;
			const directory = await directoryOf(app);
			const wanted = String(a.connector).trim().toLowerCase();
			const entry = directory.find((d) => d.ref.toLowerCase() === wanted) ?? directory.find((d) => d.name.toLowerCase() === wanted);
			const existing = (await service(app).list(person, directory)).find((c) => c.id === a.connector || (entry ? c.app === entry.ref : c.name.toLowerCase() === wanted));
			// An agent connects only the connectors it lists, as in v1: another is added to its list first (manage_connectors), with the person's approval.
			const { apps } = await chatApps(runtime, ownerId, call.chat);
			if ((entry || existing) && !(entry && apps.includes(entry.ref)) && !(existing && (apps.includes(existing.id) || apps.includes(existing.name)))) {
				const names = directory.filter((d) => apps.includes(d.ref)).map((d) => d.name).join(", ");
				return text(`This agent doesn't work with ${a.connector}${names ? `; its connectors are ${names}` : ""}. If manage_connectors is available, request adding it there by its id from find_connector; approval adds and connects it. Otherwise the person can add it in Your agents.`, true);
			}
			if (existing?.state === "ready") return text(`${existing.name} is already connected. Its tools: ${existing.tools.map((t) => t.name).join(", ") || "none"}.`);
			if (!entry) return text(`This Pim offers no connector ${a.connector}. Use find_connector for a connector's id${directory.length ? "" : "; this Pim offers none yet, and its admin can add one"}.`, true);
			const result = await service(app).connect(person, origin(), { ref: entry.ref, name: entry.name, url: entry.url }, directory);
			if (result.state === "failed") return text(`${entry.name} did not connect: ${result.error ?? "unknown error"}.`, true);
			if (result.authUrl) return text(`${entry.name} needs the person to sign in before it can be used. Give them this link: ${result.authUrl}`);
			const tools = (await service(app).list(person, directory)).find((c) => c.id === result.id)?.tools ?? [];
			return text(`Connected ${entry.name}. Its tools: ${tools.map((t) => t.name).join(", ") || "none"}.`);
		}),
		// The two that ask the person first are parked and run again when they decide, so tools that may be run again.
		read("manage_connectors", "Change the list of connectors you work with, and connect the ones added. The person approves every change first. add takes ids from find_connector; remove takes ids from list_connectors or find_connector. A connection the person made stays, for their other agents.", Type.Object({
			add: O(Type.Array(S(), { maxItems: MAX_APPS, description: "Ids of connectors to add and connect after approval, as find_connector gives them." })),
			remove: O(Type.Array(S(), { maxItems: MAX_APPS, description: "Ids of connectors to remove from your list." })),
		}), async (app, call, a) => {
			if (!(a.add?.length || a.remove?.length)) return text("Give add, remove, or both.", true);
			const id = await selfOf(call);
			if (!id) return text("There is no agent whose connectors to change.", true);
			const directory = await directoryOf(app);
			for (const ref of a.add ?? []) if (!directory.some((d) => d.ref === ref)) return text(`This Pim offers no connector ${ref}. Use find_connector for a connector's id.`, true);
			const agent = await app.agents.get(call.p, id);
			const kept = agent.apps.filter((x) => !a.remove?.includes(x));
			const next = [...new Set([...kept, ...(a.add ?? [])])];
			if (next.length > MAX_APPS) return text(`An agent works with up to ${MAX_APPS} connectors: remove one first.`, true);
			const name = (ref: string) => directory.find((d) => d.ref === ref)?.name ?? ref;
			const changes = [...((a.add ?? []) as string[]).filter((r) => !agent.apps.includes(r)).map((r: string) => `adds ${name(r)} and connects it`), ...((a.remove ?? []) as string[]).filter((r) => agent.apps.includes(r)).map((r: string) => `removes ${name(r)}`)];
			if (changes.length === 0) return text(`${agent.name}'s connectors are as asked already.`);
			const waiting = await askFirst({ app, runtime, ownerId }, call, { action: "connector:manage", tool: "manage_connectors", resource: { agent: id }, summary: `${agent.name} ${changes.join(" and ")}`, args: { agent: id, add: a.add, remove: a.remove }, explicit: true, denied: "The person did not approve that change, so the connectors are as they were." });
			if (waiting) return waiting;
			if ((a.add?.length ?? 0) > 0 && !origin()) return noAddress;
			await app.agents.update(call.p, id, { apps: next });
			const added = directory.filter((d) => a.add?.includes(d.ref));
			const done = [`${agent.name}'s connectors are updated. Shared connections are unchanged, and each tool of a connector stays off for this agent until the person turns it on, Ask or On, on this agent's page in Agents.`, ...(await connectAll(app, added, directory))].join("\n");
			await recordResult(app, ownerId, "connector:manage", String(call.api.taskId), done);
			return text(done);
		}),
		read("add_custom_connector", "The person runs this Pim: add a remote MCP server they give you to its connectors, for everyone on it, then add it to your connectors and connect it. Only for a connector find_connector doesn't find. Give the server's https URL as the person gave it, never with credentials in it; if it needs a sign-in, you get the link to give them. The person approves it first.", Type.Object({
			name: S({ minLength: 1, maxLength: 60, description: "The connector's name, as people will see it." }),
			url: S({ pattern: "^https?://\\S+$", maxLength: 500, description: "The MCP server's https URL." }),
			description: O(S({ maxLength: 160, description: "What it does, in a sentence." })),
		}), async (app, call, a) => {
			const refused = await adminMajordomo(app, call);
			if (refused) return text(refused, true);
			let url: URL;
			try {
				url = new URL(a.url);
			} catch {
				return text("That is not a web address.", true);
			}
			if (url.username || url.password) return text("An address with credentials in it is refused: never put them in the URL.", true);
			// As the admin's own screen has it: https, or a local address while this deployment may reach private ones.
			if (url.protocol !== "https:" && !(deps.env.PIM_CONNECTOR_ALLOW_PRIVATE === "1" || /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) return text("A connector's address is https.", true);
			if (!origin()) return noAddress;
			const waiting = await askFirst({ app, runtime, ownerId }, call, { action: "connector:add", tool: "add_custom_connector", resource: { url: url.origin }, summary: `Add ${a.name} (${a.url}) to this Pim's connectors for everyone, and connect it`, args: { name: a.name, url: a.url }, explicit: true, denied: "The person did not approve adding that connector, so nothing was added." });
			if (waiting) return waiting;
			// One that is there at that address already is the one used, as in v1.
			const known = (await customApps(app)).find((c) => c.url === a.url);
			let entry: CustomApp;
			if (known) entry = known;
			else {
				const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
				entry = { id: `${slug || "connector"}-${randomBytes(3).toString("hex")}`, name: a.name.trim(), description: String(a.description ?? ""), url: a.url, icon: null, category: null };
				const all = JSON.stringify([...(await customApps(app)), entry]);
				await app.db.anonymous((tx) => tx.query("INSERT INTO pim_app.instance_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [CUSTOM_APPS_KEY, all]));
			}
			const directory = await directoryOf(app);
			const added = directory.find((d) => d.ref === `custom/${entry.id}`)!;
			const id = (await rosterOf(runtime, ownerId, call.chat)).self;
			if (id) {
				const agent = await app.agents.get(call.p, id);
				await app.agents.update(call.p, id, { apps: [...new Set([...agent.apps, added.ref])].slice(0, MAX_APPS) });
			}
			const done = [`${added.name} is one of this Pim's connectors [id: ${added.ref}], and one of yours.`, ...(await connectAll(app, [added], directory))].join("\n");
			await recordResult(app, ownerId, "connector:add", String(call.api.taskId), done);
			return text(done);
		}),
	];
}
