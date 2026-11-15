import type { Api, Context, Model, Provider, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { HttpError } from "@pim/shared/http";
import { withPlainToolResults, withTypedToolSchemas } from "./typed-schemas";

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

/** A model's price in dollars per million tokens, as pi-ai takes it. */
export type ModelCost = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };

/** What the person set for a custom endpoint's model where the server can't say: its real context window, its longest answer and its price. */
export type ModelOverride = { readonly contextWindow?: number; readonly maxTokens?: number; readonly cost?: ModelCost };

/** Where a model's longest answer came from: the server's listing, pi-ai's catalog, the person, or the heuristic fallback. */
export type MaxTokensSource = "listing" | "catalog" | "override" | "estimated";

/** A model on a provider, with what Pim needs to know about it. */
export type ProviderModel = {
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
	/** Where `maxTokens` came from; "estimated" is the heuristic fallback, not a known limit. Absent on models stored before it was kept. */
	readonly maxTokensSource?: MaxTokensSource;
	readonly images: boolean;
	readonly reasoning: boolean;
	/** What the person says it costs, in dollars per million tokens; absent for a model with no price, which is free. */
	readonly cost?: ModelCost;
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
	/** Whether a custom endpoint's models can answer in a JSON schema (`response_format`); the person says so, and an absent flag is no. Built-in services are known (see `answersInSchema`). */
	readonly structuredOutput?: boolean;
	/** The API a custom endpoint speaks when it isn't OpenAI's chat completions; absent means chat completions. */
	readonly api?: "anthropic-messages";
	/** A custom endpoint's models' settings by model id; they stay when its models are read again. */
	readonly overrides?: Readonly<Record<string, ModelOverride>>;
};

/** A provider as the API shows it: never its key. */
export type ProviderInfo = Omit<CustomProvider, "key"> & { readonly hasKey: boolean };

/** What adding or changing a provider gives; a missing field keeps what it was. */
export type ProviderInput = { readonly builtin?: unknown; readonly name?: unknown; readonly url?: unknown; readonly key?: unknown; readonly models?: unknown; readonly structuredOutput?: unknown; readonly api?: unknown; readonly overrides?: unknown };

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

/** Built-in services whose models take a JSON schema for their answer; the others, such as DeepSeek, only promise valid JSON, or do for some models. */
const SCHEMA_SERVICES: ReadonlySet<string> = new Set(["anthropic", "openai", "google", "mistral", "xai"]);

/** Whether a provider's models can be the utility model: a side job's structured answer needs them to follow a JSON schema (see ./utility.ts). */
export function answersInSchema(provider: CustomProvider): boolean {
	return provider.builtin === undefined ? provider.structuredOutput === true : SCHEMA_SERVICES.has(provider.builtin);
}

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
/**
 * What a model with no metadata gets. pi sends a model's `maxTokens` as the
 * request's output limit (max_tokens, max_completion_tokens or maxOutputTokens),
 * so this is also the output limit of its chats; reasoning tokens count in it,
 * and 8192 let a reasoning model spend it all thinking, with no answer or tool
 * call left. An unknown model gets a quarter of its context window, at most
 * 32768. That is a HEURISTIC, not a supported maximum of any model: it only
 * leaves room to reason and answer, below the window. It is shown as
 * estimated, and a person can set the real limit as the model's `maxTokens`
 * override.
 */
