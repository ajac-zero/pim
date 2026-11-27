/**
 * What a deployed Runner runs its agents with, so that a `runner` role executes real Pim agents without anything injected:
 *
 * - the model catalog of each owner: the standard pi-ai providers (Anthropic, OpenAI, Google) with the deployment's keys from the process environment, an OpenAI-compatible
 *   gateway (`PIM_AI_GATEWAY_URL`, `PIM_AI_GATEWAY_KEY`, `PIM_AI_GATEWAY_MODELS`), and the owner's own providers (`pim_app.providers`, their keys opened with the deployment's
 *   key ring); every model call is metered into `pim_app.model_calls`;
 * - the agent a chat answers as (`runner_context`, a narrow read in migration 0604), and the prompt context built from it afresh for every request: the agent, its skills,
 *   the memories of its scopes, and the agents it may delegate to;
 * - the tool registry (`./agent-tools.ts`), built for the partition's owner.
 *
 * The Runner connects as `pim_runtime`, which has no grant on `pim_app`: what the host reads from the application goes through the definer functions of 0604. What the tools write
 * needs the application's services, so it needs `PIM_APP_DATABASE_URL`, a login that is a member of the gate role; without it a tool that needs them says so, and
 * `send_to_user`, `current_time` and `fetch_url` still work. The model catalog is built when a partition is opened and lives as long as it is resident: a provider or key
 * an owner changes is seen by the partitions opened after the change (an idle partition is released after a short while, by default 30 seconds).
 */
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, createModels, type Models, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { createRegistry, defineExtension, GenerationTask, hook, section, type HarnessOptions } from "@earendil-works/pi-durable";
import { deliveryOwed, DELIVERY_REMINDER, enforceDelivery, LENGTH_REMINDER, NOT_DELIVERED, ROOM_POST } from "@pim/shared/transcript";
import type { App } from "@pim/v2-app/app";
import { deploymentLimits, QUOTA_MESSAGE } from "@pim/v2-app/quota";
import { acquireRemote, type RelayBus } from "@pim/v2-app/relay";
import { openString, type KeyringCrypto } from "@pim/v2-app/crypto";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import type { PartitionContext, RunnerOptions } from "@pim/v2-runtime/runner";
import { chatToolLimits, pimExtension, timeZoneOf, type ToolDeps } from "./agent-tools.ts";
import { BUILTIN_SKILLS } from "./builtin-skills.ts";
import { CodexImagesClient } from "./codex-images.ts";
import { imageEndpoints } from "./image-tools.ts";
import { hostopsExtension } from "./hostops/tools.ts";
import { fileChangesBlock } from "./file-changes.ts";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { chatgptCredentialStore, chatgptProvider, type ChatGPTRunnerOptions, type CredentialDb } from "./chatgpt-auth.ts";
import type { ForgeParts } from "./forge-assembly.ts";
import { mentionedAgents } from "./rooms.ts";
import { markHistoryBeforeUpdate, withStablePrefix } from "./stable-prefix.ts";
import { agentsSection, ASSISTANT_INSTRUCTIONS, delegatesSection, identity, majordomoRole, MAX_TASK_DEPTH, pimbotRole, NO_CODING_SANDBOX_LINE, startedBySection, type Roster } from "./agent-prompts.ts";
import { createFingerprinter } from "./request-fingerprint.ts";
import { createFailover, failureKind, failureMessage } from "./provider-failover.ts";
import { DESCRIBE_WORK, runUtility } from "./compat/utility.ts";
import { Progress } from "./progress.ts";
import { priceOf } from "./model-prices.ts";
import { withTypedTools } from "./typed-schemas.ts";
import { type KeptCall, takeCall } from "./call-details.ts";
import { fallbackMaxTokens } from "@pim/v2-app/web-providers";
import { memoryLinesOf, offeredModels } from "./deployment.ts";
import { memoryView } from "./memory-tree.ts";
import { type VisitBrief, visitMemory, visitPreamble } from "./visit-brief.ts";
import { createTelemetry, type TelemetryInput } from "./telemetry.ts";

type Env = Record<string, string | undefined>;
type ModelRef = { provider: string; id: string };
type ProviderRow = { id: string; kind: string; config: Record<string, any>; secret: string | null; /** The deployment's own (shared with everyone), named `shared:<id>`, its key sealed for the deployment rather than for the owner. */ shared?: boolean };
export type RunnerContext = {
	username: string | null;
	agent: { id: string; name: string; instructions: string; config: Record<string, any>; /** The person's majordomo, which reads every scope. */ majordomo?: boolean } | null;
	skills: { name: string; description: string }[];
	memories: { id: string; scope: string; title: string }[];
	contacts: { id: string; name: string; about: string }[];
	fallbacks: ModelRef[];
	/** The model the person chose for this chat alone (migration 0670); it comes before the agent's own. */
	chat_model?: ModelRef | null;
};

export type AgentHostOptions = {
	db: RuntimeDb;
	env: Env;
	crypto?: KeyringCrypto | undefined;
	/** The application's services, when the Runner has an application database; the tools that write need it. */
	app?: App | undefined;
	/** Coding, when the Runner has Forge's database. */
	forge?: ForgeParts | undefined;
	/** The Relay's bus, for the tools that use the owner's paired computer; made when one is first used. */
	relay?: (() => Promise<RelayBus>) | undefined;
	/** Providers added to every owner's catalog besides those of the environment and the owner's own: the deployment's own, and tests'. */
	providers?: ((ownerId: string) => readonly Provider[] | Promise<readonly Provider[]>) | undefined;
	/** Where an owner's ChatGPT plan is signed in to and called, when not OpenAI's own (a proxy; tests). */
	chatgpt?: ChatGPTRunnerOptions | undefined;
	/** How long a failed model is skipped. */
	cooldowns?: { transientMs?: number; authMs?: number } | undefined;
	/** How long a model stream may stay silent before it is cut off, and how long a tool may run before its call ends with an error. */
	stallMs?: { stream?: number; tool?: number } | undefined;
	fetch?: typeof fetch | undefined;
	now?: (() => number) | undefined;
	/** Where traces go instead of the collector the environment names; tests. */
	telemetry?: Pick<TelemetryInput, "exporter" | "immediate"> | undefined;
};

/** What the catalog calls a provider the deployment shares with everyone. */
const SHARED = "shared:";

/**
 * How every agent talks to the person and the rules no agent's instructions change, v1's preamble
 * (src/extensions/agents.ts). It opens the `agent` section; without it a model answers in plain
 * text, which the chat never shows.
 */
const AGENT_PREAMBLE = `You are an AI agent working for one person. Who you are and how you work follows below.

How you talk to the person:
- They see only what you send with \`send_to_user\`. Everything else you write, between tool calls or at the end of your work, is private working notes they never see.
- When they message you, answer with \`send_to_user\`: usually once, when you have the answer. A successful send finishes the turn by default: call it separately, after all other tools. For long work, a short note first with \`complete: false\` is fine, but you must still send the final answer when done.
- A failed send does not finish the turn; fix it or send a chat message explaining the problem.
- When something else wakes you (a scheduled task, a connector event, an approval's decision), do the work and send only what is worth their attention. Staying silent is fine, and often right.
- Write like a capable assistant messaging them: short, warm, direct. No filler.

Rules that always hold:
- Ask before acting on the world. Tools that change things outside this conversation (sending requests, messages or purchases) need the person's approval. Calling one asks for it and waits for the decision, which the call returns with the action's result; do not retry.
- Be honest about what you can and cannot do. Never claim an action happened unless a tool result says so.
- Times: call \`current_time\` when the time matters.`;

