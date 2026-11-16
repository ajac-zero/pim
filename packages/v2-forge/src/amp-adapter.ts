// The real Amp wiring: `AmpHttpOrbClient` with a PostgreSQL durable store and the person's Amp key from the vault, and an attachment fetcher that checks what it downloaded before it is mirrored into Objects.
import { fetchAmpImage } from "@pim/coding/orb/amp-attachments";
import { AmpHttpOrbClient, type AmpConnect, type AmpHttpStore } from "@pim/coding/orb/amp-http";
import { type Db, type Row } from "./db";
import { type AttachmentFetcher, type OrbClients } from "./ports";
import { type ForgeVault } from "./vault";

/** AmpHttpOrbClient's durable store: the start reservation (`claim` inserts only when absent, so two workers can't both start), the orb handle, retry and progress records. A null value is absent. */
export class PgAmpStore implements AmpHttpStore {
	constructor(private readonly db: Db) {}
	async get(key: string): Promise<unknown> {
		const r = (await this.db.query<Row>("select value from pim_forge.forge_amp_kv where key = $1", [key])).rows[0];
		return r ? r.value : null;
	}
	async put(key: string, value: unknown): Promise<void> {
		if (value === null || value === undefined) await this.db.query("delete from pim_forge.forge_amp_kv where key = $1", [key]);
		else await this.db.query("insert into pim_forge.forge_amp_kv (key, value) values ($1, $2) on conflict (key) do update set value = $2, updated_at = now()", [key, JSON.stringify(value)]);
	}
	async claim(key: string, value: unknown): Promise<boolean> {
		const r = await this.db.query("insert into pim_forge.forge_amp_kv (key, value) values ($1, $2) on conflict (key) do nothing", [key, JSON.stringify(value)]);
		return (r.rowCount ?? 0) > 0;
	}
}

export type AmpWiring = { db: Db; vault: ForgeVault; baseUrl?: string; fetch?: typeof fetch; connect?: AmpConnect; now?: () => number };

/** The orb client for a thread: Amp's internal API with the thread owner's own key. `null` when the person has connected none. */
export function ampOrbClients(w: AmpWiring): OrbClients {
	const store = new PgAmpStore(w.db);
	return (thread) =>
		new AmpHttpOrbClient({ store, token: () => w.vault.loadApiKey(thread.ownerId, "amp"), baseUrl: w.baseUrl, fetch: w.fetch, connect: w.connect, now: w.now });
}

const IMAGE_MAX = 10 * 1024 * 1024;
const VIDEO_MAX = 100 * 1024 * 1024;
export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"] as const;

/** What the first bytes say a file is, regardless of what the server called it. */
export function sniff(b: Uint8Array): (typeof ATTACHMENT_TYPES)[number] | null {
	const at = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
	if (b[0] === 0x89 && at(1, "PNG")) return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (at(0, "GIF8")) return "image/gif";
	if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
	if (at(4, "ftyp")) return "video/mp4";
	if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
	return null;
}

/** Downloads an Amp attachment as the thread owner's Amp login (which goes to Amp alone), and accepts it only when its bytes are what its type says. */
export function ampAttachmentFetcher(w: AmpWiring): AttachmentFetcher {
	return async (canonical, thread) => {
		const token = await w.vault.loadApiKey(thread.ownerId, "amp");
		if (!token) return "retry";
		const got = await fetchAmpImage(canonical, { token, baseUrl: w.baseUrl, types: ATTACHMENT_TYPES, maxBytes: (type) => (type.startsWith("video/") ? VIDEO_MAX : IMAGE_MAX), fetch: w.fetch });
		if (!got.ok) return got.retry ? "retry" : null;
		const real = sniff(got.bytes);
		return real !== null && real === got.type ? { bytes: got.bytes, type: got.type } : null;
	};
}
