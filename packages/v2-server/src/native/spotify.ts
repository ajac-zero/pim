import { Type } from "@earendil-works/pi-ai";
import { call } from "./http.ts";
import type { NativeApp, NativeTool, ToolContext } from "./native.ts";

/**
 * Spotify, which has no MCP server of its own: its OAuth sign-in and its Web API. Offered once `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are set, from an app made at
 * developer.spotify.com whose redirect URI is this Pim's `/mcp/callback/apps`.
 */

type Artist = { name: string };
type Track = { name: string; uri: string; duration_ms: number; artists: Artist[]; album: { name: string } };

const byline = (track: Track) => `${track.artists.map((artist) => artist.name).join(", ")} · ${track.album.name}`;

/** A Web API call with the person's token: its JSON, null for an empty answer, or a throw with Spotify's reason. */
async function spotify<T>(c: ToolContext, path: string, init: { method?: string; body?: string } = {}): Promise<T | null> {
	const base = c.endpoints.spotifyApi;
	const response = await call("Spotify", c.fetch, c.bearer, `${base}${path}`, base, { ...init, headers: { "content-type": "application/json" }, idempotent: true });
	if (response.status === 204 || response.headers.get("content-length") === "0") return null;
	const text = await response.text();
	return text ? (JSON.parse(text) as T) : null;
}

const nowPlaying: NativeTool = {
	name: "now_playing",
	description: "What the person is playing on Spotify now, and how far into it.",
	parameters: Type.Object({}),
	readOnly: true,
	async execute(_args, c) {
		const playing = await spotify<{ is_playing: boolean; progress_ms: number; item: Track | null }>(c, "/me/player/currently-playing");
		if (!playing?.item) return "Nothing is playing.";
		const track = playing.item;
		return `${playing.is_playing ? "Playing" : "Paused"}: ${track.name} by ${byline(track)} (${Math.round(playing.progress_ms / 1000)}s of ${Math.round(track.duration_ms / 1000)}s).`;
	},
};

const search: NativeTool = {
	name: "search",
	description: "Search Spotify for tracks. Each result has the URI `play` takes.",
	parameters: Type.Object({ query: Type.String({ minLength: 1 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
	readOnly: true,
	async execute({ query, limit }, c) {
		const params = new URLSearchParams({ q: String(query), type: "track", limit: String(limit ?? 5) });
		const found = await spotify<{ tracks: { items: Track[] } }>(c, `/search?${params}`);
		const tracks = found?.tracks.items ?? [];
		if (tracks.length === 0) return `No tracks match "${query}".`;
		return tracks.map((track) => `- ${track.name} by ${byline(track)} [${track.uri}]`).join("\n");
	},
};

const play: NativeTool = {
	name: "play",
	description: "Play tracks, by their URIs from search, on the person's active device; without any, resume what was playing.",
	parameters: Type.Object({ uris: Type.Optional(Type.Array(Type.String({ pattern: "^spotify:track:" }), { maxItems: 50 })) }),
	async execute({ uris }, c) {
		await spotify(c, "/me/player/play", { method: "PUT", body: JSON.stringify(uris?.length ? { uris } : {}) });
		return uris?.length ? `Playing ${uris.length} track${uris.length === 1 ? "" : "s"}.` : "Resumed.";
	},
};

const pause: NativeTool = {
	name: "pause",
	description: "Pause playback on the person's active device.",
	parameters: Type.Object({}),
	async execute(_args, c) {
		await spotify(c, "/me/player/pause", { method: "PUT" });
		return "Paused.";
	},
};

/** Spotify's mark, from Simple Icons (CC0), in its green. */
const LOGO =
	'<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#1DB954" d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>';

export const spotifyApp: NativeApp = {
	ref: "spotify/spotify",
	name: "Spotify",
	description: "What's playing, search, and playback on your devices.",
	icon: `data:image/svg+xml,${encodeURIComponent(LOGO)}`,
	category: "media",
	client: { id: "SPOTIFY_CLIENT_ID", secret: "SPOTIFY_CLIENT_SECRET" },
	scopes: ["user-read-currently-playing", "user-read-playback-state", "user-modify-playback-state"],
	authorizeUrl: (e) => e.spotifyAuth,
	tokenUrl: (e) => e.spotifyToken,
	tools: [nowPlaying, search, play, pause],
};
