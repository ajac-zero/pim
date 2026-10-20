import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { HttpError } from "./http";

/**
 * Model providers people add in Settings → Model: any server that speaks
 * OpenAI's `/chat/completions`, such as a model on the deployment's own
 * machine (llama.cpp, LM Studio, Ollama, vLLM) or a provider's API used
 * directly (OpenAI, DeepSeek, Groq, OpenRouter...). A person's own are kept
 * in their space and only they use them; the admin's are kept in the gallery
 * and everyone on the Pim can use them. Pim never shows a provider's key
 * again once it's given.
 *
 * Adding one reads its models from the server's `/models`. What Pim can't
 * read there (a model's context window, its longest answer, whether it sees
 * images or reasons) comes from pi-ai's catalog when it knows a model by
 * that id, and otherwise from defaults that suit a text-only model.
 */

/** A model on a provider, with what Pim needs to know about it. */
export type ProviderModel = {
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly images: boolean;
	readonly reasoning: boolean;
};

/** A provider as it's kept: its key included. */
export type CustomProvider = {
	readonly id: string;
	readonly name: string;
	readonly url: string;
	readonly key: string | null;
	/** The models the person named, in their order; null offers every model the server lists. */
	readonly chosen: readonly string[] | null;
	readonly models: readonly ProviderModel[];
};

/** A provider as the API shows it: never its key. */
export type ProviderInfo = Omit<CustomProvider, "key"> & { readonly hasKey: boolean };

/** What adding or changing a provider gives; a missing field keeps what it was. */
export type ProviderInput = { readonly name?: unknown; readonly url?: unknown; readonly key?: unknown; readonly models?: unknown };

/** Catalog ids: a person's own providers are `own:<id>`, the admin's `shared:<id>`. */
export const OWN_PROVIDER = "own:";
export const SHARED_PROVIDER = "shared:";

/** Every provider a space or the gallery keeps, at most. */
export const MAX_PROVIDERS = 20;
/** A server that lists more models than this must be told which to offer. */
const MAX_LISTED = 50;
const MAX_CHOSEN = 50;
const MODEL_ID = /^[A-Za-z0-9][\w.:@/+-]{0,199}$/;
const DEFAULTS = { contextWindow: 128_000, maxTokens: 8_192 };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | undefined => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined);

let catalog: Promise<Map<string, Model<Api>>> | undefined;

/**
 * pi-ai's catalog, by model id, from the first provider that has each. It's
 * loaded only when a provider is added or changed, so starting a Worker
 * doesn't pay for it.
 */
function knownModels(): Promise<Map<string, Model<Api>>> {
	catalog ??= import("./provider-catalog").then(({ getBuiltinModels, getBuiltinProviders }) => {
		const known = new Map<string, Model<Api>>();
		for (const provider of getBuiltinProviders()) {
			for (const model of getBuiltinModels(provider) as Model<Api>[]) if (!known.has(model.id)) known.set(model.id, model);
		}
		return known;
	});
	return catalog;
}

/**
 * A model as a server listed it (OpenRouter, vLLM and llama.cpp say more than
 * most), or as pi-ai knows it, or with defaults.
 */
function describe(id: string, listed: Record<string, unknown> | undefined, known: Model<Api> | undefined): ProviderModel {
	const architecture = isObject(listed?.architecture) ? listed.architecture : undefined;
	const modalities = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : undefined;
	const parameters = Array.isArray(listed?.supported_parameters) ? listed.supported_parameters : undefined;
	const top = isObject(listed?.top_provider) ? listed.top_provider : undefined;
	const meta = isObject(listed?.meta) ? listed.meta : undefined;
	// OpenRouter's context_length, vLLM's max_model_len, and llama.cpp's n_ctx, the context it serves the model with.
	const contextWindow = count(listed?.context_length) ?? count(listed?.max_model_len) ?? count(meta?.n_ctx) ?? known?.contextWindow ?? DEFAULTS.contextWindow;
	const maxTokens = count(top?.max_completion_tokens) ?? known?.maxTokens ?? DEFAULTS.maxTokens;
	return {
		id,
		name: typeof listed?.name === "string" && listed.name.trim() ? listed.name.trim() : (known?.name ?? id),
		contextWindow,
		maxTokens: Math.min(maxTokens, contextWindow),
		images: modalities ? modalities.includes("image") : (known?.input.includes("image") ?? false),
		reasoning: parameters ? parameters.includes("reasoning") : (known?.reasoning ?? false),
	};
}

