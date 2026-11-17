/**
 * What `window.pim.ask` runs: one prompt to the model the person chose (their utility model, else the model agents run on, else the deployment's default), answered
 * as asked and with no tools. The Gate has no model catalog (the Runner builds that), so it reaches the endpoints directly: the deployment's gateway and a person's
 * own OpenAI-compatible providers over chat completions, and Anthropic and OpenAI by key (the person's, else the deployment's). Google and the ChatGPT plan are
 * not reached from here.
 */
import type { App } from "@pim/v2-app/app";
import { BadRequestError, PimError } from "@pim/v2-app/errors";
import type { Principal } from "@pim/v2-contracts/identity";

type Env = Record<string, string | undefined>;
type ModelRef = { provider: string; id: string };

/** How the model is told to answer a page: as asked, in the format asked, with no preamble. */
export const ARTIFACT_ASK = "You answer requests from a small app that a person's AI assistant made for them, which they are using now. Do what the request asks and reply with only that, in the format it asks for, with no preamble. You can't use tools or see anything but the request.";
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 60_000;

const parse = (v: string | undefined): ModelRef | null => (v && v.includes("/") ? { provider: v.split("/")[0]!, id: v.split("/").slice(1).join("/") } : null);

async function setting(app: App, ownerId: string, key: string): Promise<ModelRef | null> {
	return app.db.owner(ownerId, async (tx) => (await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = $1", [key])).rows[0]?.value ?? null);
}

export async function askModel(app: App, p: Principal, env: Env, prompt: string, fetcher: typeof fetch = fetch): Promise<string> {
	const providers = await app.providers.list(p);
	const chosen = (await setting(app, p.ownerId, "model_utility")) ?? (await setting(app, p.ownerId, "model")) ?? parse(env.PIM_DEFAULT_MODEL);
	if (!chosen) throw new PimError(503, "no_model", "No model is set up to answer. Choose one in Settings.");
	// A person's provider is saved by its id, and named `own:<id>` or by id in a model reference.
	const providerId = chosen.provider.replace(/^own:/, "");
	const own = providers.find((r) => r.id === providerId);
	const kind = own ? ((own.config.builtin as string | undefined) ?? own.kind) : chosen.provider;
	const ownKey = own?.hasKey ? await app.providers.reveal(p.ownerId, own.id) : null;
	const post = async (url: string, headers: Record<string, string>, body: unknown) => {
		const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) throw new PimError(502, "model_failed", `The model answered ${res.status}.`);
		return (await res.json()) as any;
	};
	const chat = async (base: string, key: string | null) => {
		const r = await post(`${base.replace(/\/$/, "")}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, { model: chosen.id, stream: false, max_tokens: MAX_TOKENS, messages: [{ role: "system", content: ARTIFACT_ASK }, { role: "user", content: prompt }] });
		return String(r?.choices?.[0]?.message?.content ?? "");
	};
	if (chosen.provider === "gateway") {
		if (!env.PIM_AI_GATEWAY_URL) throw new PimError(503, "no_model", "This Pim has no model gateway.");
		return chat(env.PIM_AI_GATEWAY_URL, env.PIM_AI_GATEWAY_KEY ?? null);
	}
	if (own && (own.kind === "openai_compatible" || own.kind === "custom")) {
		const url = own.config.baseUrl ?? own.config.url;
		if (typeof url !== "string") throw new PimError(503, "no_model", "That provider has no address.");
		return chat(url, ownKey);
	}
	if (kind === "openai") {
		const key = ownKey ?? env.OPENAI_API_KEY;
		if (!key) throw new PimError(503, "no_model", "OpenAI has no key set.");
		return chat("https://api.openai.com/v1", key);
	}
	if (kind === "anthropic") {
		const key = ownKey ?? env.ANTHROPIC_API_KEY;
		if (!key) throw new PimError(503, "no_model", "Anthropic has no key set.");
		const r = await post("https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, { model: chosen.id, max_tokens: MAX_TOKENS, system: ARTIFACT_ASK, messages: [{ role: "user", content: prompt }] });
		return ((r?.content ?? []) as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
	}
	throw new BadRequestError(`An app can't ask ${chosen.provider} models from this Pim yet.`);
}
