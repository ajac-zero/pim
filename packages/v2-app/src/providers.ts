import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import type { Principal } from "@pim/v2-contracts/identity";
import { Authorizer } from "./authz.ts";
import { openString, sealString } from "./crypto.ts";
import type { Db } from "./db.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import { newId } from "./ids.ts";

export type Provider = { id: string; kind: string; name: string; config: Record<string, unknown>; hasKey: boolean; fallbackOrder: number | null };
type ModelRef = { provider: string; id: string };

const KINDS = ["anthropic", "openai", "openai_compatible", "google", "workers_ai", "bedrock", "custom"];

/**
 * Model providers a person adds, and the workspace's fallback list. Keys are sealed with the envelope crypto, bound to the owner and the provider,
 * and never leave the service: lists and reads say only whether a key is set. `reveal` is for the Runner's model gateway, not for HTTP.
 */
export class Providers {
	constructor(private readonly db: Db, private readonly crypto: EnvelopeCrypto, private readonly authz = new Authorizer(db)) {}

	#row(r: any): Provider {
		return { id: r.id, kind: r.kind, name: r.config.name ?? r.kind, config: r.config, hasKey: r.secret !== null, fallbackOrder: r.fallback_order };
	}

	async create(p: Principal, input: { kind: string; name?: string; config?: Record<string, unknown>; apiKey?: string }): Promise<Provider> {
		await this.authz.enforce(p, "api:write");
		if (!KINDS.includes(input.kind)) throw new BadRequestError(`kind is one of ${KINDS.join(", ")}`);
		const id = newId("pv");
		const sealed = input.apiKey ? await sealString(this.crypto, input.apiKey, `provider:${p.ownerId}/${id}`) : null;
		const config = { ...(input.config ?? {}), ...(input.name ? { name: input.name } : {}) };
		return this.db.owner(p.ownerId, async (tx) => this.#row((await tx.query("INSERT INTO pim_app.providers (id, owner_id, kind, config, secret) VALUES ($1,$2,$3,$4,$5) RETURNING *", [id, p.ownerId, input.kind, JSON.stringify(config), sealed])).rows[0]));
	}

	async list(p: Principal): Promise<Provider[]> {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT * FROM pim_app.providers ORDER BY id")).rows.map((r) => this.#row(r)));
	}

	async update(p: Principal, id: string, input: { name?: string; config?: Record<string, unknown>; apiKey?: string | null }): Promise<Provider> {
		await this.authz.enforce(p, "api:write");
		const sealed = input.apiKey ? await sealString(this.crypto, input.apiKey, `provider:${p.ownerId}/${id}`) : null;
		return this.db.owner(p.ownerId, async (tx) => {
			const cur = (await tx.query("SELECT config FROM pim_app.providers WHERE id = $1", [id])).rows[0];
			if (!cur) throw new NotFoundError("No such provider");
			const config = { ...cur.config, ...(input.config ?? {}), ...(input.name ? { name: input.name } : {}) };
			return this.#row((await tx.query("UPDATE pim_app.providers SET config = $2, secret = CASE WHEN $3 THEN $4 ELSE secret END WHERE id = $1 RETURNING *", [id, JSON.stringify(config), input.apiKey !== undefined, sealed])).rows[0]);
		});
	}

	/** Removing a provider drops its models from the fallback list. */
	async remove(p: Principal, id: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			if (!(await tx.query("DELETE FROM pim_app.providers WHERE id = $1", [id])).rowCount) throw new NotFoundError("No such provider");
			const list = ((await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = 'model_fallbacks'")).rows[0]?.value ?? []) as ModelRef[];
			await tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,'model_fallbacks',$2) ON CONFLICT (owner_id, key) DO UPDATE SET value = $2", [p.ownerId, JSON.stringify(list.filter((m) => m.provider !== id))]);
		});
	}

	/** The key, opened, for the model gateway. Not an API route: nothing a person or a token can ask for returns it. */
	async reveal(ownerId: string, id: string): Promise<string | null> {
		const stored = await this.db.owner(ownerId, async (tx) => (await tx.query("SELECT secret FROM pim_app.providers WHERE id = $1", [id])).rows[0]?.secret as string | null | undefined);
		if (stored === undefined) throw new NotFoundError("No such provider");
		return stored ? openString(this.crypto, stored, `provider:${ownerId}/${id}`) : null;
	}

	/** Re-seals every key under the current key version; returns how many changed. */
	async rotateKeys(ownerId: string): Promise<number> {
		const rows = await this.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, secret FROM pim_app.providers WHERE secret IS NOT NULL")).rows);
		let n = 0;
		for (const r of rows) {
			const ctx = `provider:${ownerId}/${r.id}`;
			const plain = await openString(this.crypto, r.secret, ctx);
			const fresh = await sealString(this.crypto, plain, ctx);
			const [, keyBefore] = (r.secret as string).split(".");
			const [, keyAfter] = fresh.split(".");
			if (keyBefore !== keyAfter) {
				await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.providers SET secret = $2 WHERE id = $1", [r.id, fresh]));
				n++;
			}
		}
		return n;
	}

	async fallbacks(p: Principal): Promise<ModelRef[]> {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => ((await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = 'model_fallbacks'")).rows[0]?.value ?? []) as ModelRef[]);
	}

	/** The workspace's fallback list: every agent moves on to these, in order, after its own, when its model fails for good. */
	async setFallbacks(p: Principal, models: ModelRef[]): Promise<ModelRef[]> {
		await this.authz.enforce(p, "api:write");
		if (!Array.isArray(models) || models.length > 20 || models.some((m) => typeof m?.provider !== "string" || typeof m?.id !== "string")) throw new BadRequestError("models is a list of { provider, id }");
		await this.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,'model_fallbacks',$2) ON CONFLICT (owner_id, key) DO UPDATE SET value = $2", [p.ownerId, JSON.stringify(models)]));
		return models;
	}
}