/** What an owner's catalog is made from: a database that can read for an owner (a Runner's, or Forge's worker's, each in its own role), the key ring that opens sealed keys, and the deployment's environment. */
export type CatalogDb = CredentialDb;
export type CatalogDeps = { db: CatalogDb; crypto?: KeyringCrypto | undefined; env: Env; chatgpt?: ChatGPTRunnerOptions | undefined; providers?: AgentHostOptions["providers"] };

/**
 * The models an owner can run: pi-ai's own providers, the owner's ChatGPT plan for `openai` when they signed in with it, the deployment's gateway, the owner's own providers and
 * the ones the admin shared with everyone (`shared:<id>`), their keys opened once. Chats and pi coding threads resolve their models against the same catalog. `plan` says whether
 * `openai` runs on the owner's ChatGPT plan, a subscription whose usage limit is left until it resets.
 */
export async function ownerCatalog(deps: CatalogDeps, ownerId: string): Promise<{ models: Models; plan: boolean }> {
	const { db, crypto, env } = deps;
	const chatgpt = deps.chatgpt ?? {};
	const own = (await db.read<{ p: ProviderRow[] }>(ownerId, "SELECT pim_app.runner_providers($1) AS p", [ownerId]).catch(() => ({ rows: [{ p: [] as ProviderRow[] }] }))).rows[0]!.p;
	// What an admin shared with everyone is in every catalog as `shared:<id>`, its key opened under the admin's owner id as it was sealed. An admin's own list leaves it out.
	const sharedRows = (await db.read<{ p: (ProviderRow & { owner: string })[] }>(ownerId, "SELECT pim_app.shared_providers(true) AS p").catch(() => ({ rows: [] as { p: (ProviderRow & { owner: string })[] }[] }))).rows[0]?.p ?? [];
	const context = new Map<string, string>(sharedRows.map((r) => [`shared:${r.id}`, `provider:${r.owner}/${r.id}`]));
	const rows: ProviderRow[] = [...own.filter((r) => r.config.shared !== true), ...sharedRows.map((r) => ({ id: `shared:${r.id}`, kind: r.kind, config: r.config, secret: r.secret }))];
	const keys = new Map<string, string>();
	for (const row of rows) {
		if (!row.secret || !crypto) continue;
		try {
			// An admin's shared provider is sealed under the admin; one promoted from v1's deployment under `_instance`; the owner's own under them.
			keys.set(row.id, await openString(crypto, row.secret, context.get(row.id) ?? (row.shared ? `provider:_instance/${row.id.slice(SHARED.length)}` : `provider:${ownerId}/${row.id}`)));
		} catch {
			// A key sealed under a key this process does not hold stays unavailable, and the provider with it.
		}
	}
	// An owner signed in with ChatGPT runs `openai` on the plan: its sealed credential is read and refreshed live, not opened once.
	const plan = crypto && (await db.read<{ s: string | null }>(ownerId, "SELECT pim_app.runner_chatgpt($1) AS s", [ownerId]).then((r) => r.rows[0]?.s, () => null)) ? chatgptCredentialStore(db, crypto, ownerId, chatgpt) : undefined;
	const builtin = (kind: string) => rows.find((r) => r.kind === kind && keys.has(r.id));
	const credentials = {
		async read(providerId: string) {
			if (plan && providerId === "openai") return plan.read();
			const row = builtin(providerId);
			return row ? ({ type: "api_key", key: keys.get(row.id) } as const) : undefined;
		},
		async list() {
			return ["anthropic", "openai", "google"].filter((k) => builtin(k) || (plan && k === "openai")).map((providerId) => ({ providerId, type: "api_key" as const }));
		},
		async modify(providerId: string, fn: (c: any) => Promise<any>) {
			if (plan && providerId === "openai") return plan.modify(fn);
			return fn(undefined);
		},
		async delete() {},
	};
	const models: MutableModels = createModels({ credentials: credentials as never });
	models.setProvider(withCleanHistory(anthropicProvider() as never) as never);
	models.setProvider(withCleanHistory((plan ? chatgptProvider(chatgpt) : openaiProvider()) as never) as never);
	models.setProvider(withCleanHistory(googleProvider() as never) as never);
	if (env.PIM_AI_GATEWAY_URL) {
		const listed = offeredModels(env);
		if (listed.length > 0) models.setProvider(withCleanHistory(compatibleProvider("gateway", "AI gateway", env.PIM_AI_GATEWAY_URL, listed.map((id) => ({ id })), () => env.PIM_AI_GATEWAY_KEY)) as never);
	}
	for (const row of rows) {
		const url = row.config.baseUrl ?? row.config.url;
		if (["openai_compatible", "custom"].includes(row.kind) && typeof url === "string" && Array.isArray(row.config.models)) {
			models.setProvider(withCleanHistory(compatibleProvider(row.id, String(row.config.name ?? row.id), url, row.config.models.filter((m: any) => typeof m?.id === "string"), () => keys.get(row.id), row.config.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions")) as never);
		}
	}
	for (const extra of (await deps.providers?.(ownerId)) ?? []) models.setProvider(withCleanHistory(extra as never) as never);
	return { models, plan: plan !== undefined };
}

const asModelRef = (v: unknown): ModelRef | null => {
	if (typeof v === "string") return v.includes("/") ? { provider: v.split("/")[0]!.replace(/^own:/, ""), id: v.split("/").slice(1).join("/") } : null;
	const m = v as { provider?: unknown; id?: unknown; modelId?: unknown } | null;
	const id = m?.id ?? m?.modelId;
	return m && typeof m.provider === "string" && typeof id === "string" ? { provider: m.provider.replace(/^own:/, ""), id } : null;
};

/** A pi-ai provider for an OpenAI-compatible endpoint: a gateway, a local server, or an owner's own. A server without a key is sent a placeholder. */
export function compatibleProvider(id: string, name: string, baseUrl: string, models: ConfiguredModel[], key: () => string | undefined, api: "openai-completions" | "anthropic-messages" = "openai-completions"): Provider {
	if (api === "anthropic-messages") return messagesProvider(id, name, baseUrl, models, key);
	return createProvider({
		id,
		name,
		baseUrl,
		auth: { apiKey: { name: `${name} key`, resolve: async () => ({ auth: { apiKey: key() ?? "none" } }) } },
		models: models.map((m) => {
			const shape = described(m, 128_000);
			return { id: m.id, name: m.name ?? m.id, api: "openai-completions", provider: id, baseUrl, ...shape, compat: { supportsDeveloperRole: false } };
		}),
		api: { "openai-completions": openAICompletionsApi() },
	} as never) as Provider;
}

/** A model of an endpoint as its provider row lists it: what a server said of it, and what the person set (`overrides`, with the prices per million tokens in `cost`). */
type ConfiguredModel = { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; images?: boolean; cost?: Partial<Price> };
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

let knownById: Map<string, any> | undefined;
/** pi-ai's catalog by model id, from the first provider that has each: what a custom endpoint's model is when it serves one the catalog knows. */
const knownModel = (id: string) => (knownById ??= new Map([anthropicProvider(), openaiProvider(), googleProvider()].flatMap((p) => (p as unknown as Provider).getModels().map((m: any) => [m.id, m] as const)).reverse())).get(id);

/**
 * The limits and prices of a custom endpoint's model, as v1 settled them: what the person set, then what the server listed, then what pi-ai's catalog knows of that id, then a default;
 * and the price the person set, else the price table's (`./model-prices.ts`), else the catalog's, else nothing, so the calls it serves are in the ledger at what they cost. An unknown model's
 * longest answer is a quarter of its context window (`fallbackMaxTokens`), not 8192, which a reasoning model could spend all thinking.
 */
function described(m: ConfiguredModel, defaultWindow: number) {
	const known = knownModel(m.id);
	const contextWindow = m.contextWindow ?? known?.contextWindow ?? defaultWindow;
	const maxTokens = m.maxTokens ?? known?.maxTokens ?? fallbackMaxTokens(contextWindow);
	const priced = { ...(priceOf(m.id) ?? known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), ...m.cost };
	return {
		input: (m.images ?? known?.input?.includes("image")) ? ["text", "image"] : ["text"],
		reasoning: m.reasoning ?? known?.reasoning ?? false,
		contextWindow,
		// An answer is never the whole context: a limit that large leaves no room for the input, so half is kept.
		maxTokens: maxTokens < contextWindow ? maxTokens : Math.floor(contextWindow / 2),
		cost: { input: priced.input, output: priced.output, cacheRead: priced.cacheRead, cacheWrite: priced.cacheWrite },
	};
}

/**
 * A person's own endpoint that speaks Anthropic's Messages API, such as a gateway in front of Claude (v1's `api: "anthropic-messages"` providers). A gateway
 * may want the key as a bearer token rather than `x-api-key`, so it gets both. A model pi-ai knows by its id takes that model's request shape (adaptive
 * thinking and the like), without the flags that turn on Anthropic's pre-release features, which a gateway cannot be known to take.
 */
function messagesProvider(id: string, name: string, baseUrl: string, models: ConfiguredModel[], key: () => string | undefined): Provider {
	const known = new Map((anthropicProvider() as unknown as Provider).getModels().map((m: any) => [m.id, m]));
	const configured = createProvider({
		id,
		name,
		baseUrl,
		auth: { apiKey: { name: `${name} key`, resolve: async () => ({ auth: { apiKey: key() ?? "none", ...(key() ? { headers: { Authorization: `Bearer ${key()}` } } : {}) } }) } },
		models: models.map((m) => {
			const catalogued = known.get(m.id) as any;
			const { supportsMidConvoEffort: _e, supportsMidConvoSystemMessages: _s, supportsMidConvoToolChanges: _t, allowedFallbackModels: _f, ...compat } = catalogued?.compat ?? {};
			return {
				id: m.id,
				name: m.name ?? m.id,
				api: "anthropic-messages",
				provider: id,
				baseUrl,
				...described(m, 200_000),
				...(catalogued ? { compat, ...(catalogued.thinkingLevelMap ? { thinkingLevelMap: catalogued.thinkingLevelMap } : {}) } : {}),
			};
		}),
		api: { "anthropic-messages": anthropicMessagesApi() },
	} as never) as any;
	// Requests are the ones v1 sent such an endpoint: no thinking asked for in the middle of a tool round that began without it (empty answers are left out of every provider's history).
	const wrap = (stream: (model: any, context: any, options?: any) => any) => (model: any, context: any, options?: any) => stream(model, withTypedTools(withoutToolErrorFlag(context, model), model), withoutThinkingMidToolRound(context, options));
	return { ...configured, stream: wrap(configured.stream), streamSimple: wrap(configured.streamSimple) } as Provider;
}

/**
 * A history as every provider can take it: an assistant message with nothing to say (a lone newline after `send_to_user`, an empty thinking block) is left out, since Vertex refuses a
 * message without parts ("must include at least one parts field") and Claude refuses the system message such an answer displaces. This runs when a request is built, so a chat that
 * already stored such a message works again and nothing stored is changed. Whitespace-only text and empty thinking go from every assistant message; a message that makes tool calls stays
 * (so every `tool_result` keeps its `tool_use`) with any signed thinking, which Claude wants back in a tool round. User messages left next to each other by a dropped answer become one.
 */
export function withoutEmptyAssistants<C extends { messages: any[] }>(context: C): C {
	const blank = (block: any) => (block.type === "text" ? block.text.trim() === "" : block.type === "thinking" && block.thinking.trim() === "");
	const kept: any[] = [];
	let dropped = false;
	for (const message of context.messages) {
		if (message.role !== "assistant") {
			const before = kept[kept.length - 1];
			if (dropped && message.role === "user" && before?.role === "user") kept[kept.length - 1] = { ...before, content: [...asBlocks(before.content), ...asBlocks(message.content)] };
			else kept.push(message);
			dropped = false;
			continue;
		}
		// A failed or stopped answer is never replayed (pi leaves it out of the context too), and one stored with no parts must not become an empty message.
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			dropped = true;
			continue;
		}
		const tools = message.content.some((block: any) => block.type === "toolCall");
		const content = message.content.filter((block: any) => !blank(block) || (tools && block.type === "thinking" && (block.redacted === true || !!block.thinkingSignature?.trim())));
		if (content.length > 0 && (tools || content.some((block: any) => block.type !== "thinking"))) kept.push(content.length === message.content.length ? message : { ...message, content });
		else dropped = true;
	}
	return kept.length === context.messages.length && kept.every((m, i) => m === context.messages[i]) ? context : { ...context, messages: kept };
}

const asBlocks = (content: string | any[]) => (typeof content === "string" ? [{ type: "text", text: content }] : content);

/** A provider whose requests are built from a history with `withoutEmptyAssistants` applied, whichever API it speaks. */
function withCleanHistory(provider: Provider): Provider {
	const wrap = (stream: (model: any, context: any, options?: any) => any) => (model: any, context: any, options?: any) => {
		const stable = withStablePrefix(context);
		// A request that ends in the context update has its cache breakpoint put on the end of the history instead (`markHistoryBeforeUpdate`), whichever Anthropic endpoint it goes to.
		const update = stable !== context && stable.messages.length > context.messages.length && model.api === "anthropic-messages";
		const marked = update ? { ...options, onPayload: async (body: any, m: unknown) => {
				const moved = markHistoryBeforeUpdate(body);
				return (await options?.onPayload?.(moved ?? body, m)) ?? moved;
			} } : options;
		return stream(model, withoutEmptyAssistants(stable), marked);
	};
	return new Proxy(provider, {
		get(target, property) {
			const value = Reflect.get(target, property, target) as unknown;
			if (property === "stream" || property === "streamSimple") return wrap((value as (...args: unknown[]) => any).bind(target));
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

/**
 * A gateway that serves other makers' models through the Messages API (Gemini on Vertex AI, behind an Anthropic-shaped endpoint) refuses a `tool_result` that carries `is_error`
 * ("is_error is not supported for GCP Vertex AI translation"), so a tool that failed would end the turn with a 422 instead of reaching the model. For a model that is not Claude the
 * flag is left off and the result's text says it failed. Claude models, and Anthropic's own provider, which does not pass through here, keep the flag.
 */
export function withoutToolErrorFlag<C extends { messages: any[] }>(context: C, model: { id: string }): C {
	if (/^claude/i.test(model.id) || !context.messages.some((m) => m.role === "toolResult" && m.isError)) return context;
	const marked = (message: any) => {
		if (message.role !== "toolResult" || !message.isError) return message;
		const { isError: _isError, ...rest } = message;
		const at = message.content.findIndex((block: any) => block.type === "text");
		const content = at < 0 ? [{ type: "text", text: "Error" }, ...message.content] : message.content.map((block: any, i: number) => (i === at ? { ...block, text: `Error: ${block.text}`.trimEnd() } : block));
		return { ...rest, content };
	};
	return { ...context, messages: context.messages.map(marked) };
}

function withoutThinkingMidToolRound(context: { messages: any[] }, options: any) {
	if (!options) return options;
	const messages = context.messages.filter((m: any) => m.role === "toolResult" || m.role === "user" || (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted"));
	let last = messages.length - 1;
	while (last >= 0 && messages[last]?.role === "toolResult") last--;
	const starter = messages[last];
	if (last === messages.length - 1 || starter?.role !== "assistant") return options;
	if (starter.content.some((b: any) => b.type === "thinking" && (b.redacted || !!b.thinkingSignature) && starter.api === "anthropic-messages")) return options;
	const { reasoning: _r, thinkingEnabled: _t, ...rest } = options;
	return rest;
}

/**
 * Counts the model calls of an owner that are not a chat's own requests into the ledger: a compaction's summary. A chat's requests are recorded when each settles, with the chat and
 * the agent it ran as (`ledgerHook`), which the stream does not know.
 */
function meter(models: Models, record: (message: any, model: any) => void): Models {
	const CALLS = new Set(["complete", "completeSimple"]);
	return new Proxy(models, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== "function") return value;
			const call = (value as (...args: unknown[]) => unknown).bind(target);
			if (typeof property === "string" && CALLS.has(property)) {
				return async (model: unknown, ...rest: unknown[]) => {
					const message = await call(model, ...rest);
					record(message, model);
					return message;
				};
			}
			return call;
		},
	});
}

export function createAgentHost(options: AgentHostOptions) {
	const { db, env } = options;
	const now = options.now ?? Date.now;
	/**
	 * Each owner's catalog, in a holder. A Runner keeps a partition resident while chats in it are active, and the catalog it was opened with holds each provider's address and
	 * key as they were then: a provider changed afterwards (or imported, then pointed elsewhere) would keep failing with "Connection error" until the partition was released.
	 * So the holder is rebuilt whenever a message sets the chat's model (`choose`), and the models the harness holds read through it.
	 */
	const catalogs = new Map<string, { current: Models; through: Models }>();
	async function refreshCatalog(ownerId: string): Promise<Models> {
		const current = await buildModels(ownerId);
		const held = catalogs.get(ownerId);
		if (held) {
			held.current = current;
			return held.through;
		}
		const holder = { current, through: undefined as unknown as Models };
		holder.through = new Proxy({} as Models, { get: (_target, property) => {
			const value = Reflect.get(holder.current, property, holder.current) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(holder.current) : value;
		} });
		catalogs.set(ownerId, holder);
		return holder.through;
	}
	/** The owners whose `openai` runs on their ChatGPT plan, a subscription whose usage limit is left until it resets (`./usage-limits.ts`). */
	const planOwners = new Set<string>();
	const failover = createFailover({
		now,
		cooldowns: options.cooldowns,
		subscription: (ownerId, provider) => provider === "openai" && planOwners.has(ownerId),
		stallMs: options.stallMs?.stream,
		fingerprint: (ownerId) => createFingerprinter(env, ownerId),
		// What an admin reading diagnostics would look for goes into the person's event log (`pim_app.diagnostic_events`).
		event: (ownerId, kind, detail) => void db.read(ownerId, "SELECT pim_app.record_diagnostic_event($1, $2, $3)", [ownerId, kind, JSON.stringify(detail)]).catch(() => {}),
		// Every Runner reads and writes the same cooldowns, so a model one of them found down is skipped by all.
		store: {
			load: async (ownerId) => new Map((await db.read<{ ref: string; ms: string }>(ownerId, "SELECT ref, (extract(epoch FROM until) * 1000)::bigint AS ms FROM pim_runtime.provider_cooldowns WHERE owner_id = $1 AND until > now()", [ownerId])).rows.map((r) => [r.ref, Number(r.ms)])),
			save: async (ownerId, provider, id, untilMs, reason) => {
				await db.read(ownerId, "INSERT INTO pim_runtime.provider_cooldowns (owner_id, ref, until, reason) VALUES ($1, $2, to_timestamp($3 / 1000.0), $4) ON CONFLICT (owner_id, ref) DO UPDATE SET until = greatest(pim_runtime.provider_cooldowns.until, excluded.until), reason = excluded.reason", [ownerId, `${provider}/${id}`, untilMs, reason.slice(0, 300)]);
			},
		},
	});
	/**
	 * A run held while the ChatGPT plan is out of usage goes on by itself when the limit resets, as in v1: a row says when (`pim_app.held_retries`), and the maintenance role asks the chat
	 * to try again then (`sweepHeldRetries`). The plan is a way out the failover tried already, so what is held with the plan cooling has nowhere else to go until it resets; a
	 * failure that is not a rate or usage limit, or a plan that is not cooling, is left for the person's Try again.
	 */
	type FailedAnswer = { provider?: string; model?: string; errorMessage?: string; timestamp?: number; stopReason?: string };
	const holdUntilReset = (ownerId: string, message: FailedAnswer, conversationId: unknown): void => {
		const app = options.app;
		if (!app || !planOwners.has(ownerId) || failureKind(message as never) !== "transient") return;
		const at = failover.providerCooldownEnd(ownerId, "openai");
		if (at === undefined) return;
		void (async () => {
			const chat = await publicChatId(ownerId, conversationId as number);
			if (!chat) return;
			await app.db.owner(ownerId, (tx) =>
				tx.query("INSERT INTO pim_app.held_retries (owner_id, id, public_chat_id, resume_at, reason) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5) ON CONFLICT DO NOTHING", [ownerId, `${conversationId}:${message.timestamp ?? at}`, chat, at, (message.errorMessage ?? "").slice(0, 300)]),
			);
		})().catch((error) => console.warn("could not arm a retry at the usage limit's reset", error instanceof Error ? error.message : error));
	};
	/** The conversations that are chats of tasks, as far as this process has seen them run: a model that fails for good ends such a run instead of holding it. */
	const taskConversations = new Set<string>();
	/** A request the provider refused as malformed or too large, which asking again does not change; a refused credential or a limit is not, and is left to the person's Try again. */
	const rejectedAsInvalid = (message: FailedAnswer): boolean => failureKind(message as never) === null && (message.errorMessage === NOT_DELIVERED || /\b(400|413|422)\b|INVALID_ARGUMENT|invalid_request_error/i.test(message.errorMessage ?? ""));
	const chatgptOptions: ChatGPTRunnerOptions = options.chatgpt ?? {};
	/** The reads of one request's sections share one query; the next request reads again, so what an agent just saved is in its next prompt. */
	const contexts = new Map<string, Promise<RunnerContext>>();

	const readContext = (ownerId: string, chat: string | null): Promise<RunnerContext> => {
		const key = `${ownerId}\u0000${chat ?? ""}`;
		let held = contexts.get(key);
		if (!held) {
			held = db.read<{ c: RunnerContext }>(ownerId, "SELECT pim_app.runner_context($1, $2) AS c", [ownerId, chat]).then((r) => r.rows[0]!.c);
			contexts.set(key, held);
			void held.then(() => undefined, () => undefined).then(() => contexts.delete(key));
		}
		return held;
	};
	/** The agents of the person and whom this chat's agent may hand a task to (migration 0690), read once for the sections of one request. */
	const rosters = new Map<string, Promise<Roster>>();
	const readRoster = (ownerId: string, chat: string | null): Promise<Roster> => {
		const key = `${ownerId}\u0000${chat ?? ""}`;
		let held = rosters.get(key);
		if (!held) {
			held = db.read<{ r: Roster }>(ownerId, "SELECT pim_app.runner_agents($1, $2, $3) AS r", [ownerId, chat, MAX_TASK_DEPTH]).then((r) => r.rows[0]!.r);
			rosters.set(key, held);
			void held.then(() => undefined, () => undefined).then(() => rosters.delete(key));
		}
		return held;
	};
	const publicChatId = async (ownerId: string, conversationId: number | string): Promise<string | null> =>
		(await db.read<{ public_chat_id: string }>(ownerId, "SELECT public_chat_id FROM pim_runtime.conversation_partitions WHERE owner_id = $1 AND conversation_id = $2", [ownerId, conversationId])).rows[0]?.public_chat_id ?? null;

	/**
	 * Tracing, when the deployment sends traces: pi's own spans, given to each partition's Harness and to the model calls no chat asked for. The chat a span's conversation is, and the
	 * agent it runs as, are read just before export, never while an agent runs.
	 */
	const telemetry = createTelemetry(env, {
		role: env.PIM_ROLE ?? "runner",
		...options.telemetry,
		conversation: async (ownerId, conversationId) => {
			const chat = await publicChatId(ownerId, conversationId);
			if (!chat) return undefined;
			const [context, started] = await Promise.all([readContext(ownerId, chat).catch(() => undefined), db.read<{ s: { session?: string; task?: string } | null }>(ownerId, "SELECT pim_app.task_started_by($1, $2) AS s", [ownerId, chat]).then((r) => r.rows[0]?.s ?? null, () => null)]);
			return { chat, agent: context?.agent?.id ?? null, startedByChat: started?.session ?? null, startedByTask: started?.task ?? null };
		},
	});

	/** The owner's providers: what the catalog offers, with their keys opened once, so a model call never waits on the application's database. */
	async function buildModels(ownerId: string): Promise<Models> {
		const { models, plan } = await ownerCatalog({ db, crypto: options.crypto, env, chatgpt: chatgptOptions, providers: options.providers }, ownerId);
		if (plan) planOwners.add(ownerId);
		else planOwners.delete(ownerId);
		return models;
	}

	/** The first of these models the catalog can run (its provider is configured); when none can, the first one, which then fails with what is missing. */
	async function choose(ownerId: string, candidates: (ModelRef | null)[]): Promise<{ provider: string; modelId: string; explicit: boolean }> {
		const named = candidates.filter((m): m is ModelRef => m !== null);
		const wanted = [...named, asModelRef(env.PIM_DEFAULT_MODEL)].filter((m): m is ModelRef => m !== null);
		const models = catalogs.has(ownerId) ? await refreshCatalog(ownerId).catch(() => catalogs.get(ownerId)!.through) : undefined;
		const available = models ? await models.getAvailable().catch(() => []) : [];
		const found = wanted.find((w) => available.some((a) => a.provider === w.provider && a.id === w.id)) ?? (wanted.length === 0 ? available[0] : undefined);
		const chain = wanted.filter((w, i) => wanted.findIndex((x) => x.provider === w.provider && x.id === w.id) === i);
		const pick = found ? { provider: found.provider, id: found.id } : (wanted[0] ?? { provider: "anthropic", id: "claude-sonnet-4-5" });
		failover.setChain(ownerId, pick, chain);
		// Explicit when the chat, its agent, the person's Settings or their fallbacks named any model, so what runs is the first of them that can, or else the default that stands in
		// for them: never the model the chat happened to be on. Not explicit only when nothing was named, and the deployment's default stands in for no one's choice.
		const explicit = named.length > 0;
		return { provider: pick.provider, modelId: pick.id, explicit };
	}

	/** Where an owner's images are drawn: their ChatGPT images sign-in, and the endpoints `PIM_IMAGE_MODEL` can name. `PIM_IMAGE_MODEL=off` has no `generate_image`. */
	const imageSources = (ownerId: string): ToolDeps["images"] =>
		env.PIM_IMAGE_MODEL?.trim() === "off"
			? undefined
			: { model: env.PIM_IMAGE_MODEL?.trim() || undefined, codex: () => (options.crypto ? new CodexImagesClient(db, options.crypto, ownerId, env, { fetch: options.fetch, now }) : undefined), endpoints: () => imageEndpoints(db, options.crypto, env, ownerId) };

	/**
	 * Enforces delivery: a request that owes the person a reply (`deliveryOwed`) gets a reminder when the agent stops without `send_to_user`, and after two the run fails with
	 * NOT_DELIVERED, which holds it for the person's Try again. In a group chat, what others said that was not for this agent leaves what it owes as it was.
	 */
	const deliveryHook = (ownerId: string) =>
		hook(GenerationTask, {
			async beforeRequest({ messages }: { messages: any[] }, api: any, context: any) {
				const chat = await publicChatId(ownerId, api.conversationId);
				// A task another agent handed this one is not held for a person's Try again when its model fails for good: it ends, and the agent that asked is told it did not finish.
				if (chat && (await readRoster(ownerId, chat).catch(() => undefined))?.startedBy) taskConversations.add(`${ownerId}\u0000${api.conversationId}`);
				const room = chat ? (await db.read<{ r: { role: "host" | "seat"; host: { id: string; name: string } | null; members: { id: string; name: string }[] } | null }>(ownerId, "SELECT pim_app.runner_room($1, $2) AS r", [ownerId, chat]).catch(() => ({ rows: [] as never[] }))).rows[0]?.r : undefined;
				const self = room ? (room.role === "host" ? (room.host?.id ?? "host") : (await readContext(ownerId, chat).catch(() => undefined))?.agent?.id) : undefined;
				const everyone = room ? [room.host ?? { id: "host", name: "Pim" }, ...room.members] : [];
				const skip = (input: string) => {
					if (!room) return false;
					if (input.startsWith("[Room]")) return true;
					const named = mentionedAgents(input, everyone);
					if (self !== undefined && named.includes(self)) return false;
					// What the person says to no one in particular is for the host.
					return ROOM_POST.test(input) || room.role === "seat" || named.length > 0;
				};
				await api.memo("delivery", deliveryOwed(messages, skip), context);
			},
			async afterResponse(answer: any, api: any, context: any) {
				const state = await api.memo("delivery", context);
				if (state?.required) enforceDelivery(answer, state);
				// An answer that stops with nothing in it (a lone newline after `send_to_user`, or the empty answers that end in a failure to deliver) is stored with no content, not as parts a provider would refuse.
				if ((answer.stopReason === "stop" || answer.errorMessage === NOT_DELIVERED) && answer.content.every((part: any) => (part.type === "text" ? part.text.trim() === "" : part.type === "thinking" && part.thinking.trim() === ""))) answer.content = [];
			},
			async onYield(answer: any, api: any, context: any) {
				const state = await api.memo("delivery", context);
				// Continuations make new generation tasks, so the reminders are counted in the transcript, not in the task.
				if (state?.required) return { continue: answer.stopReason === "length" ? LENGTH_REMINDER : DELIVERY_REMINDER };
			},
		} as never);

	/**
	 * The lines that say what an agent is doing while it works (`./progress.ts`), written by the person's utility model and told to their open apps as a notice. Chats a task started, and a
	 * person's visits, get none, and nothing is written when there is no utility model.
	 */
	const progress = new Progress({
		describe: async (key, input) => {
			const [ownerId, , chat] = key.split("\u0000") as [string, string, string];
			const app = options.app;
			if (!app || !chat) return null;
			return runUtility(app, env, { kind: "user", ownerId: ownerId as never, role: "member", sessionId: "progress" }, DESCRIBE_WORK, input);
		},
		show: (key, line, calls) => {
			const [ownerId, , chat] = key.split("\u0000") as [string, string, string];
			options.app?.notices.publish(ownerId, "progress", { session: chat, calls, text: line });
		},
	});
	const progressHook = (ownerId: string) =>
		hook(GenerationTask, {
			async beforeRequest({ messages }: { messages: any[] }, api: any) {
				try {
					const key = await progressKey(ownerId, api.conversationId);
					if (key) progress.request(key, messages);
				} catch {
					// A line that is not written costs the person a few words.
				}
			},
			async afterResponse(answer: any, api: any) {
				try {
					const key = await progressKey(ownerId, api.conversationId);
					if (key) progress.step(key, answer);
				} catch {
					// As above.
				}
			},
		} as never);
	/** What names a conversation's lines: its owner and chat, or null for a conversation that gets none (a task's, a visit's, one with no chat). */
	const progressKinds = new Map<string, { at: number; key: string | null }>();
	const progressKey = async (ownerId: string, conversationId: number | string): Promise<string | null> => {
		if (!options.app || taskConversations.has(`${ownerId}\u0000${conversationId}`)) return null;
		const known = progressKinds.get(`${ownerId}\u0000${conversationId}`);
		if (known && now() - known.at < 60_000) return known.key;
		const chat = await publicChatId(ownerId, conversationId);
		const kind = chat ? ((await options.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT kind FROM pim_app.conversations WHERE public_chat_id = $1", [chat])).rows[0]?.kind)) as string | undefined) : undefined;
		const key = chat && kind !== "visit" && kind !== "task" && kind !== "review" ? `${ownerId}\u0000${conversationId}\u0000${chat}` : null;
		if (progressKinds.size > 5000) progressKinds.clear();
		progressKinds.set(`${ownerId}\u0000${conversationId}`, { at: now(), key });
		return key;
	};

	/**
	 * One model call into the owner's ledger, with what it was for: its tokens by tier, its price, the chat and the agent it ran as, and what the failover saw of it (how long it took, how it
	 * ended, the provider's error, where its time went, and how large it was). A call that used nothing is not a row, unless it failed: a failed call is one too.
	 */
	const recordCall = async (ownerId: string, kind: "chat" | "background", chat: string | null, agent: string | null, id: string, message: any, model: any, seen?: KeptCall): Promise<void> => {
		const usage = message?.usage;
		const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
		const used = !!usage && (usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0);
		if (!used && !failed) return;
		const whole = (n: unknown) => Math.round(typeof n === "number" && Number.isFinite(n) ? n : 0);
		const write = (rowId: string, provider: string | null, name: string | null, tokens: any, detail: Record<string, unknown> | null) =>
			db
				.read(ownerId, "SELECT pim_app.record_model_call($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)", [ownerId, rowId, detail?.runKind && kind === "chat" ? detail.runKind : kind, chat, provider, name, whole(tokens?.input), whole(tokens?.output), whole((tokens?.cost?.total ?? 0) * 1_000_000), whole(tokens?.cacheRead), whole(tokens?.cacheWrite), agent, detail ? JSON.stringify(detail) : null])
				.catch(() => {});
		await write(id, message?.provider ?? model?.provider ?? null, message?.model ?? model?.id ?? null, usage, seen ? { ...seen, failures: undefined } : failed ? { stopReason: message.stopReason, error: String(message.errorMessage ?? "").slice(0, 4000) } : null);
		// The attempts that failed before this request went to the next model are calls too.
		for (const [n, attempt] of (seen?.failures ?? []).entries()) await write(`${id}_f${n}`, attempt.provider, attempt.model, undefined, { ...attempt.detail, runKind: seen!.runKind });
	};

	/** Each model request of a chat is recorded when it settles, with the chat and the agent it ran as; the id is the request's own, so a replayed hook records it once. */
	const ledgerHook = (ownerId: string) =>
		hook(GenerationTask, {
			async afterResponse(message: any, api: any) {
				const chat = await publicChatId(ownerId, api.conversationId).catch(() => null);
				const agent = chat ? ((await readContext(ownerId, chat).catch(() => undefined))?.agent?.id ?? null) : null;
				await recordCall(ownerId, "chat", chat, agent, `mc_c${api.conversationId}_t${String(api.taskId)}_${message?.timestamp ?? ""}`, message, undefined, takeCall(ownerId, message));
			},
		} as never);

	/**
	 * Refuses a model request once a daily limit of the space is used up, as v1 did (`UsageMeter.meter`): requests are counted when sent, so that limit is exact, and tokens are known
	 * only when a request ends, so requests already under way can take the day past its token limit and the next is refused. The refusal is the request's own error, with the space's
	 * usual message, so the run is held for a person's Try again after midnight UTC.
	 */
	const limits = deploymentLimits(env);
	function limited(models: Models, ownerId: string): Models {
		return new Proxy(models, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver) as unknown;
				if (typeof value !== "function") return value;
				const call = (value as (...args: unknown[]) => unknown).bind(target);
				if (property !== "stream" && property !== "streamSimple") return call;
				return (model: any, ...rest: any[]) => {
					const out = createAssistantMessageEventStream();
					void (async () => {
						// A suspended or deleted account's agents stop at their next model request, whatever turn they were in.
						const gone = await db.read<{ r: string | null }>(ownerId, "SELECT pim_app.runner_account_refusal($1) AS r", [ownerId]).then((r) => r.rows[0]?.r ?? null, () => null);
						if (gone !== null) {
							out.push({ type: "error", reason: "error", error: failureMessage(model, gone, "error", now()) } as never);
							return;
						}
						const refusal = await db.read<{ r: string | null }>(ownerId, "SELECT pim_app.runner_reserve_model_request($1, $2, $3, $4) AS r", [ownerId, String(model.provider), limits.dailyTokens, limits.dailyModelRequests]).then((r) => r.rows[0]?.r ?? null, () => null);
						if (refusal !== null) {
							console.warn(JSON.stringify({ event: "pim.limit", limit: "model", provider: model.provider, reason: refusal }));
							out.push({ type: "error", reason: "error", error: failureMessage(model, `${QUOTA_MESSAGE} ${refusal}`, "error", now()) } as never);
							return;
						}
						const events = call(model, ...rest) as AsyncIterable<unknown> & { result(): Promise<unknown> };
						for await (const event of events) out.push(event as never);
						out.end((await events.result()) as never);
					})().catch((error) => out.push({ type: "error", reason: "error", error: failureMessage(model, error instanceof Error ? error.message : String(error), "error", now()) } as never));
					return out;
				};
			},
		});
	}

	const harnessOptions = async (partition: PartitionContext): Promise<HarnessOptions> => {
		const ownerId = partition.ownerId;
		const models = await refreshCatalog(ownerId);
		const metered = meter(limited(failover.wrap(models, ownerId), ownerId), (message, model) => void recordCall(ownerId, "background", null, null, `mc_${randomUUID()}`, message, model));
		const registry = createRegistry();
		const deps: ToolDeps = { ownerId, partitionId: partition.partitionId, runtime: db, app: options.app, forge: options.forge, relay: options.relay, fetch: options.fetch ?? fetch, now, toolTimeoutMs: options.stallMs?.tool, crypto: options.crypto, allowPrivateConnectors: env.PIM_CONNECTOR_ALLOW_PRIVATE === "1", images: imageSources(ownerId), imagesOf: imageSources, chatOf: (conversationId) => publicChatId(ownerId, conversationId) };
		const ctx = (conversationId: number | string) => publicChatId(ownerId, conversationId).then((chat) => readContext(ownerId, chat));
		/** The brief of a visit to someone's space, null in every other chat. */
		const visitOf = async (conversationId: number | string): Promise<VisitBrief | null> => {
			const chat = await publicChatId(ownerId, conversationId).catch(() => null);
			return chat ? ((await db.read<{ b: VisitBrief | null }>(ownerId, "SELECT pim_app.runner_visit_brief($1, $2, $3) AS b", [ownerId, chat, memoryLinesOf(env)]).catch(() => ({ rows: [] as { b: VisitBrief | null }[] }))).rows[0]?.b ?? null) : null;
		};
		registry.install(pimExtension(deps, [
			section("user_time_zone", async (input) => ((await visitOf(input.conversationId)) ? undefined : timeZoneOf(db, ownerId))),
			section("host_time_zone", async (input) => (await visitOf(input.conversationId))?.timeZone ?? undefined),
			section("agent", async (input) => {
				const c = await ctx(input.conversationId);
				const visit = await visitOf(input.conversationId);
				if (visit) return [AGENT_PREAMBLE, visitPreamble(visit, c.username ?? "the visitor")].join("\n\n");
				const chat = await publicChatId(ownerId, input.conversationId);
				const roster = await readRoster(ownerId, chat).catch(() => undefined);
				const me = roster?.agents.find((a) => a.id === c.agent?.id);
				const who = c.agent ? `You are ${c.agent.name}, an agent of ${c.username ?? "this person"} in Pim.` : `You are Pim, ${c.username ? `${c.username}'s` : "a person's"} assistant.`;
				const own = c.agent?.instructions ? `Your instructions, which come before your general habits wherever the two differ:\n${c.agent.instructions}` : undefined;
				return [AGENT_PREAMBLE, who, me ? identity(me) : undefined, c.agent?.majordomo ? majordomoRole(c.agent.name) : undefined, c.agent?.config?.system === "pimbot" ? pimbotRole(c.agent.name) : undefined, ASSISTANT_INSTRUCTIONS, own].filter(Boolean).join("\n\n");
			}),
			section("your_agents", async (input) => {
				if (await visitOf(input.conversationId)) return undefined;
				const roster = await readRoster(ownerId, await publicChatId(ownerId, input.conversationId)).catch(() => undefined);
				return roster && roster.agents.length > 0 ? agentsSection(roster.self, roster) : undefined;
			}),
			section("started_by", async (input) => {
				if (await visitOf(input.conversationId)) return undefined;
				const roster = await readRoster(ownerId, await publicChatId(ownerId, input.conversationId)).catch(() => undefined);
				return roster?.startedBy ? startedBySection(roster.startedBy) : undefined;
			}),
			section("your_skills", async (input) => {
				const c = await ctx(input.conversationId);
				// The person's own skills first; a built-in one is listed unless they have written one of the same name.
				const skills = [...c.skills, ...BUILTIN_SKILLS.filter((b) => !c.skills.some((s) => s.name === b.name)).map(({ name, description }) => ({ name, description }))];
				return `Skills you can load with read_skill:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
			}),
			section("memory", async (input) => {
				const visit = await visitOf(input.conversationId);
				if (visit) return visitMemory(visit);
				const c = await ctx(input.conversationId);
				const own = c.agent ? (c.agent.config.memoryScope ?? `agent-${c.agent.id}`) : "everyone";
				// The majordomo reads every scope there is.
				const scopes = c.agent?.majordomo ? null : c.agent ? [...new Set([own, ...(c.agent.config.memoryScopes ?? []), "everyone"])] : ["everyone"];
				const view = await memoryView(db, ownerId, scopes, memoryLinesOf(env), own);
				const about = `Your long-term memory, oldest first, in scopes that different agents read; \`note\` keeps a memory in your own, ${own}, unless you name another scope you read. Recent memories show as [id] title; a line "#<scope>/a-b" summarizes memories a through b of that scope, and zoom opens it into its halves. Later memories override earlier ones. Find any memory with recall, and read one in full with zoom.`;
				return `${about}\n${view.length ? view.join("\n") : "Nothing is remembered yet."}`;
			}),
			section("room", async (input) => {
				const chat = await publicChatId(ownerId, input.conversationId);
				const room = chat ? (await db.read<{ r: { role: "host" | "seat"; mode: string; host: { id: string; name: string } | null; members: { id: string; name: string }[] } | null }>(ownerId, "SELECT pim_app.runner_room($1, $2) AS r", [ownerId, chat]).catch(() => ({ rows: [] as never[] }))).rows[0]?.r : undefined;
				if (!room) return undefined;
				const names = (room.role === "host" ? room.members : [room.host ?? { id: "", name: "Pim" }, ...room.members]).map((m) => m.name);
				const turns = room.mode === "open" ? "Everything the person says wakes every agent in the room; each decides whether it has something to add." : "The host answers what the person says to no one in particular; an agent answers when it is mentioned as @Name.";
				return `This is a group chat${room.role === "seat" ? " and you are one of its agents, not its host" : " and you are its host"}. ${room.role === "host" ? "Also in it" : "Others in it"}: ${names.join(", ") || "no one else yet"}. ${turns} What another agent says reaches you as a message that starts "[From Name]"; what you send with send_to_user is shown in the chat as yours, under your name. Mention an agent by @Name to bring its attention; do not repeat what others have said. ${room.role === "host" ? "When an agent you or the person brought in has done what it was here for, take it out of the chat with `remove_from_chat`: it hears nothing more, and can be brought in again later." : "You joined knowing nothing of what was said here before; when what you are asked refers to it, read it with `read_chat` and no id."}`;
			}),
			section("delegates", async (input) => {
				if (await visitOf(input.conversationId)) return undefined;
				const roster = await readRoster(ownerId, await publicChatId(ownerId, input.conversationId)).catch(() => undefined);
				return roster && roster.delegates.length > 0 ? delegatesSection(roster) : undefined;
			}),
			// A thread runs in a sandbox of an enabled pool, or in an Amp orb, which needs none and needs the person's Amp login; with neither, the coding tools only answer that they cannot.
			section("coding_unavailable", async () => {
				const forge = options.forge;
				const pooled = forge?.compute ? (await forge.db.query("select 1 from pim_forge.forge_pools where enabled limit 1").catch(() => ({ rows: [] }))).rows.length > 0 : false;
				if (pooled) return undefined;
				const amp = (await forge?.vault?.status(ownerId).catch(() => []))?.some((entry) => entry.harness === "amp" && entry.connected);
				return amp ? undefined : NO_CODING_SANDBOX_LINE;
			}),
		]));
		// Only what send_to_user sends reaches the person, so a turn that ends in plain text is sent back for delivery, and after two reminders it fails (v1's messaging extension).
		registry.install(defineExtension({ name: "delivery", hooks: [deliveryHook(ownerId), ledgerHook(ownerId), progressHook(ownerId)] }));
		// The admin's majordomo may ask the host daemon for operations, each after a person approves it (`./hostops/`).
		const hostops = await hostopsExtension({ ownerId, partitionId: partition.partitionId, app: options.app, chatOf: deps.chatOf });
		if (hostops) registry.install(hostops);
		// A request that failed for good, with nothing left to retry or fail over to, holds the run where it stopped: the person's Try again on the error card asks the model again (`POST /api/sessions/:id/retry`), so they need not say it twice.
		// A request the provider rejected as invalid (a 400), or an agent that would not deliver its reply after two reminders, fails the same way when asked again, so such a run ends instead: the chat is not at work, and Try again sends the message again.
		// pi 1.5 stores a streamed answer and running tool output up to a second late; the live projector reads them from PostgreSQL, so each is stored as it is committed, as in pi 1.1.
		return { ...(telemetry ? { telemetry: telemetry.partition(ownerId, partition.partitionId) } : {}), models: metered, registry, settings: { retry: { suspend: (message: unknown, conversationId: unknown) => {
			if (taskConversations.has(`${ownerId}\u0000${conversationId}`) || rejectedAsInvalid(message as FailedAnswer)) return false;
			holdUntilReset(ownerId, message as FailedAnswer, conversationId);
			return true;
		} }, progress: { persistWithinMs: 0 } } } as HarnessOptions;
	};

	/**
	 * What the agent is told before a person's message: which of the files it saw changed since (`./file-changes.ts`). It needs the person's computer, so with none connected, or no
	 * application database, the message goes as it is.
	 */
	const beforeUserMessage: NonNullable<RunnerOptions["beforeUserMessage"]> = async (ownerId, chat) => {
		const app = options.app;
		if (!app || !options.relay) return undefined;
		const found = await fileChangesBlock(app, ownerId, chat, async () => acquireRemote(await options.relay!().catch(() => null), ownerId, "file_changes"));
		return found ? { before: [{ type: "text", text: found.block }], taken: found.taken } : undefined;
	};

	/** The model the owner chose in Settings for agents with none of their own (migration 0611). */
	const chosenModel = async (ownerId: string) => asModelRef((await db.read<{ m: unknown }>(ownerId, "SELECT pim_app.runner_model($1) AS m", [ownerId]).catch(() => ({ rows: [] as { m: unknown }[] }))).rows[0]?.m);

	const homeRoot: NonNullable<RunnerOptions["homeRoot"]> = async (ownerId) => {
		const c = await readContext(ownerId, null).catch(() => undefined);
		const { explicit: _explicit, ...model } = await choose(ownerId, [await chosenModel(ownerId), ...(c?.fallbacks ?? []).map(asModelRef)]);
		return { agent: { model, thinkingLevel: "low" } };
	};
	const chatAgent: NonNullable<RunnerOptions["chatAgent"]> = async (ownerId, chat) => {
		const c = await readContext(ownerId, chat ?? null).catch(() => undefined);
		const own = c?.agent ? [asModelRef(c.chat_model), asModelRef(c.agent.config.model), ...((c.agent.config.fallbacks ?? []) as unknown[]).map(asModelRef)] : [];
		const { explicit, ...model } = await choose(ownerId, [...(c?.agent ? [] : [asModelRef(c?.chat_model)]), ...own, await chosenModel(ownerId), ...(c?.fallbacks ?? []).map(asModelRef)]);
		// Every chat thinks at a low effort, as in v1: a reasoning model reasons a little before it answers, and the harness's own default is not to.
		const hideTools = options.app && chat ? (await chatToolLimits(options.app, ownerId, chat).catch(() => undefined))?.hidden : undefined;
		return { model, thinkingLevel: "low", explicit, ...(hideTools && hideTools.length > 0 ? { hideTools } : {}) };
	};

	/** One model call as an owner's own models, for what is not a chat turn (an approval review): the same catalog, failover and ledger, no tools. */
	async function ask(ownerId: string, chat: string | null, system: string, question: string, signal: AbortSignal): Promise<string> {
		const models = await refreshCatalog(ownerId);
		const c = await readContext(ownerId, chat).catch(() => undefined);
		const pick = await choose(ownerId, [await chosenModel(ownerId), ...(c?.fallbacks ?? []).map(asModelRef)]);
		const model = models.getModel(pick.provider, pick.modelId);
		if (!model) throw new Error(`The model ${pick.provider}/${pick.modelId} is not available`);
		const call = (span?: TelemetrySpan) => failover.wrap(models, ownerId).completeSimple(model, { systemPrompt: system, messages: [{ role: "user", content: question, timestamp: now() }] } as never, { signal, ...(span ? { telemetry: span } : {}) } as never);
		const message: any = await (telemetry ? telemetry.background(ownerId, "approval_review", call) : call());
		if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? "The model did not answer");
		return (message.content as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
	}

	/**
	 * One answer from a model for work no chat asked for, such as the memory nap: the deployment's `PIM_MEMORY_MODEL` (`provider/model`), else the utility model the person chose
	 * in Settings, else the model they chose for agents, else the deployment's default. It is metered into the owner's ledger as background work. Undefined when no model can answer.
	 */
	async function complete(ownerId: string, system: string, prompt: string, maxTokens = 1024): Promise<string | undefined> {
		const models = await refreshCatalog(ownerId);
		const available = await models.getAvailable().catch(() => []);
		const utility = asModelRef((await db.read<{ m: unknown }>(ownerId, "SELECT pim_app.runner_utility_model($1) AS m", [ownerId]).catch(() => ({ rows: [] as { m: unknown }[] }))).rows[0]?.m);
		const wanted = [asModelRef(env.PIM_MEMORY_MODEL), utility, await chosenModel(ownerId), asModelRef(env.PIM_DEFAULT_MODEL)].filter((m): m is ModelRef => m !== null);
		const model = wanted.map((w) => available.find((a) => a.provider === w.provider && a.id === w.id)).find((m) => m !== undefined);
		if (!model) return undefined;
		const call = (span?: TelemetrySpan) => models.completeSimple(model as never, { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: now() }] } as never, { maxTokens, ...(span ? { telemetry: span } : {}) } as never);
		const answer = await (telemetry ? telemetry.background(ownerId, "background", call) : call());
		const usage = (answer as any)?.usage;
		await recordCall(ownerId, "background", null, null, `mc_${randomUUID()}`, answer, model);
		if ((answer as any)?.stopReason === "error") throw new Error(String((answer as any).errorMessage ?? "The model failed"));
		return ((answer as any).content as { type: string; text?: string }[]).flatMap((c) => (c.type === "text" ? [c.text ?? ""] : [])).join("").trim();
	}

	return { harnessOptions, homeRoot, chatAgent, beforeUserMessage, ask, complete, shutdownTelemetry: async () => telemetry?.shutdown(), flushTelemetry: async () => telemetry?.flush(), context: (ownerId: string, chat: string | null) => readContext(ownerId, chat) };
}
