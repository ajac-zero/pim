import { type AppCategory, CUSTOM_APPS, isNativeApp, type PimExtension, type Text } from "./define";

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
	/** Its site's icon, found when the admin added it. */
	readonly icon: string | null;
	readonly category: AppCategory | null;
};

export type DirectoryApp = {
	/** `<extension>/<app>`, or `custom/<app>` for the admin's. */
	readonly ref: string;
	readonly name: string;
	readonly description: string;
	/** Its remote MCP server; null for an app its extension implements. */
	readonly url: string | null;
	/** Added by the admin, not brought by an extension. */
	readonly custom: boolean;
	/** An https or `data:` image URL; null shows its initial. */
	readonly icon: string | null;
	/** Null files it under Other. */
	readonly category: AppCategory | null;
	/** The app's page for the person once connected (`NativeAppDefinition.page`), and what its button says; absent for none. */
	readonly page?: { readonly url: string; readonly label: Text };
};

const MAX_FOUND = 8;

/** The extensions' apps, then the admin's. */
export function appDirectory(extensions: readonly PimExtension[], custom: readonly CustomApp[]): DirectoryApp[] {
	return [
		...extensions.flatMap((extension) =>
			(extension.apps ?? []).map((app) => ({
				ref: `${extension.id}/${app.id}`,
				name: app.name,
				description: app.description,
				url: isNativeApp(app) ? null : app.url,
				custom: false,
				icon: app.icon ?? null,
				category: app.category ?? null,
				...(isNativeApp(app) && app.page ? { page: { url: `/app-pages/${extension.id}/${app.id}`, label: app.pageLabel ?? { en: "Open", es: "Abrir" } } } : {}),
			})),
		),
		...custom.map(({ id, name, description, url, icon, category }) => ({ ref: `${CUSTOM_APPS}/${id}`, name, description, url, custom: true, icon, category })),
	];
}

/**
 * The icon of the site an MCP server belongs to, from the home page of its
 * host, or else of its parent domain (mcp.notion.com is notion.com's), after
 * redirects: an SVG `<link rel="icon">` first, then the largest, then its
 * `/favicon.ico`. Null when none is an image.
 */
export async function findSiteIcon(server: string): Promise<string | null> {
	const get = (url: string | URL, accept: string) => fetch(url, { headers: { accept }, signal: AbortSignal.timeout(5000) });
	const host = new URL(server).hostname;
	const parent = host.split(".").length > 2 ? host.slice(host.indexOf(".") + 1) : null;
	for (const site of parent ? [host, parent] : [host]) {
		let home = new URL(`https://${site}/`);
		const links: { href: string; rank: number }[] = [];
		try {
			const page = await get(home, "text/html");
			home = new URL(page.url || home);
			if (page.ok && (page.headers.get("content-type") ?? "").includes("text/html")) {
				const html = (await page.text()).slice(0, 500_000);
				for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
					const attribute = (name: string) => {
						const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
						return (match?.[1] ?? match?.[2] ?? match?.[3])?.replaceAll("&amp;", "&");
					};
					const href = attribute("href");
					if (!href || !/(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(attribute("rel") ?? "")) continue;
					const svg = attribute("type") === "image/svg+xml" || /\.svg($|\?)/i.test(href);
					const size = Math.max(0, ...(attribute("sizes") ?? "").split(/\s+/).map((size) => Number.parseInt(size, 10) || 0));
					links.push({ href: new URL(href, home).href, rank: svg ? Number.POSITIVE_INFINITY : size });
				}
			} else await page.body?.cancel();
		} catch {
			// No home page: its favicon may still be there.
		}
		const candidates = [...links.sort((a, b) => b.rank - a.rank).map((link) => link.href), new URL("/favicon.ico", home).href];
		for (const candidate of new Set(candidates)) {
			if (!candidate.startsWith("https://")) continue;
			try {
				const response = await get(candidate, "image/*");
				await response.body?.cancel();
				if (response.ok && (response.headers.get("content-type") ?? "").startsWith("image/")) return candidate;
			} catch {
				// Try the next.
			}
		}
	}
	return null;
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
		return `No app on this Pim matches "${query}". Only the apps this Pim offers can be connected: tell the person, and that its admin can add one. If you have add_custom_app, the person is its admin: ask for the app's MCP server URL and add it.`;
	}
	return [
		`Apps on this Pim matching "${query}":`,
		...found.map((app) => `- ${app.name} [id: ${app.ref}]${app.description ? `: ${app.description}` : ""}`),
		"Use manage_apps if available to request adding one by its id, with the person's approval. If app management is off, explain how they can add it in Your agents.",
	].join("\n");
}
