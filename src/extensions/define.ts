import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import type { Theme } from "../themes";
import type { GatedAction } from "./approvals";

export { defineGatedAction, type GatedAction } from "./approvals";
export { oauth2 } from "./native-apps";

/**
 * Pim extensions: what a deployment adds to every person's agents, chosen in
 * `pim.config.ts`. An extension can bring blueprints, the definitions people's
 * agents build on, each with its own instructions, dashboard and conversation starters; widgets, the cards a
 * dashboard is made of; color themes for the web app; and an ability: tools,
 * prompt sections, hooks and background tasks, plus actions that ask the
 * person first. A person's Pim
 * builds on one extension's blueprint (its `blueprint`), and adds their own name and
 * instructions on top; its chats get the abilities that blueprint uses.
 *
 * Widgets are declarative: `load` runs in the person's Pim and returns
 * data of a known kind, which the web app draws with its own components. No
 * extension code runs in the browser.
 *
 * Pim's own blueprint is an extension too (`./assistant.ts`), its abilities
 * (goals, schedules, memory, artifacts) bring their widgets the same way, and
 * its color themes are one (`./themes`).
 */

/** Text an extension shows people: one string, or one per language, with English always there. */
export type Text = string | { readonly en: string; readonly [locale: string]: string };

/** Where a widget's item leads: one of the person's chats, or an artifact. */
export type WidgetLink = { readonly chat: string } | { readonly artifact: string };

export type ListItem = {
	readonly title: string;
	readonly detail?: string;
	/** ISO 8601: the web app shows it in the person's language and time zone. */
	readonly time?: string;
	readonly link?: WidgetLink;
};

export type ProgressItem = {
	readonly title: string;
	readonly value: number;
	readonly max: number;
	readonly detail?: string;
	readonly link?: WidgetLink;
};

/** What a widget shows, by kind. The web app knows how to draw each kind. */
export type WidgetContent =
	| { readonly kind: "list"; readonly items: readonly ListItem[] }
	| { readonly kind: "progress"; readonly items: readonly ProgressItem[] };

/** An extension's own data in a person's Pim: JSON values by key, apart from every other extension's. */
export type ExtensionData = {
	get<T = unknown>(key: string): T | undefined;
	/** `value` must survive JSON. */
	put(key: string, value: unknown): void;
	delete(key: string): boolean;
	/** Every entry whose key starts with `prefix`, by key. */
	list<T = unknown>(prefix?: string): { key: string; value: T }[];
};

/** What an ability gets from the person's Pim it runs in. */
export type AbilityContext = {
	/** The extension's own data. */
	readonly data: ExtensionData;
	/** The person's IANA time zone, as it is when read. */
	readonly timeZone: string;
	/** Tells the person: a notification in the app, pushed to their devices and webhook. */
	notify(title: string, body: string): Promise<void>;
};

/**
 * What an extension adds to the chats of agents that use it: a pi extension
 * (tools, prompt sections, hooks, wraps, background tasks), plus actions
 * with effects outside the conversation. Each action is a tool that files an
 * approval and runs only once the person says yes, under Settings → Tool
 * permissions like Pim's own.
 */
export type Ability = Omit<Extension, "name"> & { readonly actions?: readonly GatedAction[] };

export type WidgetContext = {
	/** The agent whose dashboard shows the widget. */
	readonly agent: { readonly id: string; readonly name: string; readonly default: boolean };
	/**
	 * The person's chat that a conversation is, or works for (a team member's
	 * conversation works for the chat that gave it its task), when that chat
	 * is this Pim's; null otherwise.
	 */
	chatOf(session: string): string | null;
	/** Whether a conversation is, or works for, one of this agent's chats, including one since deleted. */
	ofAgent(session: string): boolean;
	/** The person's IANA time zone. */
	readonly timeZone: string;
	/** The data of the extension that brings the widget. */
	readonly data: ExtensionData;
};

export type Widget = {
	readonly title: Text;
	/** Shown when it has nothing to show. */
	readonly empty: Text;
	/**
	 * For the model: what it shows. A widget with one can also go with a
	 * message in chat (`send_to_user`'s `widgets`), as it is when sent.
	 */
	readonly description?: string;
	load(context: WidgetContext): WidgetContent | Promise<WidgetContent>;
};

/** A widget as loaded for one Pim: on a dashboard, or kept with a message. Its text is in every language it has. */
export type ShownWidget = { readonly id: string; readonly title: Text; readonly empty: Text } & (WidgetContent | { readonly failed: true });

