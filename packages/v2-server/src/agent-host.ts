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
import { pimExtension, type ToolDeps } from "./agent-tools.ts";
import { CodexImagesClient } from "./codex-images.ts";
import { imageEndpoints } from "./image-tools.ts";
import { chatgptCredentialStore, chatgptProvider, type ChatGPTRunnerOptions } from "./chatgpt-auth.ts";
import type { ForgeParts } from "./forge-assembly.ts";
import { createFailover } from "./provider-failover.ts";

type Env = Record<string, string | undefined>;
type ModelRef = { provider: string; id: string };
type ProviderRow = { id: string; kind: string; config: Record<string, any>; secret: string | null };
export type RunnerContext = {
	username: string | null;
	agent: { id: string; name: string; instructions: string; config: Record<string, any> } | null;
	skills: { name: string; description: string }[];
	goals: { id: string; title: string; steps: { title: string; done: boolean }[] }[];
	memories: { id: string; scope: string; title: string }[];
	contacts: { id: string; name: string; about: string }[];
	fallbacks: ModelRef[];
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
	fetch?: typeof fetch | undefined;
	now?: (() => number) | undefined;
};

const asModelRef = (v: unknown): ModelRef | null => {
	if (typeof v === "string") return v.includes("/") ? { provider: v.split("/")[0]!.replace(/^own:/, ""), id: v.split("/").slice(1).join("/") } : null;
	const m = v as { provider?: unknown; id?: unknown; modelId?: unknown } | null;
	const id = m?.id ?? m?.modelId;
	return m && typeof m.provider === "string" && typeof id === "string" ? { provider: m.provider.replace(/^own:/, ""), id } : null;
};

