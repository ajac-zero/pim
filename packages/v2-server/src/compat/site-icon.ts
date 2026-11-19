/**
 * The icon of the site a connector's MCP server belongs to (v1's `findSiteIcon`), for a custom connector the admin adds without one: from the home page of the server's host,
 * or else of its parent domain (mcp.notion.com is notion.com's), after redirects: an SVG `<link rel="icon">` first, then the largest, then `/favicon.ico`. Null when none is an image.
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
					const size = Math.max(0, ...(attribute("sizes") ?? "").split(/\s+/).map((s) => Number.parseInt(s, 10) || 0));
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