/**
 * A shown widget as Markdown, for where it can't be drawn: an email, or an
 * API client's reply. Times are UTC, in ISO 8601.
 */
export function widgetMarkdown(widget: ShownWidget, locale = "en"): string {
	const title = `**${localize(widget.title, locale)}**`;
	if ("failed" in widget) return `${title}\n(Couldn't load.)`;
	if (widget.items.length === 0) return `${title}\n${localize(widget.empty, locale)}`;
	const lines =
		widget.kind === "list"
			? widget.items.map((item) => [item.title, item.detail, item.time].filter(Boolean).join(" · "))
			: widget.items.map((item) => [`${item.title} (${item.value}/${item.max})`, item.detail].filter(Boolean).join(" · "));
	return [title, ...lines.map((line) => `- ${line}`)].join("\n");
}

/**
 * An app people connect with their own accounts. It is named
 * `<extension>/<id>`, as blueprints and people's agents list it, and each
 * person connects it once for all of their agents. It is a remote MCP
 * server, or the extension implements it: its sign-in and its tools.
 */
export type AppDefinition = McpAppDefinition | NativeAppDefinition;

type AppIdentity = {
	/** Unique in its extension. Stored in people's agents: don't rename it. */
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** Its logo: an https or `data:` image URL, square, shown on a white tile. Without one, its initial. */
	readonly icon?: string;
};

/** An app that is a remote MCP server. */
export type McpAppDefinition = AppIdentity & {
	/** Its remote MCP server, https. */
	readonly url: string;
};

/** The deployment's secrets an app named in `secrets`, from the Worker's environment. */
export type AppSecrets = Readonly<Record<string, string>>;

/** A person's sign-in to an app, as its `callback` made it: JSON. With `expiresAt` (ms), Pim has `refresh` renew it first. */
export type AppCredential = { readonly expiresAt?: number; readonly [key: string]: unknown };

export type AppSignInContext = {
	/** Where the person comes back after signing in: the same for everyone on this Pim, so it can be registered with the service. */
	readonly callbackUrl: string;
	/** Send it along; it comes back with the person, as `state`. */
	readonly state: string;
	readonly secrets: AppSecrets;
};

/** A widget a tool's result shows: a title, and data of a kind the web app draws. */
export type ToolWidget = { readonly title: Text } & WidgetContent;

export type AppToolResult = {
	/** What the model reads. */
	readonly text: string;
	/** What the person can be shown: the model adds it to a message. */
	readonly widget?: ToolWidget;
	readonly isError?: boolean;
};

export type AppToolContext = { readonly credential: AppCredential; readonly secrets: AppSecrets };

export type AppTool = {
	/** Lowercase letters, digits and underscores; unique in its app. The model sees it as `<app>_<name>`. */
	readonly name: string;
	readonly description: string;
	/** Its arguments' JSON Schema, such as a TypeBox `Type.Object`. */
	readonly parameters: TSchema;
	/** It only reads: it runs without asking under the default approval policy. Anything else asks first. */
	readonly readOnly?: boolean;
	execute(args: Record<string, unknown>, context: AppToolContext): Promise<string | AppToolResult>;
};

/**
 * An app the extension implements, for a service with no MCP server of its
 * own: its sign-in, run once by each person, and its tools, run in their
 * Pim with their credential. To everything else it is an app like an MCP
 * server: agents list it, tool permissions and approvals cover its tools.
 */
export type NativeAppDefinition = AppIdentity & {
	/** The Worker's environment variables it needs, such as `SPOTIFY_CLIENT_ID`. Without all of them set, nobody is offered it. */
	readonly secrets?: readonly string[];
	/** Where to send the person to sign in, and what to keep until they come back (a PKCE verifier, say). */
	signIn(context: AppSignInContext): Promise<{ readonly url: string; readonly pending?: unknown }>;
	/** The person came back to `url`: their credential, or a throw that says what went wrong. */
	callback(context: AppSignInContext & { readonly url: URL; readonly pending: unknown }): Promise<AppCredential>;
	/** A credential renewed before it expires; without it, the person signs in again. */
	refresh?(credential: AppCredential, context: { readonly secrets: AppSecrets }): Promise<AppCredential>;
	readonly tools: readonly AppTool[];
};

export const isNativeApp = (app: AppDefinition): app is NativeAppDefinition => !("url" in app);