/** A pi-ai provider for an OpenAI-compatible endpoint: a gateway, a local server, or an owner's own. A server without a key is sent a placeholder. */
function compatibleProvider(id: string, name: string, baseUrl: string, models: { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; images?: boolean }[], key: () => string | undefined): Provider {
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
	const modelsByOwner = new Map<string, Models>();
	const failover = createFailover({ now, cooldowns: options.cooldowns });
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
		const rows = (await db.read<{ p: ProviderRow[] }>(ownerId, "SELECT pim_app.runner_providers($1) AS p", [ownerId]).catch(() => ({ rows: [{ p: [] as ProviderRow[] }] }))).rows[0]!.p;
		const keys = new Map<string, string>();
		for (const row of rows) {
			if (!row.secret || !options.crypto) continue;
			try {
				keys.set(row.id, await openString(options.crypto, row.secret, `provider:${ownerId}/${row.id}`));
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
				models.setProvider(compatibleProvider(row.id, String(row.config.name ?? row.id), url, row.config.models.filter((m: any) => typeof m?.id === "string"), () => keys.get(row.id)) as never);
			}
		}
		for (const extra of (await options.providers?.(ownerId)) ?? []) models.setProvider(extra as never);
		return models;
	}

	/** The first of these models the catalog can run (its provider is configured); when none can, the first one, which then fails with what is missing. */
	async function choose(ownerId: string, candidates: (ModelRef | null)[]): Promise<{ provider: string; modelId: string }> {
		const wanted = [...candidates, asModelRef(env.PIM_DEFAULT_MODEL)].filter((m): m is ModelRef => m !== null);
		const models = modelsByOwner.get(ownerId);
		const available = models ? await models.getAvailable().catch(() => []) : [];
		const found = wanted.find((w) => available.some((a) => a.provider === w.provider && a.id === w.id)) ?? (wanted.length === 0 ? available[0] : undefined);
		const chain = wanted.filter((w, i) => wanted.findIndex((x) => x.provider === w.provider && x.id === w.id) === i);
		const pick = found ? { provider: found.provider, id: found.id } : (wanted[0] ?? { provider: "anthropic", id: "claude-sonnet-4-5" });
		failover.setChain(ownerId, pick, chain);
		return { provider: pick.provider, modelId: pick.id };
	}

	/** Where an owner's images are drawn: their ChatGPT images sign-in, and the endpoints `PIM_IMAGE_MODEL` can name. `PIM_IMAGE_MODEL=off` has no `generate_image`. */
	const imageSources = (ownerId: string): ToolDeps["images"] =>
		env.PIM_IMAGE_MODEL === "off"
			? undefined
			: { model: env.PIM_IMAGE_MODEL, codex: () => (options.crypto ? new CodexImagesClient(db, options.crypto, ownerId, env, { fetch: options.fetch, now }) : undefined), endpoints: () => imageEndpoints(db, options.crypto, env, ownerId) };

	const harnessOptions = async (partition: PartitionContext): Promise<HarnessOptions> => {
		const ownerId = partition.ownerId;
		const models = await buildModels(ownerId);
		modelsByOwner.set(ownerId, models);
		const metered = meter(failover.wrap(models, ownerId), (message, model) => {
			const usage = message?.usage;
			if (!usage || !(usage.input > 0 || usage.output > 0)) return;
			void db
				.read(ownerId, "SELECT pim_app.record_model_call($1, $2, 'chat', NULL, $3, $4, $5, $6, $7)", [ownerId, `mc_${randomUUID()}`, message?.provider ?? model?.provider ?? null, message?.model ?? model?.id ?? null, Math.round(usage.input ?? 0), Math.round(usage.output ?? 0), Math.round((usage.cost?.total ?? 0) * 1_000_000)])
				.catch(() => {});
		});
		const registry = createRegistry();
		const deps: ToolDeps = { ownerId, partitionId: partition.partitionId, runtime: db, app: options.app, forge: options.forge, relay: options.relay, fetch: options.fetch ?? fetch, now, crypto: options.crypto, allowPrivateConnectors: env.PIM_CONNECTOR_ALLOW_PRIVATE === "1", images: imageSources(ownerId), chatOf: (conversationId) => publicChatId(ownerId, conversationId) };
		const ctx = (conversationId: number | string) => publicChatId(ownerId, conversationId).then((chat) => readContext(ownerId, chat));
		registry.install(pimExtension(deps, [
			section("agent", async (input) => {
				const c = await ctx(input.conversationId);
				const who = c.agent ? `You are ${c.agent.name}, an agent of ${c.username ?? "this person"} in Pim.` : `You are Pim, ${c.username ? `${c.username}'s` : "a person's"} assistant.`;
				return [who, c.agent?.instructions].filter(Boolean).join("\n\n");
			}),
			section("your_skills", async (input) => {
				const c = await ctx(input.conversationId);
				return c.skills.length === 0 ? undefined : `Skills you can load with read_skill:\n${c.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
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
		return { models: metered, registry } as HarnessOptions;
	};

	/** The model the owner chose in Settings for agents with none of their own (migration 0611). */
	const chosenModel = async (ownerId: string) => asModelRef((await db.read<{ m: unknown }>(ownerId, "SELECT pim_app.runner_model($1) AS m", [ownerId]).catch(() => ({ rows: [] as { m: unknown }[] }))).rows[0]?.m);

	const homeRoot: NonNullable<RunnerOptions["homeRoot"]> = async (ownerId) => {
		const c = await readContext(ownerId, null).catch(() => undefined);
		return { agent: { model: await choose(ownerId, [await chosenModel(ownerId), ...(c?.fallbacks ?? []).map(asModelRef)]) } };
	};
	const chatAgent: NonNullable<RunnerOptions["chatAgent"]> = async (ownerId, chat) => {
		const c = await readContext(ownerId, chat ?? null).catch(() => undefined);
		const own = c?.agent ? [asModelRef(c.agent.config.model), ...((c.agent.config.fallbacks ?? []) as unknown[]).map(asModelRef)] : [];
		return { model: await choose(ownerId, [...own, await chosenModel(ownerId), ...(c?.fallbacks ?? []).map(asModelRef)]) };
	};

	return { harnessOptions, homeRoot, chatAgent };
}
