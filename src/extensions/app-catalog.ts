import type { PimStore } from "../store";
import type { McpBridge } from "./mcp";

/**
 * What connected apps offer beyond tools, cached per app in the agent's
 * database so prompts render without a network call:
 * - skills, from the MCP Skills extension (`io.modelcontextprotocol/skills`);
 * - event types, from the draft MCP Events extension (`events` capability).
 * An expired entry is still served while a background refresh replaces it.
 */

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** How some implementations name the draft Events extension; the draft itself uses a top-level `events` capability. */
export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";

export type SkillFile = { readonly uri: string; readonly digest: string; readonly size: number };

export type AppSkill = {
	/** The URI of its `SKILL.md`; with the app, the skill's identity. */
	readonly uri: string;
	readonly name: string;
	readonly description: string;
	/** The manifest of every file with its digest, or "dynamic" when the app cannot publish one. */
	readonly files: readonly SkillFile[] | "dynamic";
};

export type AppEventType = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema?: Record<string, unknown>;
};

/** How long a catalog is kept when the app gives no TTL, and the longest any is kept. */
const DEFAULT_TTL_MS = 3_600_000;
const MAX_TTL_MS = 86_400_000;
const MAX_PAGES = 10;

type Page = { nextCursor?: unknown; ttlMs?: unknown };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A skills/list entry, or undefined when it does not follow the extension. */
export function parseSkill(value: unknown): AppSkill | undefined {
	const entry = record(value);
	const frontmatter = record(entry?.frontmatter);
	if (!entry || !frontmatter || typeof entry.uri !== "string") return undefined;
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
	let files: SkillFile[] | "dynamic";
	if (entry.resources === "dynamic") files = "dynamic";
	else if (Array.isArray(entry.resources)) {
		files = [];
		for (const file of entry.resources) {
			const item = record(file);
			if (
				!item ||
				typeof item.uri !== "string" ||
				typeof item.digest !== "string" ||
				!/^sha256:[0-9a-f]{64}$/.test(item.digest) ||
				typeof item.size !== "number"
			) {
				return undefined;
			}
			files.push({ uri: item.uri, digest: item.digest, size: item.size });
		}
	} else return undefined;
	return { uri: entry.uri, name: frontmatter.name, description: frontmatter.description, files };
}

export class AppCatalog {
	readonly #bridge: McpBridge;
	readonly #store: PimStore;
	readonly #refreshing = new Map<string, Promise<void>>();

	constructor(bridge: McpBridge, store: PimStore) {
		this.#bridge = bridge;
		this.#store = store;
	}

	servesSkills(serverId: string): boolean {
		return this.#bridge.capabilities(serverId)?.extensions?.[SKILLS_EXTENSION] !== undefined;
	}

	/**
	 * Whether the app declares Events. The draft is unsettled and today's MCP SDKs drop the
	 * capability it defines from the handshake, so an app that declares nothing is still
	 * asked once per catalog refresh (see `#load`).
	 */
	declaresEvents(serverId: string): boolean {
		const capabilities = this.#bridge.capabilities(serverId);
		return capabilities?.events !== undefined || capabilities?.extensions?.[EVENTS_EXTENSION] !== undefined;
	}

	/** Whether the app's catalog has been read at least once. */
	known(serverId: string): boolean {
		return this.#store.catalog(serverId, "skills") !== undefined;
	}

	skills(serverId: string): readonly AppSkill[] {
		return this.#cached<AppSkill[]>(serverId, "skills") ?? [];
	}

	events(serverId: string): readonly AppEventType[] {
		return this.#cached<AppEventType[]>(serverId, "events") ?? [];
	}

	/** Re-reads an app's skills and event types now. One refresh per app runs at a time. */
	refresh(serverId: string): Promise<void> {
		const running = this.#refreshing.get(serverId);
		if (running) return running;
		const work = this.#load(serverId).finally(() => this.#refreshing.delete(serverId));
		this.#refreshing.set(serverId, work);
		return work;
	}

	forget(serverId: string): void {
		this.#store.deleteCatalog(serverId);
	}

	#cached<T>(serverId: string, kind: "skills" | "events"): T | undefined {
		const entry = this.#store.catalog<T>(serverId, kind);
		if (!entry || entry.expiresAt <= Date.now()) {
			void this.refresh(serverId).catch((error) => console.warn(`refreshing ${serverId}'s catalog failed`, error));
		}
		return entry?.data;
	}

	async #load(serverId: string): Promise<void> {
		// Both kinds are always stored, empty when the app offers none, so it is read once per TTL.
		let skills: AppSkill[] = [];
		let skillsTtl = DEFAULT_TTL_MS;
		if (this.servesSkills(serverId)) {
			const { items, ttlMs } = await this.#pages(serverId, "skills/list", "skills");
			skills = items.flatMap((item) => {
				const skill = parseSkill(item);
				return skill ? [skill] : [];
			});
			skillsTtl = ttlMs;
		}
		this.#store.setCatalog(serverId, "skills", skills, Date.now() + skillsTtl);

		let listing: { items: unknown[]; ttlMs: number };
		try {
			listing = await this.#pages(serverId, "events/list", "events");
		} catch (error) {
			// An app that declared Events and fails is broken; one that declared nothing just has none.
			if (this.declaresEvents(serverId)) throw error;
			listing = { items: [], ttlMs: DEFAULT_TTL_MS };
		}
		{
			const { items, ttlMs } = listing;
			const events = items.flatMap((item): AppEventType[] => {
				const event = record(item);
				// pim receives events by webhook only.
				if (!event || typeof event.name !== "string" || !Array.isArray(event.delivery) || !event.delivery.includes("webhook")) {
					return [];
				}
				const inputSchema = record(event.inputSchema);
				return [
					{
						name: event.name,
						description: typeof event.description === "string" ? event.description : "",
						...(inputSchema ? { inputSchema } : {}),
					},
				];
			});
			this.#store.setCatalog(serverId, "events", events, Date.now() + ttlMs);
		}
	}

	async #pages(serverId: string, method: string, key: string): Promise<{ items: unknown[]; ttlMs: number }> {
		const items: unknown[] = [];
		let cursor: string | undefined;
		let ttlMs: number | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const result = record(await this.#bridge.request(serverId, method, cursor ? { cursor } : {})) as
				| (Page & Record<string, unknown>)
				| undefined;
			const list = result?.[key];
			if (Array.isArray(list)) items.push(...list);
			// The shortest TTL of any page bounds the whole listing.
			if (typeof result?.ttlMs === "number" && result.ttlMs > 0) ttlMs = Math.min(ttlMs ?? result.ttlMs, result.ttlMs);
			if (typeof result?.nextCursor !== "string" || result.nextCursor === "") break;
			cursor = result.nextCursor;
		}
		return { items, ttlMs: Math.min(ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS) };
	}
}
