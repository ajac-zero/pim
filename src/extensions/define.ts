/**
 * Pim extensions: what a deployment adds to every person's Pims, chosen in
 * `pim.config.ts`. An extension can bring Pims, named agents with their own
 * instructions, dashboard and conversation starters, and widgets, the cards
 * a dashboard is made of. A person's Pim builds on one extension's Pim (its
 * `base`), and adds their own name and instructions on top.
 *
 * Widgets are declarative: `load` runs in the person's agent and returns
 * data of a known kind, which the web app draws with its own components. No
 * extension code runs in the browser.
 *
 * Pim's own Pim is an extension too (`./assistant.ts`), and its abilities
 * (goals, schedules, memory, artifacts) bring their widgets the same way.
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

export type WidgetContext = {
	/** The Pim whose dashboard shows the widget. */
	readonly pim: { readonly id: string; readonly name: string; readonly default: boolean };
	/**
	 * The person's chat that a conversation is, or works for (a team member's
	 * conversation works for the chat that gave it its task), when that chat
	 * is this Pim's; null otherwise.
	 */
	chatOf(session: string): string | null;
	/** The person's IANA time zone. */
	readonly timeZone: string;
};

export type Widget = {
	readonly title: Text;
	/** Shown when it has nothing to show. */
	readonly empty: Text;
	load(context: WidgetContext): WidgetContent | Promise<WidgetContent>;
};

export type PimDefinition = {
	/** Unique in its extension: the Pim is named `<extension>/<id>`. */
	readonly id: string;
	/** What a person's new Pim built on it is called, until they rename it. */
	readonly name: string;
	readonly description: string;
	/** The model reads these in every chat with a Pim built on this one, before the person's own instructions. */
	readonly instructions: string;
	/** Its dashboard's widgets, in order, each `<extension>/<widget>`. */
	readonly dashboard: readonly string[];
	/** Messages the dashboard offers to start a chat with. */
	readonly starters?: readonly Text[];
};

export type PimExtension = {
	/** Lowercase letters, digits, dots and hyphens. Stored in people's Pims: don't rename it. */
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly widgets?: Readonly<Record<string, Widget>>;
	readonly pims?: readonly PimDefinition[];
};

export type PimConfig = {
	readonly extensions: readonly PimExtension[];
	/** The Pim every new account starts with, and that new Pims build on: `<extension>/<pim>`, or null for none. */
	readonly defaultPim: string | null;
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

/**
 * The extensions installed in this deployment, checked once: ids are unique
 * and well formed, every dashboard names a widget some extension provides,
 * and the default Pim exists. A mistake in `pim.config.ts` fails here, loudly,
 * instead of drawing a broken dashboard.
 */
export class PimExtensions {
	readonly #extensions = new Map<string, PimExtension>();
	readonly defaultPim: string | null;

	constructor(extensions: readonly PimExtension[], defaultPim: string | null) {
		for (const extension of extensions) {
			if (!ID.test(extension.id)) throw new Error(`Extension id ${JSON.stringify(extension.id)} must be lowercase letters, digits, dots and hyphens`);
			if (this.#extensions.has(extension.id)) throw new Error(`Two extensions are called ${extension.id}`);
			this.#extensions.set(extension.id, extension);
			const pims = new Set<string>();
			for (const pim of extension.pims ?? []) {
				if (!ID.test(pim.id) || pims.has(pim.id)) throw new Error(`${extension.id} has a missing, malformed or repeated Pim id ${JSON.stringify(pim.id)}`);
				pims.add(pim.id);
			}
		}
		for (const { ref, pim } of this.pims()) {
			for (const widget of pim.dashboard) {
				if (!this.widget(widget)) throw new Error(`${ref}'s dashboard shows ${widget}, which no installed extension provides`);
			}
		}
		if (defaultPim !== null && !this.pim(defaultPim)) throw new Error(`The default Pim ${defaultPim} isn't in any installed extension`);
		this.defaultPim = defaultPim;
	}

	list(): PimExtension[] {
		return [...this.#extensions.values()];
	}

	/** Every extension's Pims, each with its `<extension>/<pim>` name. */
	pims(): { ref: string; pim: PimDefinition }[] {
		return this.list().flatMap((extension) => (extension.pims ?? []).map((pim) => ({ ref: `${extension.id}/${pim.id}`, pim })));
	}

	pim(ref: string): PimDefinition | undefined {
		const [extension, id] = split(ref);
		return this.#extensions.get(extension)?.pims?.find((pim) => pim.id === id);
	}

	widget(ref: string): Widget | undefined {
		const [extension, id] = split(ref);
		const widgets = this.#extensions.get(extension)?.widgets;
		return widgets && Object.hasOwn(widgets, id) ? widgets[id] : undefined;
	}
}

/** `pim.goals/active` → `["pim.goals", "active"]`: the extension's id has no slash, the rest is the name. */
function split(ref: string): [string, string] {
	const slash = ref.indexOf("/");
	return slash < 0 ? [ref, ""] : [ref.slice(0, slash), ref.slice(slash + 1)];
}
