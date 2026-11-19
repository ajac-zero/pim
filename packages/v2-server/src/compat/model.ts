/**
 * The web app's model settings over the Gate: `GET /api/model` (the model agents run on when they have none of their own, the choices, the ChatGPT plan and the person's providers),
 * `PUT /api/model`, `PUT /api/model/utility`, the built-in services. The ChatGPT images sign-in is `chatgpt-images.ts`; this only reports whether it is connected.
 * The choices are what the Gate can know: the plan's catalog when ChatGPT is signed in, the services whose key a person added, their own OpenAI-compatible endpoints,
 * the deployment's gateway and its default model. The Runner is what runs them, from its own catalog (`agent-host.ts`); a person's providers are `own:<id>` here and `<id>` there.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { BadRequestError, NotFoundError, PimError } from "@pim/v2-app/errors";
import { ok, type Route, route } from "@pim/v2-app/http";
import { toWebProvider } from "@pim/v2-app/web-providers";
import { CodexImagesSignIn } from "../codex-images.ts";
import { currentOpenaiProvider } from "../openai-catalog.ts";

type Env = Record<string, string | undefined>;
type ModelRef = { provider: string; id: string };
const OWN = "own:";
const SHARED = "shared:";

const CATALOGS: Record<string, { name: string; models: () => readonly Model<Api>[] }> = {
	anthropic: { name: "Anthropic", models: () => anthropicProvider().getModels() as never },
	// The plan's models are the ones that answer in the Responses API; the API-key service offers the same catalog.
	openai: { name: "OpenAI API", models: () => (currentOpenaiProvider().getModels() as readonly Model<Api>[]).filter((m) => m.api === "openai-responses") },
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
		// The providers the admin shared with everyone: their models, by the name the Runner's catalog gives them.
		for (const shared of ((await app.db.anonymous(async (tx: any) => (await tx.query("SELECT pim_app.instance_provider_models() AS p")).rows[0]?.p)) ?? []) as { id: string; models: { id: string; name?: string; images?: boolean }[] }[]) for (const m of shared.models) add({ provider: shared.id, id: m.id, name: m.name ?? m.id, images: m.images === true } as never);
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
			chatgptImages: await new CodexImagesSignIn(app, env).status(p),
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

	return [
		route("GET", "/api/model", async ({ app, principal }) => {
			return ok(await settings(app, await principal()));
		}),
		route("PUT", "/api/model", async ({ app, principal, json }) => ok(await choose(app, await principal(), "model", await json()))),
		route("PUT", "/api/model/utility", async ({ app, principal, json }) => ok(await choose(app, await principal(), "model_utility", await json()))),
		// One chat's own model, over its agent's; null follows the agent's again. The Runner reads it before the chat's next turn (migration 0670).
		route("PUT", "/api/sessions/:id/model", async ({ app, principal, params, json }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const body = await json();
			const now = await settings(app, p);
			// Null, or an empty model, clears the chat's own choice: it follows its agent's again.
			const clears = body.model === null || body.model === "" || body.provider === null || (body.provider === undefined && body.id === undefined && body.model === undefined);
			const hint = `Send {provider, id} of one of GET /model's choices (for example {"provider":"own:ai-gateway","id":"claude-sonnet-5-5"}), or {model:"<provider>/<id>"}.`;
			let found: { provider: string; id: string; name: string; images: boolean } | null | undefined = null;
			if (!clears) {
				if (typeof body.provider === "string" && typeof body.id === "string") found = now.choices.find((c) => c.provider === body.provider && c.id === body.id);
				else if (typeof body.model === "string") {
					// The longest provider the string starts with, since a model id may hold "/" too; a bare id is the default's, or the one choice that has it.
					const text = body.model;
					const provider = [...new Set(now.choices.map((c) => c.provider))].filter((candidate) => text.startsWith(`${candidate}/`)).sort((a, b) => b.length - a.length)[0];
					const withId = now.choices.filter((c) => c.id === text);
					found = provider ? now.choices.find((c) => c.provider === provider && c.id === text.slice(provider.length + 1)) : now.default.id === text ? now.default : withId.length === 1 ? withId[0] : undefined;
				} else found = undefined;
				if (found === undefined) throw new PimError(400, "bad_request", `That model is not one of the choices. ${hint}`);
			}
			const changed = await app.db.owner(p.ownerId, async (tx: any) => (await tx.query("UPDATE pim_app.conversations SET model = $2 WHERE public_chat_id::text = $1 AND deleted_at IS NULL", [params[0]!, found && JSON.stringify({ provider: found.provider, id: found.id })])).rowCount);
			if (!changed) throw new NotFoundError("No such chat");
			return ok({ model: found ?? now.model, override: found });
		}),
		// The model of an agent besides the host in a group chat, for this chat alone: that agent's seat is a chat of its own, so it is the seat's model; null follows the agent's again.
		route("PUT", "/api/sessions/:id/room/members/:agent/model", async ({ app, principal, params, json }) => {
			const p = await principal();
			await app.identity.authz.enforce(p, "api:write");
			const body = await json();
			const now = await settings(app, p);
			const found = body.provider === null || body.provider === undefined ? null : now.choices.find((c) => c.provider === body.provider && c.id === body.id);
			if (found === undefined) throw new PimError(400, "bad_request", "That model is not one of the choices");
			const changed = await app.db.owner(p.ownerId, async (tx: any) => (await tx.query("UPDATE pim_app.conversations SET model = $3 WHERE deleted_at IS NULL AND public_chat_id = (SELECT seat_chat_id FROM pim_app.room_members WHERE public_chat_id::text = $1 AND member = $2)", [params[0]!, params[1]!, found && JSON.stringify({ provider: found.provider, id: found.id })])).rowCount);
			if (!changed) throw new NotFoundError("That agent is not in this chat");
			return ok({ model: found ?? now.model });
		}),
		// The saved fallbacks are bare `{ provider, id }` (the cutover carries them so); the web app lists them by name.
		route("GET", "/api/model/fallbacks", async ({ app, principal }) => {
			const p = await principal();
			const refs = await app.providers.fallbacks(p);
			const { choices } = await settings(app, p);
			return ok({ models: refs.map((r: ModelRef) => choices.find((c) => same(c, r)) ?? { ...r, name: r.id, images: false }) });
		}),
		route("GET", "/api/providers/built-in", async ({ app, principal }) => {
			await app.identity.authz.enforce(await principal(), "api:read");
			return ok({ providers: Object.entries(CATALOGS).map(([id, c]) => ({ id, name: c.name, models: c.models().map(catalogInfo) })) });
		}),
	];
}