const DEFAULTS = { contextWindow: 128_000 };
const FALLBACK_MAX_TOKENS = 32_768;
/** The 8192 that every model without metadata was stored with before the fallback grew. */
const LEGACY_FALLBACK = 8_192;
const fallbackMaxTokens = (contextWindow: number) => Math.min(FALLBACK_MAX_TOKENS, Math.floor(contextWindow / 4));

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
export function describe(id: string, listed: Record<string, unknown> | undefined, known: Model<Api> | undefined, override?: ModelOverride): ProviderModel {
	const architecture = isObject(listed?.architecture) ? listed.architecture : undefined;
	const modalities = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : undefined;
	const parameters = Array.isArray(listed?.supported_parameters) ? listed.supported_parameters : undefined;
	const top = isObject(listed?.top_provider) ? listed.top_provider : undefined;
	const meta = isObject(listed?.meta) ? listed.meta : undefined;
	// OpenRouter's context_length, vLLM's max_model_len, and llama.cpp's n_ctx, the context it serves the model with.
	const contextWindow = override?.contextWindow ?? count(listed?.context_length) ?? count(listed?.max_model_len) ?? count(meta?.n_ctx) ?? known?.contextWindow ?? DEFAULTS.contextWindow;
	// The longest answer: the person's setting, then what the server lists (OpenRouter's top_provider.max_completion_tokens, max_completion_tokens and max_output_tokens as LiteLLM and vLLM-style gateways give them, Gemini's outputTokenLimit, max_tokens), then pi-ai's catalog.
	const fromListing =
		count(top?.max_completion_tokens) ?? count(listed?.max_completion_tokens) ?? count(listed?.max_output_tokens) ?? count(listed?.outputTokenLimit) ?? count(listed?.max_tokens);
	const maxTokensSource: MaxTokensSource = override?.maxTokens ? "override" : fromListing ? "listing" : known?.maxTokens ? "catalog" : "estimated";
	const maxTokens = override?.maxTokens ?? fromListing ?? known?.maxTokens ?? fallbackMaxTokens(contextWindow);
	return {
		id,
		name: typeof listed?.name === "string" && listed.name.trim() ? listed.name.trim() : (known?.name ?? id),
		contextWindow,
		// An answer is never the whole context: a limit that large leaves no room for the input, so half is kept.
		maxTokens: maxTokens < contextWindow ? maxTokens : Math.floor(contextWindow / 2),
		maxTokensSource,
		images: modalities ? modalities.includes("image") : (known?.input.includes("image") ?? false),
		reasoning: parameters ? parameters.includes("reasoning") : (known?.reasoning ?? false),
		...(override?.cost && { cost: override.cost }),
	};
}

