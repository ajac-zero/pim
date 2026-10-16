import { assistant } from "./src/extensions/assistant";
import { definePimConfig } from "./src/extensions/define";
import { popularApps } from "./src/extensions/popular-apps";
import { spotifyExtension } from "./src/extensions/spotify";

/**
 * This deployment's extensions: the blueprints people's agents build on, and the widgets
 * their dashboards show. Add an extension's import to the list and deploy;
 * take one out and nobody has it anymore. Agents built on a blueprint that's gone
 * keep their name and the person's own instructions. See docs/extensions.md.
 *
 * Pim's own abilities (goals, schedules, memory, artifacts) are always
 * installed, with their widgets, and so are Pim's own color themes: they
 * aren't listed here.
 */
export default definePimConfig({
	// GitHub is offered once GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set (see src/extensions/popular-apps.ts),
	// and Spotify once SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are (see src/extensions/spotify.ts).
	extensions: [assistant, popularApps, spotifyExtension],
	// The blueprint every new account's first agent builds on, and new agents by default: `<extension>/<blueprint>`, or null for none.
	defaultBlueprint: "pim.assistant/pim",
	// The color theme people see until they pick another: a theme's id, Pim's own (src/extensions/themes) or an extension's.
	defaultTheme: "tokyo-night",
});