/** Types an app tool's `execute` by its `parameters`. */
export function defineAppTool<T extends TSchema>(
	tool: Omit<AppTool, "parameters" | "execute"> & {
		readonly parameters: T;
		execute(args: Static<T>, context: AppToolContext): Promise<string | AppToolResult>;
	},
): AppTool {
	return tool as unknown as AppTool;
}

export type BlueprintDefinition = {
	/** Unique in its extension: the blueprint is named `<extension>/<id>`. */
	readonly id: string;
	/** What a person's new Pim built on this blueprint is called, until they rename it. */
	readonly name: string;
	readonly description: string;
	/** The model reads these in every chat with a Pim built on this blueprint, before the person's own instructions. */
	readonly instructions: string;
	/** Its dashboard's widgets, in order, each `<extension>/<widget>`. */
	readonly dashboard: readonly string[];
	/**
	 * Other extensions whose abilities its chats get, by id; its own
	 * extension's always. Pim's own abilities (memory, goals, schedules,
	 * artifacts, apps, the web) are every Pim's.
	 */
	readonly abilities?: readonly string[];
	/**
	 * Apps its chats work with, each `<extension>/<app>`. Each person connects
	 * them with their own accounts; a chat gets the tools of the apps its agent
	 * lists here or in the person's own agent, and of no other.
	 */
	readonly apps?: readonly string[];
	/** Messages the dashboard offers to start a chat with. */
	readonly starters?: readonly Text[];
};

export type PimExtension = {
	/** Lowercase letters, digits, dots and hyphens. Stored in people's agents: don't rename it. */
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly widgets?: Readonly<Record<string, Widget>>;
	readonly blueprints?: readonly BlueprintDefinition[];
	/** Color themes people can pick for the web app, in Settings → Appearance. See ../themes.ts. */
	readonly themes?: readonly Theme[];
	/** Apps people can connect, and blueprints and agents list as `<extension>/<app>`. */
	readonly apps?: readonly AppDefinition[];
	/** Built once in each person's Pim. Its tools and actions must be named apart from every other tool. */
	readonly ability?: (context: AbilityContext) => Ability;
};

export type PimConfig = {
	readonly extensions: readonly PimExtension[];
	/** The blueprint every new account's first agent builds on, and new agents by default: `<extension>/<blueprint>`, or null for none. */
	readonly defaultBlueprint: string | null;
	/** The color theme people see until they pick another: a theme's id, Pim's own or an extension's. */
	readonly defaultTheme: string;
};

/** Identity function that types an extension. */
export function definePimExtension(extension: PimExtension): PimExtension {
	return extension;
}

/** Identity function that types a deployment's configuration. */
export function definePimConfig(config: PimConfig): PimConfig {
	return config;
}

/** `text` in `locale`, or in English when the extension didn't translate it. */
export function localize(text: Text, locale: string): string {
	return typeof text === "string" ? text : (text[locale] ?? text.en);
}

const ID = /^[a-z0-9][a-z0-9.-]{0,62}$/;

/** Where the apps the admin adds are named: `custom/<app>`. No extension may take the name. */
export const CUSTOM_APPS = "custom";

/**
 * The extensions installed in this deployment, checked once: ids are unique
 * and well formed, every dashboard names a widget some extension provides,
 * every blueprint's apps are installed apps, and the default blueprint exists.
 * A mistake in `pim.config.ts` fails here, loudly, instead of drawing a broken dashboard.
 */
export class PimExtensions {
	readonly #extensions = new Map<string, PimExtension>();
	readonly defaultBlueprint: string | null;

