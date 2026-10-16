import { Type } from "@earendil-works/pi-ai";
import { type AppToolContext, defineAppTool, definePimExtension, oauth2 } from "./define";

/**
 * Spotify, which has no MCP server of its own: an app this extension
 * implements, with Spotify's OAuth sign-in and its Web API. Offered once
 * the deployment sets `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, from
 * an app made at developer.spotify.com whose redirect URI is this Pim's
 * `/mcp/callback/apps`.
 */

const API = "https://api.spotify.com/v1";

type Artist = { name: string };
type Track = { name: string; uri: string; duration_ms: number; artists: Artist[]; album: { name: string } };

const byline = (track: Track) => `${track.artists.map((artist) => artist.name).join(", ")} · ${track.album.name}`;

/** A Web API call with the person's token: its JSON, null for an empty answer, or a throw with Spotify's reason. */
async function spotify<T>(context: AppToolContext, path: string, init: RequestInit = {}): Promise<T | null> {
	const response = await fetch(`${API}${path}`, {
		...init,
		headers: { authorization: `Bearer ${context.credential.accessToken}`, "content-type": "application/json", ...init.headers },
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
		throw new Error(`Spotify: ${body.error?.message ?? response.statusText}`);
	}
	return response.status === 204 || response.headers.get("content-length") === "0" ? null : ((await response.json()) as T);
}

const nowPlaying = defineAppTool({
	name: "now_playing",
	description: "What the person is playing on Spotify now, and how far into it.",
	parameters: Type.Object({}),
	readOnly: true,
	async execute(_args, context) {
		const playing = await spotify<{ is_playing: boolean; progress_ms: number; item: Track | null }>(context, "/me/player/currently-playing");
		if (!playing?.item) return "Nothing is playing.";
		const track = playing.item;
		return {
			text: `${playing.is_playing ? "Playing" : "Paused"}: ${track.name} by ${byline(track)} (${Math.round(playing.progress_ms / 1000)}s of ${Math.round(track.duration_ms / 1000)}s).`,
			widget: {
				title: { en: "Now playing", es: "Sonando ahora" },
				kind: "progress",
				items: [{ title: track.name, detail: byline(track), value: Math.round(playing.progress_ms / 1000), max: Math.round(track.duration_ms / 1000) }],
			},
		};
	},
});

const search = defineAppTool({
	name: "search",
	description: "Search Spotify for tracks. Each result has the URI `play` takes.",
	parameters: Type.Object({ query: Type.String({ minLength: 1 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
	readOnly: true,
	async execute({ query, limit }, context) {
		const params = new URLSearchParams({ q: query, type: "track", limit: String(limit ?? 5) });
		const found = await spotify<{ tracks: { items: Track[] } }>(context, `/search?${params}`);
		const tracks = found?.tracks.items ?? [];
		if (tracks.length === 0) return `No tracks match "${query}".`;
		return {
			text: tracks.map((track) => `- ${track.name} by ${byline(track)} [${track.uri}]`).join("\n"),
			widget: { title: { en: `Tracks for “${query}”`, es: `Canciones para «${query}»` }, kind: "list", items: tracks.map((track) => ({ title: track.name, detail: byline(track) })) },
		};
	},
});

const play = defineAppTool({
	name: "play",
	description: "Play tracks, by their URIs from search, on the person's active device; without any, resume what was playing.",
	parameters: Type.Object({ uris: Type.Optional(Type.Array(Type.String({ pattern: "^spotify:track:" }), { maxItems: 50 })) }),
	async execute({ uris }, context) {
		await spotify(context, "/me/player/play", { method: "PUT", body: JSON.stringify(uris?.length ? { uris } : {}) });
		return uris?.length ? `Playing ${uris.length} track${uris.length === 1 ? "" : "s"}.` : "Resumed.";
	},
});

const pause = defineAppTool({
	name: "pause",
	description: "Pause playback on the person's active device.",
	parameters: Type.Object({}),
	async execute(_args, context) {
		await spotify(context, "/me/player/pause", { method: "PUT" });
		return "Paused.";
	},
});

/** Spotify's mark, from Simple Icons (CC0), in its green. */
const LOGO =
	'<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#1DB954" d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>';

export const spotifyExtension = definePimExtension({
	id: "spotify",
	name: "Spotify",
	description: "Music on Spotify, without an MCP server.",
	apps: [
		{
			id: "spotify",
			name: "Spotify",
			description: "What's playing, search, and playback on your devices.",
			icon: `data:image/svg+xml,${encodeURIComponent(LOGO)}`,
			secrets: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
			...oauth2({
				authorizeUrl: "https://accounts.spotify.com/authorize",
				tokenUrl: "https://accounts.spotify.com/api/token",
				scopes: ["user-read-currently-playing", "user-read-playback-state", "user-modify-playback-state"],
				clientId: "SPOTIFY_CLIENT_ID",
				clientSecret: "SPOTIFY_CLIENT_SECRET",
			}),
			tools: [nowPlaying, search, play, pause],
		},
	],
});