/** The models the server at `url` lists. Throws with why it couldn't. */
async function listModels(url: string, key: string | null, api: CustomProvider["api"]): Promise<Record<string, unknown>[]> {
	let response: Response;
	try {
		// Anthropic's Messages API lists models under `/v1` and takes its key as `x-api-key`; proxies often take only one of the two headers.
		const headers: Record<string, string> = key ? { authorization: `Bearer ${key}`, ...(api ? { "x-api-key": key } : {}) } : {};
		if (api) headers["anthropic-version"] = "2023-06-01";
		response = await fetch(api ? `${url}/v1/models` : `${url}/models`, { headers, signal: AbortSignal.timeout(10_000) });
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

/** Reads the settings the person gave their models: a context window, and prices that are never negative. */
function readOverrides(value: unknown): Record<string, ModelOverride> {
	if (!isObject(value)) throw new HttpError(400, "overrides must be an object of settings by model id");
	const overrides: Record<string, ModelOverride> = {};
	for (const [id, entry] of Object.entries(value)) {
		if (!MODEL_ID.test(id) || !isObject(entry)) throw new HttpError(400, "overrides must be an object of settings by model id");
		const { contextWindow, maxTokens, cost } = entry;
		if (contextWindow !== undefined && !count(contextWindow)) throw new HttpError(400, `${id}'s contextWindow must be a whole number of tokens`);
		if (maxTokens !== undefined && !count(maxTokens)) throw new HttpError(400, `${id}'s maxTokens must be a whole number of tokens`);
		let price: ModelCost | undefined;
		if (cost !== undefined) {
			if (!isObject(cost)) throw new HttpError(400, `${id}'s cost must be an object`);
			const dollars = (field: keyof ModelCost): number => {
				const value = cost[field] ?? 0;
				if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new HttpError(400, `${id}'s cost ${field} must be a price in dollars per million tokens`);
				return value;
			};
			price = { input: dollars("input"), output: dollars("output"), cacheRead: dollars("cacheRead"), cacheWrite: dollars("cacheWrite") };
		}
		if (contextWindow !== undefined || maxTokens !== undefined || price) {
			overrides[id] = { ...(contextWindow !== undefined && { contextWindow: contextWindow as number }), ...(maxTokens !== undefined && { maxTokens: maxTokens as number }), ...(price && { cost: price }) };
		}
	}
	return overrides;
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
	if (input.structuredOutput !== undefined && typeof input.structuredOutput !== "boolean") throw new HttpError(400, "structuredOutput must be true or false");
	if (input.api !== undefined && input.api !== "openai-completions" && input.api !== "anthropic-messages") throw new HttpError(400, "api must be openai-completions or anthropic-messages");
	if (preset && input.api !== undefined) throw new HttpError(400, "A built-in provider's API cannot be changed");
	if (preset && input.overrides !== undefined) throw new HttpError(400, "A built-in provider's models cannot be given other limits or prices");
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

	const api = input.api === undefined ? existing?.api : input.api === "anthropic-messages" ? "anthropic-messages" : undefined;
	let listed: Record<string, unknown>[] | null = null;
	let unlisted: string | null = null;
	try {
		listed = await listModels(url, key, api);
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
	const given = input.overrides === undefined ? (existing?.overrides ?? {}) : readOverrides(input.overrides);
	const models = (chosen ?? listed!.map((entry) => entry.id as string)).map((id) =>
		describe(
			id,
			listed?.find((entry) => entry.id === id),
			known.get(id),
			given[id],
		),
	);
	const overrides: Record<string, ModelOverride> = {};
	for (const { id } of models) if (given[id]) overrides[id] = given[id];

	let id = existing?.id;
	if (!id) {
		const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "provider";
		id = base;
		for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	}
	const structuredOutput = input.structuredOutput === undefined ? existing?.structuredOutput === true : input.structuredOutput;
	return { id, name, url, key, chosen, models, structuredOutput, ...(api && { api }), ...(Object.keys(overrides).length > 0 && { overrides }) };
}

/**
 * The output limit a stored model runs with, and where it came from. One whose
 * limit is the heuristic follows the current heuristic, so models saved before
 * it grew need no new save. A model saved before the source was kept, with
 * 8192 and no override, is taken for one: that was every model without
 * metadata, and the catalog can't be read here without waiting. A person's
 * override is never rewritten, and any other legacy limit stays, with no
 * source shown, as does one with a source other than estimated. A server that truly lists 8192 is kept by saving the provider
 * again (which reads the listing) or by setting an override.
 */
function outputLimit(overrides: CustomProvider["overrides"], model: ProviderModel): { maxTokens: number; maxTokensSource?: MaxTokensSource } {
	if (model.native) return { maxTokens: model.maxTokens, maxTokensSource: "catalog" };
	const set = overrides?.[model.id]?.maxTokens !== undefined;
	const source = model.maxTokensSource ?? (set ? "override" : model.maxTokens === LEGACY_FALLBACK ? "estimated" : undefined);
	return { maxTokens: source === "estimated" ? fallbackMaxTokens(model.contextWindow) : model.maxTokens, maxTokensSource: source };
}

export function providerInfo({ key, ...provider }: CustomProvider): ProviderInfo {
	return { ...provider, models: provider.models.map(({ native, ...model }) => ({ ...model, ...outputLimit(provider.overrides, model) })), hasKey: key !== null };
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
		api: provider.api ?? "openai-completions",
		provider: catalogId,
		baseUrl: provider.url,
		input: model.images ? ["text", "image"] : ["text"],
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: outputLimit(provider.overrides, model).maxTokens,
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(provider.api ? {} : { compat: { supportsDeveloperRole: false } }),
	} as Model<Api>;
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
					auth:
						provider.builtin === "openrouter"
							? { headers: { Authorization: `Bearer ${provider.key}` } }
							: // A gateway in front of the Messages API may want the key as a bearer token rather than `x-api-key`, so a custom one gets both.
								provider.api && provider.key
								? { apiKey: provider.key, headers: { Authorization: `Bearer ${provider.key}` } }
								: { apiKey: provider.key ?? "none" },
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
	if (provider.api) {
		return { ...configured, stream: withKnownCompat(configured.stream), streamSimple: withKnownCompat(configured.streamSimple) };
	}
	if (!provider.builtin) return configured;
	return {
		...configured,
		stream: nativeStream(configured.stream, provider.builtin),
		streamSimple: nativeStream(configured.streamSimple, provider.builtin),
	};
}

/**
 * A Claude model on a custom Messages endpoint is sent the requests pi-ai
 * makes for that model, which depend on its compat flags: a model that takes
 * only adaptive thinking is refused a thinking budget. A custom model has
 * none of its own, so they come from pi-ai's catalog when it knows the id.
 *
 * Any other model there, such as Gemini behind a gateway that speaks the
 * Messages API, is sent tool schemas with a type on every node, which Gemini
 * needs and JSON Schema doesn't, and tool results without `is_error`, which
 * the gateway's translation refuses (see ./typed-schemas.ts). Claude's
 * requests are sent as pi-ai makes them.
 */
function withKnownCompat<T extends StreamOptions>(stream: StreamFunction<Api, T>): StreamFunction<Api, T> {
	return (model, context, options) => lazyStream(model, async () => {
		const known = (await knownModels()).get(model.id);
		const catalogued = known?.api === "anthropic-messages" ? { ...model, compat: known.compat, thinkingLevelMap: known.thinkingLevelMap } : model;
		const claude = known?.api === "anthropic-messages" || /claude/i.test(model.id);
		const sent = withoutThinkingMidToolRound(context, options);
		return stream(catalogued, withoutEmptyAnswers(context, catalogued), claude ? sent : withTypedTools(sent));
	});
}

/** `options` whose request, once whoever else reads it has, goes with its tool schemas typed throughout and its tool results plain. */
function withTypedTools<T extends StreamOptions>(options: T | undefined): T {
	const onPayload = options?.onPayload;
	return {
		...options,
		onPayload: async (params: unknown, model: Model<Api>) => withPlainToolResults(withTypedToolSchemas((await onPayload?.(params, model)) ?? params)),
	} as T;
}

/**
 * An answer that says nothing is dropped from a request, because it comes out as an empty turn and the system message
 * pi-ai holds back for the next answer then lands before a user message instead, which Claude refuses: "role 'system'
 * must precede an 'assistant' message or end the array". Another provider's answer that is only encrypted reasoning is
 * one; an errored or aborted turn, or one of blank text, is another, whichever provider made it. For Claude's own API
 * the test is pi-ai's: an answer is kept when it has a tool call, text, or reasoning that is redacted, signed or not blank.
 * Other APIs keep the answers they always did, which are Claude's own.
 */
function withoutEmptyAnswers<C extends { messages: Context["messages"] }>(context: C, model: Model<Api>): C {
	const says = (message: Context["messages"][number]) => {
		if (message.role !== "assistant") return true;
		if (model.api !== "anthropic-messages") return message.api === "anthropic-messages" || message.content.some((block) => block.type === "toolCall" || (block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "").trim() !== "");
		// Reasoning is only sent back, signed or redacted, to the model that made it; another model's is sent as text.
		const same = message.provider === model.provider && message.api === model.api && message.model === model.id;
		return message.content.some(
			(block) =>
				block.type === "toolCall" ||
				(block.type === "text" ? block.text.trim() !== "" : (same && (block.redacted === true || !!block.thinkingSignature?.trim())) || block.thinking.trim() !== ""),
		);
	};
	return context.messages.every(says) ? context : { ...context, messages: context.messages.filter(says) };
}

/**
 * Claude refuses a request that has thinking on when the tool round it continues was started by an answer with no
 * thinking of its own, which is what another provider's answer is once sent on: a chat that switches provider after
 * a failed model, then Tries again, would stop with a 400. That one request goes without thinking instead.
 */
function withoutThinkingMidToolRound<T extends StreamOptions>(context: Context, options: T | undefined): T | undefined {
	if (!options) return options;
	const messages = context.messages.filter((message) => message.role === "toolResult" || (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") || message.role === "user");
	let last = messages.length - 1;
	while (last >= 0 && messages[last]?.role === "toolResult") last--;
	const starter = messages[last];
	if (last === messages.length - 1 || starter?.role !== "assistant") return options;
	const thinks = starter.content.some((block) => block.type === "thinking" && (block.redacted || !!block.thinkingSignature) && starter.api === "anthropic-messages");
	if (thinks) return options;
	const { reasoning: _reasoning, thinkingEnabled: _thinkingEnabled, ...rest } = options as T & { reasoning?: unknown; thinkingEnabled?: unknown };
	return rest as T;
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
		for await (const event of stream(native, model.api === "anthropic-messages" ? withoutEmptyAnswers(transcript, native) : transcript, options)) {
			if (event.type === "done") yield { ...event, message: { ...event.message, provider: model.provider } };
			else if (event.type === "error") yield { ...event, error: { ...event.error, provider: model.provider } };
			else yield { ...event, partial: { ...event.partial, provider: model.provider } };
		}
	})());
}
