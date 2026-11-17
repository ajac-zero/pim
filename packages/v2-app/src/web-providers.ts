import { BadRequestError } from "./errors.ts";
import type { Provider } from "./providers.ts";

/**
 * The web app's provider forms and cards over the application's providers: the app sends `{ builtin | url, name, key, models }` and shows `{ id, builtin, name, url, hasKey, chosen, models }`,
 * the services store `{ kind, name, apiKey, config }`. A custom endpoint's models are the ones named, or what its `/models` lists; a built-in service's models come from the Runner's catalog.
 */
const BUILTIN = ["anthropic", "openai", "google"];

export const isWebProviderInput = (body: Record<string, any>) => ["builtin", "url", "key", "models"].some((k) => k in body) && !("kind" in body) && !("apiKey" in body);

type ListedModel = { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; images?: boolean };

async function listed(url: string, key: string | undefined, fetcher: typeof fetch): Promise<ListedModel[]> {
	try {
		const response = await fetcher(`${url.replace(/\/+$/, "")}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return [];
		const body = (await response.json()) as { data?: { id?: unknown }[] };
		return (body.data ?? []).flatMap((m) => (typeof m.id === "string" ? [{ id: m.id }] : [])).slice(0, 50);
	} catch {
		return [];
	}
}

/** The services' input for what the web app sent. `existing` is the provider being changed, when it is one. */
export async function toServiceInput(body: Record<string, any>, existing?: Provider, fetcher: typeof fetch = fetch): Promise<{ kind: string; name?: string; apiKey?: string | null; config: Record<string, unknown> }> {
	const builtin = (body.builtin ?? existing?.config.builtin) as string | undefined;
	if (builtin !== undefined && !BUILTIN.includes(builtin)) throw new BadRequestError(`builtin is one of ${BUILTIN.join(", ")}`);
	if (existing && body.builtin !== undefined && body.builtin !== existing.config.builtin) throw new BadRequestError("A provider's type cannot be changed. Add another provider instead.");
	const url = builtin ? undefined : ((body.url ?? existing?.config.baseUrl) as string | undefined);
	if (!builtin && !(typeof url === "string" && /^https?:\/\//.test(url))) throw new BadRequestError("url must be an http(s) address, such as http://localhost:1234/v1");
	const config: Record<string, unknown> = {};
	if (builtin) config.builtin = builtin;
	else config.baseUrl = url!.replace(/\/+$/, "");
	if (body.models !== undefined) config.chosen = body.models;
	if (body.structuredOutput !== undefined) config.structuredOutput = body.structuredOutput === true;
	if (body.api !== undefined) config.api = body.api;
	if (body.overrides !== undefined) config.overrides = body.overrides;
	const key = body.key === undefined ? undefined : String(body.key);
	if (!builtin) {
		const chosen = (body.models ?? existing?.config.chosen) as string[] | null | undefined;
		const overrides = (body.overrides ?? existing?.config.overrides ?? {}) as Record<string, Omit<ListedModel, "id">>;
		const ids: ListedModel[] = Array.isArray(chosen) ? chosen.map((id) => ({ id })) : await listed(url!, key, fetcher);
		config.models = ids.map((m) => ({ ...m, ...overrides[m.id] }));
	}
	return { kind: builtin ?? "openai_compatible", ...(body.name ? { name: String(body.name) } : {}), ...(key === undefined ? {} : { apiKey: key === "" ? null : key }), config };
}

/** What the card shows of a provider: never its key. */
export function toWebProvider(p: Provider) {
	const c = p.config as Record<string, any>;
	const models = ((c.models ?? []) as ListedModel[]).map((m) => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow ?? 128_000, maxTokens: m.maxTokens ?? 8_192, images: m.images === true, reasoning: m.reasoning === true }));
	return {
		id: p.id,
		...(c.builtin ? { builtin: c.builtin } : {}),
		name: p.name,
		url: c.baseUrl ?? "",
		hasKey: p.hasKey,
		chosen: (c.chosen ?? null) as string[] | null,
		models,
		shared: false,
		...(c.structuredOutput !== undefined ? { structuredOutput: c.structuredOutput } : {}),
		...(c.api ? { api: c.api } : {}),
		...(c.overrides ? { overrides: c.overrides } : {}),
	};
}
