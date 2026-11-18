/**
 * What a deployed Runner runs its agents with, so that a `runner` role executes real Pim agents without anything injected:
 *
 * - the model catalog of each owner: the standard pi-ai providers (Anthropic, OpenAI, Google) with the deployment's keys from the process environment, an OpenAI-compatible
 *   gateway (`PIM_AI_GATEWAY_URL`, `PIM_AI_GATEWAY_KEY`, `PIM_AI_GATEWAY_MODELS`), and the owner's own providers (`pim_app.providers`, their keys opened with the deployment's
 *   key ring); every model call is metered into `pim_app.model_calls`;
 * - the agent a chat answers as (`runner_context`, a narrow read in migration 0604), and the prompt context built from it afresh for every request: the agent, its skills,
 *   the owner's active goals, the memories of its scopes, and the agents it may delegate to;
 * - the tool registry (`./agent-tools.ts`), built for the partition's owner.
 *
 * The Runner connects as `pim_runtime`, which has no grant on `pim_app`: what the host reads from the application goes through the definer functions of 0604. What the tools write
 * needs the application's services, so it needs `PIM_APP_DATABASE_URL`, a login that is a member of the gate role; without it a tool that needs them says so, and
 * `send_to_user`, `current_time` and `fetch_url` still work. The model catalog is built when a partition is opened and lives as long as it is resident: a provider or key
 * an owner changes is seen by the partitions opened after the change (an idle partition is released after a short while, by default 30 seconds).
 */
import { randomUUID } from "node:crypto";
import { createModels, type Models, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, section, type HarnessOptions } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import type { RelayBus } from "@pim/v2-app/relay";
import { openString, type KeyringCrypto } from "@pim/v2-app/crypto";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import type { PartitionContext, RunnerOptions } from "@pim/v2-runtime/runner";
import { pimExtension, timeZoneOf, type ToolDeps } from "./agent-tools.ts";
import { BUILTIN_SKILLS } from "./builtin-skills.ts";
import { CodexImagesClient } from "./codex-images.ts";
import { imageEndpoints } from "./image-tools.ts";
import { hostopsExtension } from "./hostops/tools.ts";
import { chatgptCredentialStore, chatgptProvider, type ChatGPTRunnerOptions } from "./chatgpt-auth.ts";
import type { ForgeParts } from "./forge-assembly.ts";
import { createFailover } from "./provider-failover.ts";

type Env = Record<string, string | undefined>;
type ModelRef = { provider: string; id: string };
type ProviderRow = { id: string; kind: string; config: Record<string, any>; secret: string | null; /** The deployment's own (shared with everyone), named `shared:<id>`, its key sealed for the deployment rather than for the owner. */ shared?: boolean };
export type RunnerContext = {
	username: string | null;
	agent: { id: string; name: string; instructions: string; config: Record<string, any> } | null;
	skills: { name: string; description: string }[];
	goals: { id: string; title: string; steps: { title: string; done: boolean }[] }[];
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

const asModelRef = (v: unknown): ModelRef | null => {
	if (typeof v === "string") return v.includes("/") ? { provider: v.split("/")[0]!.replace(/^own:/, ""), id: v.split("/").slice(1).join("/") } : null;
	const m = v as { provider?: unknown; id?: unknown; modelId?: unknown } | null;
	const id = m?.id ?? m?.modelId;
	return m && typeof m.provider === "string" && typeof id === "string" ? { provider: m.provider.replace(/^own:/, ""), id } : null;
};

/** A pi-ai provider for an OpenAI-compatible endpoint: a gateway, a local server, or an owner's own. A server without a key is sent a placeholder. */
export function compatibleProvider(id: string, name: string, baseUrl: string, models: { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; images?: boolean }[], key: () => string | undefined, api: "openai-completions" | "anthropic-messages" = "openai-completions"): Provider {
	if (api === "anthropic-messages") return messagesProvider(id, name, baseUrl, models, key);
	return createProvider({
		id,
		name,
		baseUrl,
		auth: { apiKey: { name: `${name} key`, resolve: async () => ({ auth: { apiKey: key() ?? "none" } }) } },
		models: models.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			api: "openai-completions",
			provider: id,
			baseUrl,
			input: m.images ? ["text", "image"] : ["text"],
			reasoning: m.reasoning ?? false,
			contextWindow: m.contextWindow ?? 128_000,
			maxTokens: m.maxTokens ?? 8_192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsDeveloperRole: false },
		})),
		api: { "openai-completions": openAICompletionsApi() },
	} as never) as Provider;
}

