/**
 * Connectors: connecting and disconnecting the directory's apps, the admin's custom ones read from the gallery, and the tools they give agents.
 */
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { ArtifactStore } from "../artifacts";
import { AppCatalog } from "../extensions/app-catalog";
import { eventTools, type WatchHost } from "../extensions/app-events";
import { skillTools } from "../extensions/app-skills";
import { SKILL_NAME, SkillStore } from "../skills";
import { ownToolPermission } from "../extensions/approvals";
import { NOTES_SKILL, notesExtension } from "../extensions/notes";
import { appDirectory, type CustomApp, type DirectoryApp } from "../extensions/app-directory";
import { NativeApps } from "../extensions/native-apps";
import { CUSTOM_APPS, secretsOf, type NativeAppDefinition, PimExtensions } from "../extensions/define";
import { agentToolPermission, APP_PREFIX, appExtensionName, type McpApproval, type McpBridge, mcpExtensions, serverFor, slug } from "../extensions/mcp";
import type { PimServices } from "../extensions/services";
import { Files } from "../files";
import { NoteStore } from "../notes";
import { HttpError } from "@pim/shared/http";
import { PimStore } from "../store";
import { type Agent, AgentStore } from "../agents";
import { COMPUTER_GRANT_EXTENSION } from "../triggers/grant-action";
import { TRIGGERS_EXTENSION } from "../triggers/tools";
import type { Role } from "../tasks";
import { REVIEW_EXTENSION } from "../majordomo";
import { MCP_CALLBACK_PATH, WATCH_APP_EVENT, OWNER_ADMIN_KEY, SHARED_PROVIDERS_KEY, within, errorMessage } from "./shared";

/** Set once chats' agents come from the prompt's `agent` section, not from instructions stored in each chat. */
/** The admin's connectors, as this space last read them from the gallery, and how long before it reads them again. */
export const CUSTOM_APPS_KEY = "custom_apps";

/** How long what the admin shares through the gallery (connectors and model providers) is used before it's read again. */
export const CUSTOM_APPS_TTL_MS = 60_000;

/** How long a request waits for that read: a slow or stuck gallery leaves what was read before, and the read goes on without the request. */
export const CUSTOM_APPS_WAIT_MS = 2_000;

/** The built-in apps (./builtin-apps.ts) the admin turned off, as last read from the gallery with their connectors. */
export const DISABLED_BUILTIN_APPS_KEY = "disabled_builtin_apps";