/** The models the server at `url` lists. Throws with why it couldn't. */
async function listModels(url: string, key: string | null): Promise<Record<string, unknown>[]> {
	let response: Response;
	try {
		response = await fetch(`${url}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) });
	} catch (error) {
		throw new Error(error instanceof Error && error.name === "TimeoutError" ? "it didn't answer in 10 seconds" : "it couldn't be reached");
	}
	if (!response.ok) throw new Error(`it answered ${response.status}`);
	const body: unknown = await response.json().catch(() => null);
	const data = isObject(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : null;
	if (!data) throw new Error("its answer isn't a list of models");
	return data.filter((entry): entry is Record<string, unknown> => isObject(entry) && typeof entry.id === "string" && MODEL_ID.test(entry.id));
}

function text(value: unknown, field: string, max: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
	return trimmed;
}

/**
 * Checks a new provider, or a change to `existing`, and reads its models
 * from the server again. `taken` are the ids already in use, for a new one's.
 */
export async function prepareProvider(input: ProviderInput, existing: CustomProvider | null, taken: ReadonlySet<string>): Promise<CustomProvider> {
	const name = text(input.name, "name", 60) || existing?.name;
	if (!name) throw new HttpError(400, "name is required");
	const address = text(input.url, "url", 500) ?? existing?.url ?? "";
	const parsed = URL.parse(address);
	if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
		throw new HttpError(400, "url must be an http(s) address, such as http://localhost:1234/v1");
	}
	const url = parsed.href.replace(/\/+$/, "");
	// A key left out stays; an empty one is taken away.
	const key = input.key === null ? null : input.key === undefined ? (existing?.key ?? null) : text(input.key, "key", 2000) || null;
	let chosen = existing?.chosen ?? null;
	if (input.models !== undefined) {
		if (input.models !== null && (!Array.isArray(input.models) || input.models.some((id) => typeof id !== "string" || !MODEL_ID.test(id.trim())))) {
			throw new HttpError(400, "models must be a list of model ids");
		}
		const ids = [...new Set(((input.models ?? []) as string[]).map((id) => id.trim()))];
		if (ids.length > MAX_CHOSEN) throw new HttpError(400, `Name at most ${MAX_CHOSEN} models`);
		chosen = ids.length === 0 ? null : ids;
	}

	let listed: Record<string, unknown>[] | null = null;
	let unlisted: string | null = null;
	try {
		listed = await listModels(url, key);
	} catch (error) {
		unlisted = error instanceof Error ? error.message : String(error);
	}
	if (chosen === null) {
		if (!listed) throw new HttpError(400, `Pim couldn't read the models at ${url}: ${unlisted}. Check the address and key, or name the models to use.`);
		if (listed.length === 0) throw new HttpError(400, `${url} lists no models. Load one, or name the models to use.`);
		if (listed.length > MAX_LISTED) throw new HttpError(400, `${url} lists ${listed.length} models. Name the ones to use.`);
	} else if (listed) {
		const missing = chosen.find((id) => !listed.some((entry) => entry.id === id));
		if (missing) throw new HttpError(400, `${url} doesn't list a model ${missing}`);
	}
	const known = await knownModels();
	const models = (chosen ?? listed!.map((entry) => entry.id as string)).map((id) =>
		describe(
			id,
			listed?.find((entry) => entry.id === id),
			known.get(id),
		),
	);

	let id = existing?.id;
	if (!id) {
		const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "provider";
		id = base;
		for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	}
	return { id, name, url, key, chosen, models };
}

export function providerInfo({ key, ...provider }: CustomProvider): ProviderInfo {
	return { ...provider, hasKey: key !== null };
}

/**
 * A provider's model as pi-ai calls it. Instructions go as a system message,
 * which every compatible server takes; OpenAI's reads it as the developer's.
 */
export function providerModel(catalogId: string, provider: CustomProvider, model: ProviderModel): Model<"openai-completions"> {
	return {
		id: model.id,
		name: model.name,
		api: "openai-completions",
		provider: catalogId,
		baseUrl: provider.url,
		input: model.images ? ["text", "image"] : ["text"],
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false },
	};
}

/** A provider as pi-ai calls it, by its catalog id. A server without a key, as local ones usually are, is sent a placeholder. */
export function piProvider(catalogId: string, provider: CustomProvider): Provider {
	return createProvider({
		id: catalogId,
		name: provider.name,
		baseUrl: provider.url,
		auth: { apiKey: { name: `${provider.name} key`, resolve: async () => ({ auth: { apiKey: provider.key ?? "none" } }) } },
		models: provider.models.map((model) => providerModel(catalogId, provider, model)),
		api: openAICompletionsApi(),
	});
}