	constructor(extensions: readonly PimExtension[], defaultBlueprint: string | null) {
		for (const extension of extensions) {
			if (!ID.test(extension.id)) throw new Error(`Extension id ${JSON.stringify(extension.id)} must be lowercase letters, digits, dots and hyphens`);
			if (extension.id === CUSTOM_APPS) throw new Error(`No extension may be called ${CUSTOM_APPS}: the admin's apps are`);
			if (this.#extensions.has(extension.id)) throw new Error(`Two extensions are called ${extension.id}`);
			this.#extensions.set(extension.id, extension);
			const ids = new Set<string>();
			for (const blueprint of extension.blueprints ?? []) {
				if (!ID.test(blueprint.id) || ids.has(blueprint.id)) throw new Error(`${extension.id} has a missing, malformed or repeated blueprint id ${JSON.stringify(blueprint.id)}`);
				ids.add(blueprint.id);
			}
			const apps = new Set<string>();
			for (const app of extension.apps ?? []) {
				const ref = `${extension.id}/${app.id}`;
				if (!ID.test(app.id) || apps.has(app.id)) throw new Error(`${extension.id} has a missing, malformed or repeated app id ${JSON.stringify(app.id)}`);
				if (!app.name.trim()) throw new Error(`${ref} needs a name`);
				if (!isNativeApp(app)) {
					if (!/^https:\/\/\S+$/.test(app.url)) throw new Error(`${ref} needs a name and an https URL`);
				} else {
					const tools = new Set<string>();
					for (const tool of app.tools) {
						if (!/^[a-z0-9_]{1,40}$/.test(tool.name) || tools.has(tool.name)) throw new Error(`${ref} has a missing, malformed or repeated tool name ${JSON.stringify(tool.name)}`);
						tools.add(tool.name);
					}
				}
				apps.add(app.id);
			}
		}
		for (const { ref, blueprint } of this.blueprints()) {
			for (const widget of blueprint.dashboard) {
				if (!this.widget(widget)) throw new Error(`${ref}'s dashboard shows ${widget}, which no installed extension provides`);
			}
			for (const id of blueprint.abilities ?? []) {
				if (!this.#extensions.get(id)?.ability) throw new Error(`${ref} uses the ability of ${id}, which no installed extension brings`);
			}
			for (const app of blueprint.apps ?? []) {
				if (!this.app(app)) throw new Error(`${ref} works with the app ${app}, which no installed extension brings`);
			}
		}
		if (defaultBlueprint !== null && !this.blueprint(defaultBlueprint)) throw new Error(`The default blueprint ${defaultBlueprint} isn't in any installed extension`);
		this.defaultBlueprint = defaultBlueprint;
	}

	list(): PimExtension[] {
		return [...this.#extensions.values()];
	}

	/** Every extension's blueprints, each with its `<extension>/<blueprint>` name. */
	blueprints(): { ref: string; blueprint: BlueprintDefinition }[] {
		return this.list().flatMap((extension) => (extension.blueprints ?? []).map((blueprint) => ({ ref: `${extension.id}/${blueprint.id}`, blueprint })));
	}

	blueprint(ref: string): BlueprintDefinition | undefined {
		const [extension, id] = split(ref);
		return this.#extensions.get(extension)?.blueprints?.find((blueprint) => blueprint.id === id);
	}

	/** The extensions whose abilities the chats of a Pim built on `ref` get: its own extension's, then the ones it names. */
	abilitiesOf(ref: string | null): string[] {
		if (ref === null) return [];
		const blueprint = this.blueprint(ref);
		if (!blueprint) return [];
		const own = split(ref)[0];
		return [...new Set([...(this.#extensions.get(own)?.ability ? [own] : []), ...(blueprint.abilities ?? [])])];
	}

	/** Every extension's apps, each with its `<extension>/<app>` name. */
	apps(): { ref: string; app: AppDefinition }[] {
		return this.list().flatMap((extension) => (extension.apps ?? []).map((app) => ({ ref: `${extension.id}/${app.id}`, app })));
	}

	app(ref: string): AppDefinition | undefined {
		const [extension, id] = split(ref);
		return this.#extensions.get(extension)?.apps?.find((app) => app.id === id);
	}

	widget(ref: string): Widget | undefined {
		const [extension, id] = split(ref);
		const widgets = this.#extensions.get(extension)?.widgets;
		return widgets && Object.hasOwn(widgets, id) ? widgets[id] : undefined;
	}
}

/**
 * Refuses abilities whose tools would take another tool's name: pi lets a
 * later tool replace an earlier one, so an extension could otherwise stand
 * in for `send_to_user` or a tool that asks first.
 */
export function checkToolNames(abilities: readonly { id: string; ability: Ability }[], taken: Iterable<string>): void {
	const owners = new Map<string, string>([...taken].map((name) => [name, "Pim"]));
	for (const { id, ability } of abilities) {
		for (const name of [...(ability.tools ?? []).map((tool) => tool.name), ...(ability.actions ?? []).map((action) => action.name)]) {
			const owner = owners.get(name);
			if (owner !== undefined) throw new Error(`${id} brings a tool named ${name}, which ${owner} already has`);
			owners.set(name, id);
		}
	}
}

/** `pim.goals/active` → `["pim.goals", "active"]`: the extension's id has no slash, the rest is the name. */
function split(ref: string): [string, string] {
	const slash = ref.indexOf("/");
	return slash < 0 ? [ref, ""] : [ref.slice(0, slash), ref.slice(slash + 1)];
}