/** What the space's connectors needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface ConnectorsHost {
	readonly apps: McpBridge;
	readonly mcp: import("../../node_modules/agents/dist/agent-routing-Bhdbvf7s").It;
	readonly catalog: AppCatalog;
	readonly store: PimStore;
	readonly nativeApps: NativeApps;
	readonly addMcpServer: (serverName: string, url: string, options?: import("agents").AddMcpServerOptions) => Promise<{ id: string; state: "authenticating"; authUrl: string } | { id: string; state: "ready" }>;
	readonly name: string;
	readonly removeMcpServer: (id: string) => Promise<void>;
	readonly env: Env;
	readonly skills: SkillStore;
	readonly files: Files;
	readonly roleOf: (session: string) => Role;
	readonly watchHost: WatchHost;
	readonly registry: import("@earendil-works/pi-durable").Registry<import("@earendil-works/pi-durable").ToolRegistration>;
	readonly migrateAlwaysApproved: () => void;
	readonly services: () => PimServices;
	readonly extensions: PimExtensions;
	readonly note: (event: string, fields: Record<string, unknown>) => void;
	readonly reinstallApprovals: () => void;
	readonly providersChanged: () => Promise<void>;
	readonly artifacts: ArtifactStore;
	readonly notes: NoteStore;
	readonly assertOpen: () => void;
	readonly agents: AgentStore;
}

export class Connectors {
	constructor(private readonly host: ConnectorsHost) {}

	/**
	 * Connects one of the directory's connectors. A failed connection leaves
	 * nothing behind; `authUrl` is set when the user must sign in.
	 */
	async connectApp(app: DirectoryApp, options: { approval?: McpApproval } = {}): Promise<{ id: string; state: string; authUrl?: string }> {
		const { name, url } = app;
		// A connection is the connector's, found by its server: another connector with the same name gets one of its own.
		let id = slug(name);
		const existing = serverFor(this.host.apps.servers(), app);
		if (existing) id = existing.id;
		else if (this.host.apps.servers().some((server) => server.id === id)) id = `${id.slice(0, 15)}_${crypto.randomUUID().slice(0, 8)}`;
		if (existing && ["connecting", "connected", "discovering"].includes(existing.state)) {
			// Signed in, and the connection is being finished: clearing it would throw the sign-in away and ask for another.
			await this.host.mcp.waitForConnections({ timeout: 20_000 }).catch(() => undefined);
			const now = serverFor(this.host.apps.servers(), app);
			if (now?.state === "ready") {
				if (!this.host.catalog.known(id)) await this.host.catalog.refresh(id).catch((error) => console.warn(`reading ${id}'s catalog failed`, error));
				this.installApps();
				return { id, state: "ready" };
			}
			if (now && now.state !== "failed") return { id, state: now.state };
		}
		if (existing && existing.state !== "ready") {
			// A connection that failed, or is still waiting for sign-in (an abandoned or expired one), is not connected: clear it so the user can try again.
			await this.disconnect(id);
		} else if (existing) {
			throw new HttpError(409, `${name} is already connected`);
		}
		this.host.store.setMcpApproval(id, options.approval ?? "writes");
		try {
			if (url === null) return await this.host.nativeApps.connect(app.ref, id);
			const result = await this.host.addMcpServer(name, url, {
				id,
				// The owner in the path tells the Worker whose space the sign-in returns to.
				callbackPath: `${MCP_CALLBACK_PATH}/${this.host.name}`,
			});
			if (result.state === "ready") {
				await this.host.catalog.refresh(id).catch((error) => console.warn(`reading ${id}'s catalog failed`, error));
			}
			this.installApps();
			return result;
		} catch (error) {
			await this.disconnect(id);
			throw new HttpError(502, `Could not connect ${name}: ${errorMessage(error)}`);
		}
	}

	/** Ends a connection, MCP or native, and forgets its approval policy. */
	async disconnect(id: string): Promise<void> {
		if (!(await this.host.nativeApps.remove(id))) await this.host.removeMcpServer(id).catch(() => undefined);
		this.host.store.deleteMcpApproval(id);
	}

	/** The deployment's secrets a native connector names, from the Worker's environment. */
	secrets(app: NativeAppDefinition): Record<string, string> {
		return this.env(app.secrets ?? []);
	}

	/** Those of the Worker's environment variables that are set. */
	env(names: readonly string[]): Record<string, string> {
		const env = this.host.env as unknown as Record<string, unknown>;
		return Object.fromEntries(names.flatMap((name) => (typeof env[name] === "string" && env[name] !== "" ? [[name, env[name] as string]] : [])));
	}

	#appExtras(services: PimServices) {
		return {
			catalog: this.host.catalog,
			tools: [...skillTools(this.host.apps, this.host.catalog, this.host.skills, this.host.files, this.builtinOn("notes") ? [NOTES_SKILL] : []), ...eventTools(
					this.host.apps,
					this.host.catalog,
					(session) => this.appsOf(this.host.roleOf(session).agent),
					() => ownToolPermission(this.host.store, WATCH_APP_EVENT).chosen === "off",
					this.host.watchHost,
				)],
		};
	}

	/** Rebuilds the connectors' extensions, once pi's registry has been set up. */
	installApps(): void {
		if (!this.host.registry.snapshot().extension("pim.apps")) return;
		this.host.migrateAlwaysApproved();
		// Same names: each replaces its installed extension in place, keeping the order.
		const apps = this.appExtensions(this.host.services());
		this.host.registry.install(apps.apps);
		this.installAppTools(apps.tools);
	}

	appExtensions(services: PimServices) {
		return mcpExtensions(
			this.host.apps,
			services,
			this.#appExtras(services),
			(session) => this.appsOf(this.host.roleOf(session).agent),
			() => this.appDirectory(),
			(session, server, tool) => agentToolPermission(this.host.store, this.host.roleOf(session).agent.id, server, tool).permission,
		);
	}

	/** Installs each ready connector's tools as its own extension, and takes out those of connectors that no longer are. */
	installAppTools(tools: readonly Extension[]): void {
		const names = new Set(tools.map((extension) => extension.name));
		for (const extension of this.host.registry.snapshot().installed()) {
			if (extension.name.startsWith(APP_PREFIX) && !names.has(extension.name)) this.host.registry.uninstall(extension);
		}
		for (const extension of tools) this.host.registry.install(extension);
	}

	/** The connectors an agent works with: those it lists. */
	appsOf(agent: Agent): DirectoryApp[] {
		const directory = this.appDirectory();
		return [...new Set(agent.apps)].flatMap((ref) => directory.find((app) => app.ref === ref) ?? []);
	}

	/** The connectors people on this deployment can connect: the extensions', then the admin's, as last read from the gallery. */
	appDirectory(): DirectoryApp[] {
		const custom = this.host.store.meta(CUSTOM_APPS_KEY);
		return appDirectory(this.host.extensions.list(), custom === undefined ? [] : (JSON.parse(custom) as CustomApp[])).filter((app) => {
			// An extension's connector is offered once the deployment set every secret it needs.
			const names = secretsOf(this.host.extensions.app(app.ref));
			return names.every((name) => name in this.env(names));
		});
	}

	#customAppsReadAt = 0;

	/** The read of the gallery in flight, if any, and whether a request has waited for it as long as one waits. */
	#customAppsRead: { readonly done: Promise<void>; slow: boolean } | undefined;

	/** The read that starts once the one in flight ends, for callers that need what the gallery says from now on. */
	#customAppsNext: Promise<void> | undefined;

	/**
	 * Reads the admin's connectors and model providers from the gallery again, and
	 * whether the owner is the admin from the directory, at most once a minute
	 * unless `now`. It waits for the read at most `CUSTOM_APPS_WAIT_MS`: a slow
	 * gallery leaves what was read before until the read ends.
	 */
	async refreshCustomApps(now = false): Promise<void> {
		if (!now && Date.now() - this.#customAppsReadAt < CUSTOM_APPS_TTL_MS) return;
		this.#customAppsReadAt = Date.now();
		// One read at a time, so a stuck gallery holds one read rather than one per request.
		// A read asked for `now` may need a change made after the one in flight began: it reads again after it.
		const current = this.#customAppsRead;
		const read = !current
			? this.#startCustomAppsRead().done
			: !now
				? current.done
				: (this.#customAppsNext ??= current.done.then(() => {
						this.#customAppsNext = undefined;
						return (this.#customAppsRead ?? this.#startCustomAppsRead()).done;
					}));
		// A read that kept one request waiting as long as it may keeps no other waiting.
		if (current?.slow || (await within(read, CUSTOM_APPS_WAIT_MS))) return;
		if (this.#customAppsRead) this.#customAppsRead.slow = true;
		this.host.note("slow_refresh", { ms: CUSTOM_APPS_WAIT_MS, done: false });
	}

	#startCustomAppsRead(): { readonly done: Promise<void>; slow: boolean } {
		const started = Date.now();
		const read = {
			slow: false,
			done: this.#readCustomApps().finally(() => {
				this.#customAppsRead = undefined;
				const ms = Date.now() - started;
				if (ms > CUSTOM_APPS_WAIT_MS) this.host.note("slow_refresh", { ms, done: true });
			}),
		};
		this.#customAppsRead = read;
		return read;
	}

	/** The read itself, which never throws: a failure leaves what was read before. */
	async #readCustomApps(): Promise<void> {
		try {
			const gallery = this.host.env.Gallery.getByName("gallery");
			// The directory failing to answer leaves what it said before.
			const [apps, providers, admin, off] = await Promise.all([
				gallery.customApps(),
				gallery.sharedProviders(),
				this.#ownerIsAdmin().catch(() => null),
				gallery.disabledBuiltinApps(),
			]);
			const custom = JSON.stringify(apps);
			if (custom !== this.host.store.meta(CUSTOM_APPS_KEY)) this.host.store.setMeta(CUSTOM_APPS_KEY, custom);
			const disabled = JSON.stringify(off);
			if (disabled !== (this.host.store.meta(DISABLED_BUILTIN_APPS_KEY) ?? "[]")) {
				this.host.store.setMeta(DISABLED_BUILTIN_APPS_KEY, disabled);
				this.#builtinAppsChanged();
			}
			if (admin !== null && (admin ? "1" : "0") !== this.host.store.meta(OWNER_ADMIN_KEY)) {
				this.host.store.setMeta(OWNER_ADMIN_KEY, admin ? "1" : "0");
				this.host.reinstallApprovals();
			}
			const shared = JSON.stringify(providers);
			if (shared !== (this.host.store.meta(SHARED_PROVIDERS_KEY) ?? "[]")) {
				this.host.store.setMeta(SHARED_PROVIDERS_KEY, shared);
				await this.host.providersChanged();
			}
		} catch (error) {
			console.warn("reading the admin's connectors and providers failed", error);
		}
	}

	/** Whether the admin left one of Pim's built-in apps on, as this space last read it. */
	builtinOn(id: string): boolean {
		return !(JSON.parse(this.host.store.meta(DISABLED_BUILTIN_APPS_KEY) ?? "[]") as string[]).includes(id);
	}

	/** Notes' tools and prompt section, or nothing in their place while the admin has Notes off. */
	installNotes(): void {
		this.host.registry.install(
			this.builtinOn("notes")
				? notesExtension({ artifacts: this.host.artifacts, notes: this.host.notes, assertOpen: () => this.host.assertOpen() })
				: defineExtension({ name: "pim.notes" }),
		);
	}

	/**
	 * The admin turned a built-in app on or off: its tools, prompt section and
	 * skill come or go from the next request, in chats begun before too. The
	 * person's notes stay theirs to open, change and export either way.
	 */
	#builtinAppsChanged(): void {
		if (!this.host.registry.snapshot().extension("pim.approvals")) return;
		this.installNotes();
		this.installApps();
	}

	/** Whether this space's owner runs this Pim, as the directory says now. */
	async #ownerIsAdmin(): Promise<boolean> {
		const account = await this.host.env.Directory.getByName("directory").account(this.host.name);
		return account?.role === "admin" && account.status === "active";
	}

	/**
	 * The admin's majordomo adds a remote MCP server to this Pim's connectors, as
	 * the admin does in Connectors → Create new connector (`POST /admin/apps`), and gets
	 * it back from the directory. A server the directory has already is that
	 * connector, whoever added it.
	 */
	async addCustomApp(input: { name: string; url: string; description?: string }): Promise<DirectoryApp> {
		if (!(await this.#ownerIsAdmin())) throw new Error("Only this Pim's admin adds connectors to it.");
		const url = input.url.trim();
		await this.refreshCustomApps(true);
		let app = this.appDirectory().find((candidate) => candidate.url === url);
		if (!app) {
			const added = await this.host.env.Gallery.getByName("gallery").addCustomApp({ name: input.name, url, description: input.description });
			console.log(JSON.stringify({ event: "pim.app_added", app: added.id, by: this.host.name }));
			await this.refreshCustomApps(true);
			app = this.appDirectory().find((candidate) => candidate.ref === `${CUSTOM_APPS}/${added.id}`);
		}
		if (!app) throw new Error(`${input.name} was added to this Pim, but this space doesn't see it yet. Try again in a minute.`);
		return app;
	}

	/** Connectors given through the API must be in the directory. */
	checkApps<T extends { apps: readonly string[] }>(input: T): T {
		const directory = this.appDirectory();
		const missing = input.apps.find((ref) => !directory.some((app) => app.ref === ref));
		if (missing) throw new HttpError(400, `This Pim offers no connector ${missing}`);
		return input;
	}

	/** One of the person's skills, or 404. */
	skill(name: string) {
		const skill = SKILL_NAME.test(name) ? this.host.skills.get(name) : undefined;
		if (!skill) throw new HttpError(404, `No skill ${name}`);
		return skill;
	}

	/** The agents that use a skill. */
	skillAgents(name: string) {
		return this.host.agents
			.list()
			.filter((agent) => agent.skills.includes(name))
			.map(({ id, name: agentName }) => ({ id, name: agentName }));
	}

	/** A skill as its latest version, with the versions kept and the agents that use it. */
	describeSkill(name: string) {
		return { ...this.skill(name), history: this.host.skills.history(name), agents: this.skillAgents(name) };
	}

	/** Skills given through the API must be the person's. */
	checkSkills<T extends { skills: readonly string[] }>(input: T): T {
		const missing = input.skills.find((name) => !this.host.skills.has(name));
		if (missing) throw new HttpError(400, `You have no skill ${missing}`);
		return input;
	}

	/** The extensions of the connectors an agent works with. */
	appExtensionsOf(agent: Agent): string[] {
		const servers = this.host.apps.servers();
		return this.appsOf(agent).flatMap((app) => {
			const server = serverFor(servers, app);
			return server ? [appExtensionName(server.id)] : [];
		});
	}

	/**
	 * Extensions only some conversations select: connectors, by the agents that list
	 * them; reviews', by the majordomo's reviews; and triggers' tools, with
	 * the computer triggers' grant tool, by chats while the space's triggers
	 * are on.
	 */
	perPim(name: string): boolean {
		return name.startsWith(APP_PREFIX) || name === REVIEW_EXTENSION || name === COMPUTER_GRANT_EXTENSION || name === TRIGGERS_EXTENSION;
	}
}