/**
 * A person's own endpoint that speaks Anthropic's Messages API, such as a gateway in front of Claude (v1's `api: "anthropic-messages"` providers). A gateway
 * may want the key as a bearer token rather than `x-api-key`, so it gets both. A model pi-ai knows by its id takes that model's request shape (adaptive
 * thinking and the like), without the flags that turn on Anthropic's pre-release features, which a gateway cannot be known to take.
 */
function messagesProvider(id: string, name: string, baseUrl: string, models: { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; images?: boolean }[], key: () => string | undefined): Provider {
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
				input: m.images ? ["text", "image"] : ["text"],
				reasoning: m.reasoning ?? false,
				contextWindow: m.contextWindow ?? 200_000,
				maxTokens: m.maxTokens ?? 8_192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				...(catalogued ? { compat, ...(catalogued.thinkingLevelMap ? { thinkingLevelMap: catalogued.thinkingLevelMap } : {}) } : {}),
			};
		}),
		api: { "anthropic-messages": anthropicMessagesApi() },
	} as never) as any;
	// Requests are the ones v1 sent such an endpoint: no empty answers in the history (Claude refuses the system message they displace), and no thinking
	// asked for in the middle of a tool round that began without it.
	const wrap = (stream: (model: any, context: any, options?: any) => any) => (model: any, context: any, options?: any) => stream(model, withoutToolErrorFlag(withoutEmptyAnswers(context, model), model), withoutThinkingMidToolRound(context, options));
	return { ...configured, stream: wrap(configured.stream), streamSimple: wrap(configured.streamSimple) } as Provider;
}

