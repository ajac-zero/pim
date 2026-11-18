/**
 * pi-ai's OpenAI catalog, plus the current models its pinned release (1.1.0) does not list yet. The ChatGPT plan's models and the OpenAI API
 * service both come from it, so a model listed here is a choice in Settings and one the Runner can run. Drop an entry once the pinned pi-ai lists the model itself.
 *
 * `gpt-6.1-terra`: OpenAI's model page gives the id, text and image input, 128,000 output tokens, reasoning effort none to max, and $1 / $0.05 cached / $5 per million tokens;
 * Codex's own model list (openai/codex) gives the plan a 500,000-token window for it, where the API's is 1,050,000. pi-ai 1.5.2 lists it the same way for the plan.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const TERRA = {
	id: "gpt-6.1-terra",
	name: "GPT-6.1 Terra",
	cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }] },
	contextWindow: 500_000,
	maxTokens: 128_000,
	// Unlike GPT-6.1 Sol, Terra can answer with reasoning off.
	thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};

/** The listed models with the missing current ones added, each a copy of its sibling GPT-6.1 Sol's wiring (API, base URL, compat). */
export function withCurrentModels<T extends Model<Api>>(listed: readonly T[]): T[] {
	const sol = listed.find((m) => m.id === "gpt-6.1-sol");
	if (!sol || listed.some((m) => m.id === TERRA.id)) return [...listed];
	return [...listed, { ...sol, ...TERRA } as T];
}

/** pi-ai's OpenAI provider, listing the current models too. */
export function currentOpenaiProvider() {
	const base = openaiProvider();
	return { ...base, getModels: () => withCurrentModels(base.getModels() as readonly Model<Api>[]), ...(base.getAllModels ? { getAllModels: () => withCurrentModels(base.getAllModels!() as readonly Model<Api>[]) } : {}) } as typeof base;
}
