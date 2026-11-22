import { BadRequestError } from "./errors.ts";
import type { Provider } from "./providers.ts";

/**
 * The web app's provider forms and cards over the application's providers: the app sends `{ builtin | url, name, key, models }` and shows `{ id, builtin, name, url, hasKey, chosen, models }`,
 * the services store `{ kind, name, apiKey, config }`. A custom endpoint's models are the ones named, or what its `/models` lists; a built-in service's models come from the Runner's catalog.
 */
const BUILTIN = ["anthropic", "openai", "google"];
const BUILTIN_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI API", google: "Google Gemini" };

export const isWebProviderInput = (body: Record<string, any>) => ["builtin", "url", "key", "models"].some((k) => k in body) && !("kind" in body) && !("apiKey" in body);

type ListedModel = { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; images?: boolean };
type Overrides = Record<string, { contextWindow?: number; maxTokens?: number; images?: boolean; cost?: Record<"input" | "output" | "cacheRead" | "cacheWrite", number> }>;

/** What pi-ai's catalog knows of a model by its id. */
export type KnownModel = { contextWindow: number; maxTokens: number; images: boolean; reasoning: boolean };

/**
 * What only the Worker's process can answer, because pi-ai is its dependency and not this package's: the model ids of a built-in service, and what pi-ai's catalog knows of a model by its id.
 * `modelRoutes` (`@pim/v2-server`) sets them; without them a built-in's models are not checked and a card shows only what the listing said.
 */
export const providerCatalog: { builtin?: (id: string) => readonly string[] | undefined; known?: (id: string) => KnownModel | undefined } = {};

/**
 * The longest answer of a model with no metadata: a quarter of its context window, at most 32768 (v1's `src/providers.ts`). Reasoning tokens count in it, and 8192 let a reasoning model
 * spend it all thinking, with no answer or tool call left. A heuristic, not a limit any model supports; a person can set the real one as the model's `maxTokens`.
 */
export const fallbackMaxTokens = (contextWindow: number) => Math.min(32_768, Math.floor(contextWindow / 4));

const MAX_LISTED = 50;
const MAX_CHOSEN = 50;
const MODEL_ID = /^[A-Za-z0-9][\w.:@/+-]{0,199}$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | undefined => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined);

/**
 * The models the server at `url` lists, with what it says of each (v1's `describe`): OpenRouter's `context_length` and `top_provider`, vLLM's `max_model_len`, llama.cpp's `n_ctx`,
 * `max_completion_tokens` and `max_output_tokens` as gateways give them, Gemini's `outputTokenLimit`, the input modalities and the supported parameters. Throws with why it could not.
 */
async function listed(url: string, key: string | undefined, api: unknown, fetcher: typeof fetch): Promise<ListedModel[]> {
	let response: Response;
	try {
		// Anthropic's Messages API lists models under `/v1` and takes its key as `x-api-key`; proxies often take only one of the two headers.
		const headers: Record<string, string> = key ? { authorization: `Bearer ${key}`, ...(api ? { "x-api-key": key } : {}) } : {};
		if (api) headers["anthropic-version"] = "2023-06-01";
		response = await fetcher(api ? `${url}/v1/models` : `${url}/models`, { headers, signal: AbortSignal.timeout(10_000) });
	} catch (error) {
		throw new Error(error instanceof Error && error.name === "TimeoutError" ? "it didn't answer in 10 seconds" : "it couldn't be reached");
	}
	if (!response.ok) throw new Error(`it answered ${response.status}`);
	const body: unknown = await response.json().catch(() => null);
	const data = isObject(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : null;
	if (!data) throw new Error("its answer isn't a list of models");
	return data.filter((entry): entry is Record<string, unknown> & { id: string } => isObject(entry) && typeof entry.id === "string" && MODEL_ID.test(entry.id)).map((entry) => {
		const modalities = Array.isArray(isObject(entry.architecture) ? entry.architecture.input_modalities : undefined) ? ((entry.architecture as Record<string, unknown>).input_modalities as unknown[]) : undefined;
		const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : undefined;
		const top = isObject(entry.top_provider) ? entry.top_provider : undefined;
		const meta = isObject(entry.meta) ? entry.meta : undefined;
		const contextWindow = count(entry.context_length) ?? count(entry.max_model_len) ?? count(meta?.n_ctx);
		const maxTokens = count(top?.max_completion_tokens) ?? count(entry.max_completion_tokens) ?? count(entry.max_output_tokens) ?? count(entry.outputTokenLimit) ?? count(entry.max_tokens);
		return {
			id: entry.id,
			...(typeof entry.name === "string" && entry.name.trim() ? { name: entry.name.trim() } : {}),
			...(contextWindow ? { contextWindow } : {}),
			...(maxTokens ? { maxTokens } : {}),
			...(modalities ? { images: modalities.includes("image") } : {}),
			...(parameters ? { reasoning: parameters.includes("reasoning") } : {}),
		};
	});
}

/** What a person set for a custom endpoint's models where the server cannot say: a context window, a longest answer, whether it reads images, prices that are never negative (v1's `readOverrides`). */
function readOverrides(value: unknown): Overrides {
	if (!isObject(value)) throw new BadRequestError("overrides must be an object of settings by model id");
	const overrides: Overrides = {};
	for (const [id, entry] of Object.entries(value)) {
		if (!MODEL_ID.test(id) || !isObject(entry)) throw new BadRequestError("overrides must be an object of settings by model id");
		const { contextWindow, maxTokens, images, cost } = entry;
		if (contextWindow !== undefined && !count(contextWindow)) throw new BadRequestError(`${id}'s contextWindow must be a whole number of tokens`);
		if (maxTokens !== undefined && !count(maxTokens)) throw new BadRequestError(`${id}'s maxTokens must be a whole number of tokens`);
		if (images !== undefined && typeof images !== "boolean") throw new BadRequestError(`${id}'s images must be true or false`);
		let price: Overrides[string]["cost"];
		if (cost !== undefined) {
			if (!isObject(cost)) throw new BadRequestError(`${id}'s cost must be an object`);
			const dollars = (field: "input" | "output" | "cacheRead" | "cacheWrite"): number => {
				const amount = cost[field] ?? 0;
				if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) throw new BadRequestError(`${id}'s cost ${field} must be a price in dollars per million tokens`);
				return amount;
			};
			price = { input: dollars("input"), output: dollars("output"), cacheRead: dollars("cacheRead"), cacheWrite: dollars("cacheWrite") };
		}
		if (contextWindow !== undefined || maxTokens !== undefined || images !== undefined || price) overrides[id] = { ...(contextWindow !== undefined && { contextWindow: contextWindow as number }), ...(maxTokens !== undefined && { maxTokens: maxTokens as number }), ...(images !== undefined && { images }), ...(price && { cost: price }) };
	}
	return overrides;
}

