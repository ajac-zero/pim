import { CUSTOM_APPS, type PimExtension } from "./define";

/**
 * The apps people can connect: those the installed extensions bring, and
 * those the admin adds, named `custom/<app>`. Agents, blueprints and
 * templates list apps by name (`<extension>/<app>`), never by URL, so every
 * agent of a person's that lists an app works with the one connection they
 * made, and nobody connects a server the deployment doesn't offer.
 */

/** An app the admin added: a remote MCP server anyone on this Pim can connect, named `custom/<id>`. */
export type CustomApp = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly url: string;
};

export type DirectoryApp = {
	/** `<extension>/<app>`, or `custom/<app>` for the admin's. */
	readonly ref: string;
	readonly name: string;
	readonly description: string;
	/** Its remote MCP server. */
	readonly url: string;
	/** Added by the admin, not brought by an extension. */
	readonly custom: boolean;
};

const MAX_FOUND = 8;

/** The extensions' apps, then the admin's. */
export function appDirectory(extensions: readonly PimExtension[], custom: readonly CustomApp[]): DirectoryApp[] {
	return [
		...extensions.flatMap((extension) =>
			(extension.apps ?? []).map(({ id, name, description, url }) => ({ ref: `${extension.id}/${id}`, name, description, url, custom: false })),
		),
		...custom.map(({ id, name, description, url }) => ({ ref: `${CUSTOM_APPS}/${id}`, name, description, url, custom: true })),
	];
}

/**
 * An agent's or template's apps as stored. Before the directory, each was
 * `{ name, url }`: one is kept as the directory's app at its URL, and left
 * out when the directory has none (the admin can add it, and it comes back).
 */
export function storedApps(entries: readonly unknown[], directory: () => readonly DirectoryApp[]): string[] {
	return entries.flatMap((entry) => {
		if (typeof entry === "string") return [entry];
		const url = (entry as { url?: unknown } | null)?.url;
		const ref = directory().find((app) => app.url === url)?.ref;
		return ref ? [ref] : [];
	});
}

/** Words of a query or name, for matching. */
function words(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 1);
}

/** The apps a query names: those whose name has its words first, then those whose description does. */
export function findApps(directory: readonly DirectoryApp[], query: string): DirectoryApp[] {
	const wanted = words(query);
	const rank = (app: DirectoryApp) => {
		const name = words(app.name);
		if (name.join(" ") === wanted.join(" ")) return 0;
		if (wanted.every((word) => name.includes(word))) return 1;
		if (wanted.some((word) => name.includes(word))) return 2;
		const description = words(app.description);
		return wanted.some((word) => description.includes(word)) ? 3 : undefined;
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

/** The apps found, as the model reads them. */
export function describeFound(query: string, found: readonly DirectoryApp[]): string {
	if (found.length === 0) {
		return `No app on this Pim matches "${query}". Only the apps this Pim offers can be connected: tell the person, and that its admin can add one.`;
	}
	return [
		`Apps on this Pim matching "${query}":`,
		...found.map((app) => `- ${app.name} [id: ${app.ref}]${app.description ? `: ${app.description}` : ""}`),
		"Use manage_apps if available to request adding one by its id, with the person's approval. If app management is off, explain how they can add it in Your agents.",
	].join("\n");
}
