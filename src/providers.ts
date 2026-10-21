import type { Api, Model, Provider, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { HttpError } from "./http";

/**
 * Model providers people add in Settings → Model: built-in services with
 * native APIs, or servers that speak OpenAI's `/chat/completions`, such as
 * llama.cpp, LM Studio, Ollama and vLLM. A person's own are kept
 * in their space and only they use them; the admin's are kept in the gallery
 * and everyone on the Pim can use them. Pim never shows a provider's key
 * again once it's given.
 *
 * Built-in services use pi-ai's catalog and keep the chosen models' native
 * definitions so a restart needs neither the catalog nor a network request.
 * Custom endpoints read their models from the server's `/models`. What Pim can't
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
	/** A built-in model's full native definition as JSON, also safe to pass over Durable Object RPC. */
	readonly native?: string;
};

/** A provider as it's kept: its key included. */
export type CustomProvider = {
	readonly id: string;
	/** Absent on existing OpenAI-compatible endpoints. */
	readonly builtin?: string;
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
export type ProviderInput = { readonly builtin?: unknown; readonly name?: unknown; readonly url?: unknown; readonly key?: unknown; readonly models?: unknown };

/** Known services need a key, not an address. Model definitions come from pi-ai. */
const BUILTIN_PROVIDERS = [
	{ id: "anthropic", name: "Anthropic", url: "https://api.anthropic.com" },
	{ id: "openai", name: "OpenAI API", url: "https://api.openai.com/v1" },
	{ id: "google", name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta" },
	{ id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
	{ id: "deepseek", name: "DeepSeek", url: "https://api.deepseek.com" },
	{ id: "mistral", name: "Mistral AI", url: "https://api.mistral.ai" },
	{ id: "groq", name: "Groq", url: "https://api.groq.com/openai/v1" },
	{ id: "xai", name: "xAI", url: "https://api.x.ai/v1" },
] as const;

/** The chat catalog for the built-in picker, without loading it at Worker startup. */
export async function builtinProviders() {
	const { getBuiltinModels } = await import("./provider-catalog");
	return BUILTIN_PROVIDERS.map(({ id, name }) => ({
		id,
		name,
		models: (getBuiltinModels(id) as Model<Api>[]).map((model) => describe(model.id, undefined, model)),
	}));
}

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
 * from the built-in catalog or the server. `taken` are the ids already in use.
 */
export async function prepareProvider(input: ProviderInput, existing: CustomProvider | null, taken: ReadonlySet<string>): Promise<CustomProvider> {
	const builtin = input.builtin === undefined ? existing?.builtin : text(input.builtin, "builtin", 40);
	if (existing && builtin !== existing.builtin) throw new HttpError(400, "A provider's type cannot be changed. Add another provider instead.");
	const preset = BUILTIN_PROVIDERS.find((provider) => provider.id === builtin);
	if (builtin !== undefined && !preset) throw new HttpError(400, "Unknown built-in provider");
	if (preset && input.url !== undefined) throw new HttpError(400, "A built-in provider's address cannot be changed");
	const name = text(input.name, "name", 60) || existing?.name || preset?.name;
	if (!name) throw new HttpError(400, "name is required");
	const address = preset?.url ?? text(input.url, "url", 500) ?? existing?.url ?? "";
	const parsed = URL.parse(address);
	if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
		throw new HttpError(400, "url must be an http(s) address, such as http://localhost:1234/v1");
	}
	const url = parsed.href.replace(/\/+$/, "");
	// A key left out stays; an empty one is taken away.
	const key = input.key === null ? null : input.key === undefined ? (existing?.key ?? null) : text(input.key, "key", 2000) || null;
	if (preset && !key) throw new HttpError(400, "An API key is required");
	let chosen = existing?.chosen ?? null;
	if (input.models !== undefined) {
		if (input.models !== null && (!Array.isArray(input.models) || input.models.some((id) => typeof id !== "string" || !MODEL_ID.test(id.trim())))) {
			throw new HttpError(400, "models must be a list of model ids");
		}
		const ids = [...new Set(((input.models ?? []) as string[]).map((id) => id.trim()))];
		if (ids.length > MAX_CHOSEN) throw new HttpError(400, `Name at most ${MAX_CHOSEN} models`);
		chosen = ids.length === 0 ? null : ids;
	}
	if (preset) {
		const { getBuiltinModels } = await import("./provider-catalog");
		const catalog = getBuiltinModels(preset.id) as Model<Api>[];
		if (!chosen) throw new HttpError(400, "Choose at least one model");
		const models = chosen.map((id) => {
			const native = catalog.find((model) => model.id === id);
			if (!native) throw new HttpError(400, `${preset.name} doesn't offer a model ${id} in Pim's catalog`);
			return { ...describe(id, undefined, native), native: JSON.stringify(native) };
		});
		const base = existing?.id ?? preset.id;
		let id = base;
		if (!existing) for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
		return { id, builtin: preset.id, name, url, key, chosen, models };
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
	return { ...provider, models: provider.models.map(({ native, ...model }) => model), hasKey: key !== null };
}

/**
 * A provider's model as pi-ai calls it. Built-ins keep their native protocol;
 * custom endpoints get system messages, which every compatible server takes.
 */
export function providerModel(catalogId: string, provider: CustomProvider, model: ProviderModel): Model<Api> {
	if (model.native) return { ...JSON.parse(model.native) as Model<Api>, provider: catalogId };
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
	const configured = createProvider({
		id: catalogId,
		name: provider.name,
		baseUrl: provider.url,
		auth: {
			apiKey: {
				name: `${provider.name} key`,
				resolve: async () => ({
					auth: provider.builtin === "openrouter" ? { headers: { Authorization: `Bearer ${provider.key}` } } : { apiKey: provider.key ?? "none" },
				}),
			},
		},
		models: provider.models.map((model) => providerModel(catalogId, provider, model)),
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
			"anthropic-messages": anthropicMessagesApi(),
			"google-generative-ai": googleGenerativeAIApi(),
			"mistral-conversations": mistralConversationsApi(),
		},
	});
	if (!provider.builtin) return configured;
	return {
		...configured,
		stream: nativeStream(configured.stream, provider.builtin),
		streamSimple: nativeStream(configured.streamSimple, provider.builtin),
	};
}

/**
 * Adapters use the service's identity for reasoning and protocol quirks. Pim
 * uses the connection's identity for auth, metering and saved conversations.
 */
function nativeStream<T extends StreamOptions>(stream: StreamFunction<Api, T>, builtin: string): StreamFunction<Api, T> {
	return (model, context, options) => lazyStream(model, async () => (async function* () {
		const native = { ...model, provider: builtin };
		const transcript = {
			...context,
			messages: context.messages.map((message) => {
				if (message.role !== "assistant") return message;
				if (message.provider === model.provider) return { ...message, provider: builtin };
				// ChatGPT's connection already uses `openai`; it is not this API account.
				return message.provider === builtin ? { ...message, provider: `other:${builtin}` } : message;
			}),
		};
		for await (const event of stream(native, transcript, options)) {
			if (event.type === "done") yield { ...event, message: { ...event.message, provider: model.provider } };
			else if (event.type === "error") yield { ...event, error: { ...event.error, provider: model.provider } };
			else yield { ...event, partial: { ...event.partial, provider: model.provider } };
		}
	})());
}
