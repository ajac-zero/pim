import { coding } from "./src/extensions/coding";
import { definePimConfig } from "./src/extensions/define";
import { gmail } from "./src/extensions/gmail";
import { googleExtension } from "./src/extensions/google";
import { googleDrive } from "./src/extensions/google-drive";
import { hostOps } from "./src/extensions/hostops";
import { metaAdmin } from "./src/extensions/meta-admin";
import { metaAdmin } from "./src/extensions/meta-admin";
import { metaDiagnostics } from "./src/extensions/meta-diagnostics";
import { metaUi } from "./src/extensions/meta-ui";
import { popularApps } from "./src/extensions/popular-apps";
import { spotifyExtension } from "./src/extensions/spotify";

/**
 * This deployment's extensions: the apps people connect, the widgets
 * their chats show, and abilities for every agent. Add an extension's import to the list and deploy;
 * take one out and nobody has it anymore. See docs/extensions.md.
 *
 * Pim's own abilities (goals, schedules, memory, apps) are always
 * installed, with their widgets, and so are Pim's own color themes: they
 * aren't listed here.
 */
export default definePimConfig({
	// GitHub is offered once GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set (see src/extensions/popular-apps.ts),
	// and Spotify once SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are (see src/extensions/spotify.ts).
	// Gmail and Google Drive each need an OAuth client in a Google Cloud project of its own, and APP_CREDENTIALS_KEY
	// (see "Connectors" in docs/reference.md); until they are set, nobody is offered them.
	// Coding threads need a workspace backend (see "Workspaces for coding threads" in docs/reference.md) and, to push, a GitHub App.
	// Host operations are offered only to the admin's majordomo, and need the host daemon (see docs/host-ops.md).
	extensions: [popularApps, spotifyExtension, googleExtension([gmail, googleDrive]), coding, hostOps, metaAdmin, metaDiagnostics, metaUi],
	// The color theme people see until they pick another: a theme's id, Pim's own (src/extensions/themes) or an extension's.
	defaultTheme: "tokyo-night",
});
