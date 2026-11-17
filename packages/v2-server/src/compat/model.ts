/**
 * The web app's model settings over the Gate: `GET /api/model` (the model agents run on when they have none of their own, the choices, the ChatGPT plan and the person's providers),
 * `PUT /api/model`, `PUT /api/model/utility`, the built-in services, and the ChatGPT image sign-in, which is not ported (it answers as not connected).
 * The choices are what the Gate can know: the plan's catalog when ChatGPT is signed in, the services whose key a person added, their own OpenAI-compatible endpoints,
 * the deployment's gateway and its default model. The Runner is what runs them, from its own catalog (`agent-host.ts`); a person's providers are `own:<id>` here and `<id>` there.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { BadRequestError, PimError } from "@pim/v2-app/errors";
import { ok, type Route, route } from "@pim/v2-app/http";
import { toWebProvider } from "@pim/v2-app/web-providers";

type Env = Record<string, string | undefined>;
type ModelRef = { provider: string; id: string };
const OWN = "own:";
const SHARED = "shared:";

const CATALOGS: Record<string, { name: string; models: () => readonly Model<Api>[] }> = {
	anthropic: { name: "Anthropic", models: () => anthropicProvider().getModels() as never },
	// The plan's models are the ones that answer in the Responses API; the API-key service offers the same catalog.
	openai: { name: "OpenAI API", models: () => (openaiProvider().getModels() as readonly Model<Api>[]).filter((m) => m.api === "openai-responses") },
	google: { name: "Google Gemini", models: () => googleProvider().getModels() as never },
};

const describe = (m: Model<Api>, provider = m.provider) => ({ provider, id: m.id, name: m.name ?? m.id, images: Array.isArray(m.input) && m.input.includes("image"), contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost });
const catalogInfo = (m: Model<Api>) => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, maxTokensSource: "catalog" as const, images: Array.isArray(m.input) && m.input.includes("image"), reasoning: m.reasoning === true, cost: m.cost });
const parse = (v: string | undefined): ModelRef | null => (v && v.includes("/") ? { provider: v.split("/")[0]!, id: v.split("/").slice(1).join("/") } : null);
const same = (a: ModelRef, b: ModelRef) => a.provider === b.provider && a.id === b.id;

export function modelRoutes(env: Env): Route[] {
	const setting = (app: any, ownerId: string, key: string): Promise<ModelRef | null> => app.db.owner(ownerId, async (tx: any) => (await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = $1", [key])).rows[0]?.value ?? null);

	async function settings(app: any, p: any) {
		const chatgpt = await app.chatgpt.status(p);
		const all = await app.providers.list(p);
		// What an admin shares is everyone's, and is `shared:<id>` to the catalog whoever's row it is; an admin's own list does not repeat it.
		const providers = all.filter((r: any) => r.config.shared !== true);
		const shared = await app.providers.shared(p);
		const choices: ReturnType<typeof describe>[] = [];
		const add = (m: ReturnType<typeof describe>) => choices.some((c) => same(c, m)) || choices.push(m);
		const fallback = parse(env.PIM_DEFAULT_MODEL);
		const known = (r: ModelRef) => Object.values(CATALOGS).flatMap((c) => c.models()).find((m) => m.provider === r.provider && m.id === r.id);
		if (fallback) add(known(fallback) ? describe(known(fallback)!) : { provider: fallback.provider, id: fallback.id, name: fallback.id, images: false } as never);
		if (chatgpt.connected) for (const m of CATALOGS.openai!.models()) add(describe(m));
		for (const row of providers) {
			const kind = row.config.builtin ?? row.kind;
			if (row.hasKey && row.config.builtin && kind !== "openai") for (const m of CATALOGS[kind]?.models() ?? []) if (!row.config.chosen || row.config.chosen.includes(m.id)) add(describe(m));
			if (row.kind === "openai_compatible" && Array.isArray(row.config.models)) for (const m of row.config.models) add({ provider: `${OWN}${row.id}`, id: m.id, name: m.name ?? m.id, images: m.images === true } as never);
		}
		for (const row of shared) {
			const kind = row.config.builtin ?? row.kind;
			if (row.hasKey && row.config.builtin && kind !== "openai") for (const m of CATALOGS[kind]?.models() ?? []) if (!row.config.chosen || row.config.chosen.includes(m.id)) add(describe(m));
			if (row.kind === "openai_compatible" && Array.isArray(row.config.models)) for (const m of row.config.models) add({ provider: `${SHARED}${row.id}`, id: m.id, name: m.name ?? m.id, images: m.images === true } as never);
		}
		if (env.PIM_AI_GATEWAY_URL) for (const id of (env.PIM_AI_GATEWAY_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) add({ provider: "gateway", id, name: id, images: false } as never);
		const info = (r: ModelRef | null) => (r ? (choices.find((c) => same(c, r)) ?? null) : null);
		const chosen = await setting(app, p.ownerId, "model");
		const utilitySaved = await setting(app, p.ownerId, "model_utility");
		const utility = utilitySaved && { provider: providers.some((r: any) => r.id === utilitySaved.provider) ? `${OWN}${utilitySaved.provider}` : utilitySaved.provider, id: utilitySaved.id };
		const defaults = info(fallback) ?? choices[0] ?? { provider: "", id: "", name: "No model", images: false };
		return {
			model: info(chosen && { provider: providers.some((r: any) => r.id === chosen.provider) ? `${OWN}${chosen.provider}` : chosen.provider, id: chosen.id }) ?? defaults,
			default: defaults,
			choices,
			workersAi: false,
			utility: { model: info(utility), default: null, choices },
			chatgpt: { ...chatgpt, error: null },
			chatgptImages: { connected: false, email: null },
			providers: [...providers.map((row: any) => ({ ...toWebProvider(row), provider: `${OWN}${row.id}` })), ...shared.map((row: any) => ({ ...toWebProvider(row), shared: true, provider: `${SHARED}${row.id}` }))],
		};
	}

	/** Stores a choice after checking it is one of the choices; `own:<id>` is kept as the Runner's provider id. */
	async function choose(app: any, p: any, key: string, body: Record<string, any>): Promise<{ model: unknown }> {
		await app.identity.authz.enforce(p, "api:write");
		if (typeof body.provider !== "string" || typeof body.id !== "string") throw new BadRequestError("provider and id must be strings");
		const now = await settings(app, p);
		const found = now.choices.find((c) => c.provider === body.provider && c.id === body.id);
		if (!found) throw new PimError(400, "bad_request", "That model is not one of the choices");
		const stored = { provider: found.provider.startsWith(OWN) ? found.provider.slice(OWN.length) : found.provider, id: found.id };
		await app.db.owner(p.ownerId, async (tx: any) => {
			if (key === "model" && same(found, now.default)) await tx.query("DELETE FROM pim_app.owner_settings WHERE key = 'model'");
			else await tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (owner_id, key) DO UPDATE SET value = $3", [p.ownerId, key, JSON.stringify(stored)]);
		});
		return { model: found };
	}

	const unavailable = () => { throw new PimError(501, "capability_unavailable", "ChatGPT image generation is not available on this Pim yet."); };
	return [
		route("GET", "/api/model", async ({ app, principal }) => {
			return ok(await settings(app, await principal()));
		}),
		route("PUT", "/api/model", async ({ app, principal, json }) => ok(await choose(app, await principal(), "model", await json()))),
		route("PUT", "/api/model/utility", async ({ app, principal, json }) => ok(await choose(app, await principal(), "model_utility", await json()))),
		route("GET", "/api/providers/built-in", async ({ app, principal }) => {
			await app.identity.authz.enforce(await principal(), "api:read");
			return ok({ providers: Object.entries(CATALOGS).map(([id, c]) => ({ id, name: c.name, models: c.models().map(catalogInfo) })) });
		}),
		route("GET", "/api/chatgpt/images", async () => ok({ connected: false, email: null })),
		route("POST", "/api/chatgpt/images/login", async () => unavailable()),
		route("POST", "/api/chatgpt/images/callback", async () => unavailable()),
		route("DELETE", "/api/chatgpt/images", async () => ok({ connected: false, email: null })),
	];
}