/**
 * The services' input for what the web app sent, checked as v1 checked it. `existing` is the provider being changed, when it is one, and `existingKey` its key, which a change that
 * leaves the key out keeps and so uses to read the server's models. A built-in service needs a key and models of the catalog, and no address; a custom endpoint's models are read from its
 * `/models`, which must answer with the key (a refusal says so), list the ones named, and not list more than can be offered without naming some.
 */
export async function toServiceInput(body: Record<string, any>, existing?: Provider, options: { existingKey?: string | null; fetcher?: typeof fetch } = {}): Promise<{ kind: string; name?: string; apiKey?: string | null; config: Record<string, unknown> }> {
	const fetcher = options.fetcher ?? fetch;
	const builtin = (body.builtin ?? existing?.config.builtin) as string | undefined;
	if (builtin !== undefined && !BUILTIN.includes(builtin)) throw new BadRequestError(`builtin is one of ${BUILTIN.join(", ")}`);
	if (existing && body.builtin !== undefined && body.builtin !== existing.config.builtin) throw new BadRequestError("A provider's type cannot be changed. Add another provider instead.");
	if (builtin && body.url !== undefined) throw new BadRequestError("A built-in provider's address cannot be changed");
	if (builtin && body.api !== undefined) throw new BadRequestError("A built-in provider's API cannot be changed");
	if (builtin && body.overrides !== undefined) throw new BadRequestError("A built-in provider's models cannot be given other limits or prices");
	const url = builtin ? undefined : ((body.url ?? existing?.config.baseUrl ?? existing?.config.url) as string | undefined);
	if (!builtin && !(typeof url === "string" && /^https?:\/\//.test(url))) throw new BadRequestError("url must be an http(s) address, such as http://localhost:1234/v1");
	if (body.key !== undefined && body.key !== null && typeof body.key !== "string") throw new BadRequestError("key must be a string");
	if (typeof body.key === "string" && body.key.trim().length > 2000) throw new BadRequestError("key must be at most 2000 characters");
	if (body.structuredOutput !== undefined && typeof body.structuredOutput !== "boolean") throw new BadRequestError("structuredOutput must be true or false");
	if (body.api !== undefined && body.api !== "openai-completions" && body.api !== "anthropic-messages") throw new BadRequestError("api must be openai-completions or anthropic-messages");
	const config: Record<string, unknown> = {};
	if (builtin) config.builtin = builtin;
	else config.baseUrl = url!.replace(/\/+$/, "");
	// A key left out stays; an empty one is taken away.
	const given = body.key === undefined ? undefined : body.key === null ? "" : String(body.key).trim();
	const key = given === undefined ? (existing ? (options.existingKey ?? undefined) : undefined) : given === "" ? undefined : given;
	if (builtin && !key && !(given === undefined && existing?.hasKey)) throw new BadRequestError("An API key is required");
	let chosen = (existing?.config.chosen ?? null) as string[] | null;
	if (body.models !== undefined) {
		if (body.models !== null && (!Array.isArray(body.models) || body.models.some((id: unknown) => typeof id !== "string" || !MODEL_ID.test(id.trim())))) throw new BadRequestError("models must be a list of model ids");
		const ids = [...new Set(((body.models ?? []) as string[]).map((id) => id.trim()))];
		if (ids.length > MAX_CHOSEN) throw new BadRequestError(`Name at most ${MAX_CHOSEN} models`);
		chosen = ids.length === 0 ? null : ids;
		config.chosen = chosen;
	}
	if (body.structuredOutput !== undefined) config.structuredOutput = body.structuredOutput;
	if (body.api !== undefined) config.api = body.api;
	if (builtin) {
		const offered = providerCatalog.builtin?.(builtin);
		if (!chosen) throw new BadRequestError("Choose at least one model");
		const missing = offered && chosen.find((id) => !offered.includes(id));
		if (missing) throw new BadRequestError(`${BUILTIN_NAMES[builtin]} doesn't offer a model ${missing} in Pim's catalog`);
	} else {
		const address = config.baseUrl as string;
		const api = (body.api ?? existing?.config.api) as string | undefined;
		let found: ListedModel[] | null = null;
		let unlisted = "";
		try {
			found = await listed(address, key, api === "anthropic-messages" ? api : undefined, fetcher);
		} catch (error) {
			unlisted = error instanceof Error ? error.message : String(error);
		}
		if (chosen === null) {
			if (!found) throw new BadRequestError(`Pim couldn't read the models at ${address}: ${unlisted}. Check the address and key, or name the models to use.`);
			if (found.length === 0) throw new BadRequestError(`${address} lists no models. Load one, or name the models to use.`);
			if (found.length > MAX_LISTED) throw new BadRequestError(`${address} lists ${found.length} models. Name the ones to use.`);
		} else if (found) {
			const missing = chosen.find((id) => !found!.some((entry) => entry.id === id));
			if (missing) throw new BadRequestError(`${address} doesn't list a model ${missing}`);
		}
		const overrides = body.overrides === undefined ? ((existing?.config.overrides ?? {}) as Overrides) : readOverrides(body.overrides);
		// What the listing said of a model stays when the server cannot be asked again.
		const before = (existing?.config.models ?? []) as ListedModel[];
		const ids = chosen ?? found!.map((m) => m.id);
		const models = ids.map((id) => ({ ...(found?.find((m) => m.id === id) ?? before.find((m) => m.id === id) ?? { id }), ...overrides[id] }));
		config.models = models;
		config.overrides = Object.fromEntries(models.flatMap((m) => (overrides[m.id] ? [[m.id, overrides[m.id]]] : [])));
	}
	return { kind: builtin ?? "openai_compatible", ...(body.name ? { name: String(body.name) } : {}), ...(given === undefined ? {} : { apiKey: given === "" ? null : given }), config };
}

/** What the card shows of a provider: never its key. */
export function toWebProvider(p: Provider) {
	const c = p.config as Record<string, any>;
	// What a card says of a model: what the person set, then what the server listed, then what pi-ai's catalog knows of that id, then the defaults of a text-only model.
	const stored = ((c.models ?? (c.builtin && Array.isArray(c.chosen) ? c.chosen.map((id: string) => ({ id })) : [])) as (ListedModel & { cost?: unknown })[]);
	const models = stored.map((m) => {
		const known = providerCatalog.known?.(m.id);
		const contextWindow = m.contextWindow ?? known?.contextWindow ?? 128_000;
		const limit = m.maxTokens ?? known?.maxTokens ?? fallbackMaxTokens(contextWindow);
		const source = c.overrides?.[m.id]?.maxTokens ? "override" : m.maxTokens ? "listing" : known?.maxTokens ? "catalog" : "estimated";
		// An answer is never the whole context: a limit that large leaves no room for the input, so half is kept.
		return { id: m.id, name: m.name ?? m.id, contextWindow, maxTokens: limit < contextWindow ? limit : Math.floor(contextWindow / 2), maxTokensSource: source, images: m.images ?? known?.images ?? false, reasoning: m.reasoning ?? known?.reasoning ?? false, ...(m.cost ? { cost: m.cost } : {}) };
	});
	return {
		id: p.id,
		...(c.builtin ? { builtin: c.builtin } : {}),
		name: p.name,
		url: c.baseUrl ?? c.url ?? "",
		hasKey: p.hasKey,
		chosen: (c.chosen ?? null) as string[] | null,
		models,
		shared: false,
		...(c.structuredOutput !== undefined ? { structuredOutput: c.structuredOutput } : {}),
		...(c.api ? { api: c.api } : {}),
		...(c.overrides && Object.keys(c.overrides).length > 0 ? { overrides: c.overrides } : {}),
	};
}