function withoutEmptyAnswers(context: { messages: any[] }, model: any) {
	const says = (message: any) => {
		if (message.role !== "assistant") return true;
		const same = message.provider === model.provider && message.api === model.api && message.model === model.id;
		return message.content.some((block: any) => block.type === "toolCall" || (block.type === "text" ? block.text.trim() !== "" : block.type === "thinking" ? (same && (block.redacted === true || !!block.thinkingSignature?.trim())) || block.thinking.trim() !== "" : true));
	};
	return context.messages.every(says) ? context : { ...context, messages: context.messages.filter(says) };
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

/** Counts every model call of an owner into the ledger. */
function meter(models: Models, record: (message: any, model: any) => void): Models {
	const STREAMS = new Set(["stream", "streamSimple"]);
	const CALLS = new Set(["complete", "completeSimple"]);
	return new Proxy(models, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== "function") return value;
			const call = (value as (...args: unknown[]) => unknown).bind(target);
			if (typeof property === "string" && STREAMS.has(property)) {
				return (model: unknown, ...rest: unknown[]) => {
					const stream = call(model, ...rest) as { result(): Promise<unknown> };
					void stream.result().then((message) => record(message, model), () => {});
					return stream;
				};
			}
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
	const failover = createFailover({
		now,
		cooldowns: options.cooldowns,
		stallMs: options.stallMs?.stream,
		// Every Runner reads and writes the same cooldowns, so a model one of them found down is skipped by all.
		store: {
			load: async (ownerId) => new Map((await db.read<{ ref: string; ms: string }>(ownerId, "SELECT ref, (extract(epoch FROM until) * 1000)::bigint AS ms FROM pim_runtime.provider_cooldowns WHERE owner_id = $1 AND until > now()", [ownerId])).rows.map((r) => [r.ref, Number(r.ms)])),
			save: async (ownerId, provider, id, untilMs, reason) => {
				await db.read(ownerId, "INSERT INTO pim_runtime.provider_cooldowns (owner_id, ref, until, reason) VALUES ($1, $2, to_timestamp($3 / 1000.0), $4) ON CONFLICT (owner_id, ref) DO UPDATE SET until = greatest(pim_runtime.provider_cooldowns.until, excluded.until), reason = excluded.reason", [ownerId, `${provider}/${id}`, untilMs, reason.slice(0, 300)]);
			},
		},
	});
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
	const publicChatId = async (ownerId: string, conversationId: number | string): Promise<string | null> =>
		(await db.read<{ public_chat_id: string }>(ownerId, "SELECT public_chat_id FROM pim_runtime.conversation_partitions WHERE owner_id = $1 AND conversation_id = $2", [ownerId, conversationId])).rows[0]?.public_chat_id ?? null;

	/** The owner's providers: what the catalog offers, with their keys opened once, so a model call never waits on the application's database. */
	async function buildModels(ownerId: string): Promise<Models> {
		const own = (await db.read<{ p: ProviderRow[] }>(ownerId, "SELECT pim_app.runner_providers($1) AS p", [ownerId]).catch(() => ({ rows: [{ p: [] as ProviderRow[] }] }))).rows[0]!.p;
		// What an admin shared with everyone is in every catalog as `shared:<id>`, its key opened under the admin's owner id as it was sealed. An admin's own list leaves it out.
		const sharedRows = (await db.read<{ p: (ProviderRow & { owner: string })[] }>(ownerId, "SELECT pim_app.shared_providers(true) AS p").catch(() => ({ rows: [] as { p: (ProviderRow & { owner: string })[] }[] }))).rows[0]?.p ?? [];
		const context = new Map<string, string>(sharedRows.map((r) => [`shared:${r.id}`, `provider:${r.owner}/${r.id}`]));
		const rows: ProviderRow[] = [...own.filter((r) => r.config.shared !== true), ...sharedRows.map((r) => ({ id: `shared:${r.id}`, kind: r.kind, config: r.config, secret: r.secret }))];
		const keys = new Map<string, string>();
		for (const row of rows) {
			if (!row.secret || !options.crypto) continue;
			try {
				// An admin's shared provider is sealed under the admin; one promoted from v1's deployment under `_instance`; the owner's own under them.
				keys.set(row.id, await openString(options.crypto, row.secret, context.get(row.id) ?? (row.shared ? `provider:_instance/${row.id.slice(SHARED.length)}` : `provider:${ownerId}/${row.id}`)));
			} catch {
				// A key sealed under a key this process does not hold stays unavailable, and the provider with it.
			}
		}
		// An owner signed in with ChatGPT runs `openai` on the plan: its sealed credential is read and refreshed live, not opened once.
		const plan = options.crypto && (await db.read<{ s: string | null }>(ownerId, "SELECT pim_app.runner_chatgpt($1) AS s", [ownerId]).then((r) => r.rows[0]?.s, () => null)) ? chatgptCredentialStore(db, options.crypto, ownerId, chatgptOptions) : undefined;
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
		models.setProvider(anthropicProvider() as never);
		models.setProvider((plan ? chatgptProvider(chatgptOptions) : openaiProvider()) as never);
		models.setProvider(googleProvider() as never);
		if (env.PIM_AI_GATEWAY_URL) {
			const listed = (env.PIM_AI_GATEWAY_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
			if (listed.length > 0) models.setProvider(compatibleProvider("gateway", "AI gateway", env.PIM_AI_GATEWAY_URL, listed.map((id) => ({ id })), () => env.PIM_AI_GATEWAY_KEY) as never);
		}
		for (const row of rows) {
			const url = row.config.baseUrl ?? row.config.url;
			if (["openai_compatible", "custom"].includes(row.kind) && typeof url === "string" && Array.isArray(row.config.models)) {
				models.setProvider(compatibleProvider(row.id, String(row.config.name ?? row.id), url, row.config.models.filter((m: any) => typeof m?.id === "string"), () => keys.get(row.id), row.config.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions") as never);
			}
		}
		for (const extra of (await options.providers?.(ownerId)) ?? []) models.setProvider(extra as never);
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
		env.PIM_IMAGE_MODEL === "off"
			? undefined
			: { model: env.PIM_IMAGE_MODEL, codex: () => (options.crypto ? new CodexImagesClient(db, options.crypto, ownerId, env, { fetch: options.fetch, now }) : undefined), endpoints: () => imageEndpoints(db, options.crypto, env, ownerId) };

	const harnessOptions = async (partition: PartitionContext): Promise<HarnessOptions> => {
		const ownerId = partition.ownerId;
		const models = await refreshCatalog(ownerId);
		const metered = meter(failover.wrap(models, ownerId), (message, model) => {
			const usage = message?.usage;
			if (!usage || !(usage.input > 0 || usage.output > 0)) return;
			void db
				.read(ownerId, "SELECT pim_app.record_model_call($1, $2, 'chat', NULL, $3, $4, $5, $6, $7)", [ownerId, `mc_${randomUUID()}`, message?.provider ?? model?.provider ?? null, message?.model ?? model?.id ?? null, Math.round(usage.input ?? 0), Math.round(usage.output ?? 0), Math.round((usage.cost?.total ?? 0) * 1_000_000)])
				.catch(() => {});
		});
		const registry = createRegistry();
		const deps: ToolDeps = { ownerId, partitionId: partition.partitionId, runtime: db, app: options.app, forge: options.forge, relay: options.relay, fetch: options.fetch ?? fetch, now, toolTimeoutMs: options.stallMs?.tool, crypto: options.crypto, allowPrivateConnectors: env.PIM_CONNECTOR_ALLOW_PRIVATE === "1", images: imageSources(ownerId), chatOf: (conversationId) => publicChatId(ownerId, conversationId) };
		const ctx = (conversationId: number | string) => publicChatId(ownerId, conversationId).then((chat) => readContext(ownerId, chat));
		registry.install(pimExtension(deps, [
			section("user_time_zone", () => timeZoneOf(db, ownerId)),
			section("agent", async (input) => {
				const c = await ctx(input.conversationId);
				const who = c.agent ? `You are ${c.agent.name}, an agent of ${c.username ?? "this person"} in Pim.` : `You are Pim, ${c.username ? `${c.username}'s` : "a person's"} assistant.`;
				return [AGENT_PREAMBLE, who, c.agent?.instructions].filter(Boolean).join("\n\n");
			}),
			section("your_skills", async (input) => {
				const c = await ctx(input.conversationId);
				// The person's own skills first; a built-in one is listed unless they have written one of the same name.
				const skills = [...c.skills, ...BUILTIN_SKILLS.filter((b) => !c.skills.some((s) => s.name === b.name)).map(({ name, description }) => ({ name, description }))];
				return `Skills you can load with read_skill:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
			}),
			section("active_goals", async (input) => {
				const c = await ctx(input.conversationId);
				return c.goals.length === 0 ? undefined : c.goals.map((g) => `- [${g.id}] ${g.title}${g.steps.length ? `\n${g.steps.map((s) => `  - [${s.done ? "x" : " "}] ${s.title}`).join("\n")}` : ""}`).join("\n");
			}),
			section("memory", async (input) => {
				const c = await ctx(input.conversationId);
				const scopes = c.agent ? `agent-${c.agent.id} and everyone` : "everyone";
				return `Your memory (scopes ${scopes}). Save with note, find with recall, read in full with zoom.${c.memories.length ? `\n${c.memories.map((m) => `- [${m.id}] (${m.scope}) ${m.title}`).join("\n")}` : "\nNothing is remembered yet."}`;
			}),
			section("room", async (input) => {
				const chat = await publicChatId(ownerId, input.conversationId);
				const room = chat ? (await db.read<{ r: { role: "host" | "seat"; mode: string; host: { id: string; name: string } | null; members: { id: string; name: string }[] } | null }>(ownerId, "SELECT pim_app.runner_room($1, $2) AS r", [ownerId, chat]).catch(() => ({ rows: [] as never[] }))).rows[0]?.r : undefined;
				if (!room) return undefined;
				const names = (room.role === "host" ? room.members : [room.host ?? { id: "", name: "Pim" }, ...room.members]).map((m) => m.name);
				const turns = room.mode === "open" ? "Everything the person says wakes every agent in the room; each decides whether it has something to add." : "The host answers what the person says to no one in particular; an agent answers when it is mentioned as @Name.";
				return `This is a group chat${room.role === "seat" ? " and you are one of its agents, not its host" : " and you are its host"}. ${room.role === "host" ? "Also in it" : "Others in it"}: ${names.join(", ") || "no one else yet"}. ${turns} What another agent says reaches you as a message that starts "[From Name]"; what you send with send_to_user is shown in the chat as yours, under your name. Mention an agent by @Name to bring its attention; do not repeat what others have said.`;
			}),
			section("delegates", async (input) => {
				const c = await ctx(input.conversationId);
				return c.contacts.length === 0 ? undefined : `Agents you can hand work to with delegate:\n${c.contacts.map((a) => `- ${a.id}: ${a.name}${a.about ? ` — ${a.about}` : ""}`).join("\n")}`;
			}),
		]));
		// The admin's majordomo may ask the host daemon for operations, each after a person approves it (`./hostops/`).
		const hostops = await hostopsExtension({ ownerId, partitionId: partition.partitionId, app: options.app, chatOf: deps.chatOf });
		if (hostops) registry.install(hostops);
		return { models: metered, registry } as HarnessOptions;
	};

	/** The model the owner chose in Settings for agents with none of their own (migration 0611). */
	const chosenModel = async (ownerId: string) => asModelRef((await db.read<{ m: unknown }>(ownerId, "SELECT pim_app.runner_model($1) AS m", [ownerId]).catch(() => ({ rows: [] as { m: unknown }[] }))).rows[0]?.m);

	const homeRoot: NonNullable<RunnerOptions["homeRoot"]> = async (ownerId) => {
		const c = await readContext(ownerId, null).catch(() => undefined);
		const { explicit: _explicit, ...model } = await choose(ownerId, [await chosenModel(ownerId), ...(c?.fallbacks ?? []).map(asModelRef)]);
		return { agent: { model } };
	};
	const chatAgent: NonNullable<RunnerOptions["chatAgent"]> = async (ownerId, chat) => {
		const c = await readContext(ownerId, chat ?? null).catch(() => undefined);
		const own = c?.agent ? [asModelRef(c.chat_model), asModelRef(c.agent.config.model), ...((c.agent.config.fallbacks ?? []) as unknown[]).map(asModelRef)] : [];
		const { explicit, ...model } = await choose(ownerId, [...(c?.agent ? [] : [asModelRef(c?.chat_model)]), ...own, await chosenModel(ownerId), ...(c?.fallbacks ?? []).map(asModelRef)]);
		return { model, explicit };
	};

	/** One model call as an owner's own models, for what is not a chat turn (an approval review): the same catalog, failover and ledger, no tools. */
	async function ask(ownerId: string, chat: string | null, system: string, question: string, signal: AbortSignal): Promise<string> {
		const models = await refreshCatalog(ownerId);
		const c = await readContext(ownerId, chat).catch(() => undefined);
		const pick = await choose(ownerId, [await chosenModel(ownerId), ...(c?.fallbacks ?? []).map(asModelRef)]);
		const model = models.getModel(pick.provider, pick.modelId);
		if (!model) throw new Error(`The model ${pick.provider}/${pick.modelId} is not available`);
		const message: any = await failover.wrap(models, ownerId).completeSimple(model, { systemPrompt: system, messages: [{ role: "user", content: question, timestamp: now() }] } as never, { signal } as never);
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
		const answer = await models.completeSimple(model as never, { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: now() }] } as never, { maxTokens } as never);
		const usage = (answer as any)?.usage;
		if (usage && (usage.input > 0 || usage.output > 0)) {
			await db.read(ownerId, "SELECT pim_app.record_model_call($1, $2, 'background', NULL, $3, $4, $5, $6, $7)", [ownerId, `mc_${randomUUID()}`, model.provider, model.id, Math.round(usage.input ?? 0), Math.round(usage.output ?? 0), Math.round((usage.cost?.total ?? 0) * 1_000_000)]).catch(() => {});
		}
		if ((answer as any)?.stopReason === "error") throw new Error(String((answer as any).errorMessage ?? "The model failed"));
		return ((answer as any).content as { type: string; text?: string }[]).flatMap((c) => (c.type === "text" ? [c.text ?? ""] : [])).join("").trim();
	}

	return { harnessOptions, homeRoot, chatAgent, ask, complete, context: (ownerId: string, chat: string | null) => readContext(ownerId, chat) };
}
