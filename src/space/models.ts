/**
 * Which model runs what: the catalog and its failover while a plan cools down, the model of a space, an agent and a chat, the space's own
 * providers, and the utility model for side jobs.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import { type ModelRef, type TaskId } from "@earendil-works/pi-durable";
import { type PiModel, PiHarness } from "agents/harness/pi";
import { type Mailer, mailerFrom } from "../email";
import { answersInSchema, type CustomProvider, MAX_PROVIDERS, OWN_PROVIDER, piProvider, providerModel, prepareProvider, type ProviderInput, SHARED_PROVIDER } from "../providers";
import { ImageStore } from "../images";
import { CHATGPT_PROVIDER, ChatGPT } from "../chatgpt";
import { Cooldowns } from "../plan-quota";
import { type Cooldown, failingOver, ProviderCooldowns } from "../provider-cooldowns";
import { SqlCredentialStore } from "../credentials";
import { NOT_DELIVERED, OUT_OF_OUTPUT_TOKENS } from "../extensions/messaging";
import type { DeploymentSettings } from "../deployment";
import { HttpError } from "@pim/shared/http";
import type { ServerMessage } from "../protocol";
import { PimStore } from "../store";
import { type Agent, type AgentModel, AgentStore } from "../agents";
import { RoomStore } from "../rooms";
import type { Task } from "../tasks";
import { projectEntries } from "@pim/shared/transcript";
import { conversationText, type StructuredUtilityTask, type UtilityTask, withJsonSchema } from "../utility";
import { UsageMeter } from "../usage";
import { type OwnerStatus, type AiEnv, UTILITY_MODEL_KEY, OWN_PROVIDERS_KEY, SHARED_PROVIDERS_KEY, sameModel, errorMessage } from "./shared";

/**
 * The most a chat holds before it is compacted or carried on, whatever its model's window. All of a
 * space's chats live in its one Durable Object, whose memory holds a few chats of this size at once
 * but not chats of a million tokens: those reset it again and again, cutting off every run in it.
 */
export const CHAT_CONTEXT_LIMIT = 200_000;

/** The catalog with each model's window as far as `CHAT_CONTEXT_LIMIT`: what pi compacts against, and what a chat's summary is cut to. */
function withChatContextLimit(models: Models): Models {
	const limited = (model: Model<Api> | undefined) => (model && model.contextWindow > CHAT_CONTEXT_LIMIT ? { ...model, contextWindow: CHAT_CONTEXT_LIMIT } : model);
	// `Models` keeps private state: everything else runs on the original.
	return new Proxy(models, {
		get(target, property) {
			if (property === "getModel") return (provider: string, id: string) => limited(target.getModel(provider, id));
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** What wakes the chats held on a subscription's usage limit once its cooldown ends (see ./provider-cooldowns.ts). */
export const COOLDOWN_CALLBACK = "retryAfterCooldown";

/** `pim_meta` keys of the models chosen through the API: for chats, and the utility model. */
export const MODEL_KEY = "model";

/** The models every agent moves on to, after its own fallbacks, when its model fails for good. */
export const MODEL_FALLBACKS_KEY = "model_fallbacks";

/** What the space's models needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface ModelsHost {
	readonly rooms: RoomStore;
	readonly taskApart: (conversation: string) => Task | undefined;
	readonly taskUnderway: (conversation: string) => Task | undefined;
	readonly broadcastMessage: (message: ServerMessage) => void;
	readonly keepAliveWhile: <T>(fn: () => Promise<T>) => Promise<T>;
	readonly providerCooldowns: ProviderCooldowns;
	readonly fallbackModel: (provider: string, session?: string) => Model<Api> | undefined;
	readonly retryAfterCooldown: ({ provider, until }: { provider: string; until?: number; }) => Promise<void>;
	readonly closed: () => boolean;
	readonly schedule: (when: Date | string | number, callback: string, payload?: unknown, options?: { idempotent?: boolean }) => Promise<unknown>;
	readonly harness: PiHarness;
	readonly agents: AgentStore;
	readonly agentModel: (agent: Agent) => PiModel;
	readonly sessionModel: (session: string, agent?: Agent) => PiModel;
	readonly note: (event: string, fields: Record<string, unknown>) => void;
	readonly resumeTask: (session: string, task: TaskId) => ReturnType<PiHarness["resumeTask"]>;
	readonly credentials: SqlCredentialStore;
	readonly ai: import("agents/models/pi-ai").AI;
	readonly chatgpt: ChatGPT;
	catalogKept: Models | undefined;
	readonly models: () => MutableModels;
	readonly images: ImageStore;
	readonly usage: UsageMeter;
	readonly providerSessions: Map<string, string>;
	readonly modelCatalog: () => Models;
	readonly defaultModel: () => PiModel;
	readonly customProviders: () => { catalogId: string; shared: boolean; provider: CustomProvider; }[];
	readonly store: PimStore;
	readonly chooseModel: (model: PiModel | null) => Promise<PiModel>;
	readonly deployment: () => DeploymentSettings;
	readonly env: Env;
	readonly chosenModel: () => PiModel;
	readonly defaultUtilityModel: () => Model<Api> | undefined;
	readonly assertOpen: () => void;
	readonly status: () => OwnerStatus;
	readonly utilityModel: () => Promise<Model<Api> | undefined>;
}

export class SpaceModels {
	constructor(private readonly host: ModelsHost) {}

	/**
	 * Whether a run whose model failed for good is held for the person to try again. Only a chat is, and not while it works
	 * on a task: a task or a review has no one watching it, and its requester or caller needs the failure to go on.
	 */
	holdsRun(message: { errorMessage?: string; provider?: string; model?: string }, conversation: string): boolean {
		// A reply that was never delivered, or an answer cut off at the output limit twice, is not retried by anything: not by another model, and not at a cooldown's end, since
		// asking the same agent again would only repeat it. A room's member has no chat of its own to show the failure in, so it is
		// held for the person to try again. Every other run ends with it: its caller or watcher takes the failure as the answer.
		const undelivered = message.errorMessage === NOT_DELIVERED || message.errorMessage?.startsWith(OUT_OF_OUTPUT_TOKENS) === true;
		if (undelivered) {
			const seat = this.host.rooms.of(conversation);
			const held = seat !== undefined && seat.room !== conversation && !this.host.taskApart(conversation) && !this.host.taskUnderway(conversation);
			if (held) setTimeout(() => this.host.broadcastMessage({ type: "sessions" }), 1000);
			return held;
		}
		// Held only for a moment: the agent's next model takes the run over.
		const next = this.#nextModel(conversation, message);
		if (next) {
			void this.host.keepAliveWhile(() => this.#failOver(conversation, next));
			return true;
		}
		if (this.host.taskApart(conversation) || this.host.taskUnderway(conversation)) return false;
		// Held on a subscription's usage limit, the chat goes on by itself: on another model once there is one, else once the limit resets.
		const provider = message.provider;
		if (provider !== undefined && this.subscription(provider) && this.host.providerCooldowns.active(provider)) {
			void this.host.keepAliveWhile(() => (this.host.fallbackModel(provider) ? this.#resumeSoon(conversation) : this.host.retryAfterCooldown({ provider })));
		}
		// The chat list stops showing it as working once the hold is committed, just after this answers.
		setTimeout(() => this.host.broadcastMessage({ type: "sessions" }), 1000);
		return true;
	}

	/**
	 * Asks the model again in the chats held on a subscription's error once it
	 * has cooled down, or at once when another model can take them meanwhile.
	 * While it still cools down with nowhere else to go, wakes again at the
	 * cooldown's end, which `until` names, so each end is armed once.
	 */
	async retryAfterCooldown({ provider, until }: { provider: string; until?: number }): Promise<void> {
		if (this.host.closed()) return;
		const cooldown = this.host.providerCooldowns.active(provider);
		if (cooldown && !this.host.fallbackModel(provider)) {
			// Schedules keep whole seconds, so the wake is at the second after the end. One that came early anyway wakes
			// again a second later, as a new one: the schedule running now still matches its own.
			const at = Math.ceil(Math.max(cooldown.until, until === undefined ? 0 : until + 1000) / 1000) * 1000;
			await this.host.schedule(new Date(at), COOLDOWN_CALLBACK, { provider, until: at }, { idempotent: true });
			return;
		}
		for (const conversation of await this.#heldOn(provider)) await this.resumeHeld(conversation);
	}

	/** The chats held after an error from `provider`, such as its usage limit. */
	async #heldOn(provider: string): Promise<string[]> {
		const found: string[] = [];
		for (const conversation of await this.heldSessions()) {
			const failed = (await this.host.harness.session(conversation).messages()).map((entry) => entry.model?.[0]).findLast((message) => message?.role === "assistant" && message.stopReason === "error");
			if (failed?.role === "assistant" && failed.provider === provider) found.push(conversation);
		}
		return found;
	}

	/** The model after the one that failed in the agent's own and fallback models; none when it was the last, or isn't one of them. */
	#nextModel(conversation: string, failed: { provider?: string; model?: string }): PiModel | undefined {
		const chain = this.#chain(this.host.agents.ofSession(conversation), conversation);
		const at = chain.findIndex((model) => model.provider === failed.provider && model.id === failed.model);
		if (at < 0) return undefined;
		// Models of the provider that failed, or is cooling down, are skipped.
		return chain.slice(at + 1).find((model) => model.provider !== failed.provider && !this.host.providerCooldowns.active(model.provider));
	}

	/** The models a run of an agent tries, in order: its own, its fallbacks, then the space's, each once. */
	#chain(agent: Agent, session?: string): PiModel[] {
		const chain: PiModel[] = [];
		for (const model of [session === undefined ? this.host.agentModel(agent) : this.host.sessionModel(session), ...this.#fallbackModels(agent), ...this.workspaceFallbacks()]) {
			if (!chain.some((known) => sameModel(known, model))) chain.push(model);
		}
		return chain;
	}

	/** Moves a held run onto `model` and runs it again there. */
	async #failOver(conversation: string, model: PiModel): Promise<void> {
		this.host.note("failover", { conversation, provider: model.provider, model: model.id });
		await this.host.harness.session(conversation).setModel(model);
		await this.#resumeSoon(conversation);
	}

	/** Runs a run being held again as soon as its hold is committed, which is just after its hook answers. */
	async #resumeSoon(conversation: string): Promise<void> {
		for (let attempt = 0; attempt < 20; attempt++) {
			if (await this.resumeHeld(conversation)) return;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	/** The conversations whose runs are held after a model error: not working, but waiting for the person to try again. */
	async heldSessions(): Promise<Set<string>> {
		const { tasks } = await (await this.host.harness.pi()).inspect(BACKGROUND_CONTEXT);
		return new Set(tasks.filter(({ record }) => this.#isHeld(record)).map(({ record }) => String(record.conversationId)));
	}

	/** Asks the model again in a conversation whose run is held after a model error; false when none is. */
	async resumeHeld(conversation: string): Promise<boolean> {
		const { tasks } = await (await this.host.harness.pi()).inspect(BACKGROUND_CONTEXT);
		const held = tasks.find(({ record }) => String(record.conversationId) === conversation && this.#isHeld(record));
		if (!held) return false;
		await this.host.resumeTask(conversation, held.record.id);
		return true;
	}

	#isHeld(record: { kind: string; state: { status: string; on?: readonly unknown[] } }): boolean {
		return record.kind === "pi.generation" && record.state.status === "waiting" && record.state.on?.length === 0;
	}

	/** The model catalog pi resolves sessions' models against: Workers AI, and the ChatGPT plan. People's providers join it in `modelCatalog`. */
	models(): MutableModels {
		const models = createModels({ credentials: this.host.credentials });
		models.setProvider(this.host.ai.provider);
		models.setProvider(this.host.chatgpt.provider());
		return models;
	}

	/**
	 * One catalog for pi and the API, so a token refresh is never run twice at
	 * once. Every request through it is metered, and gets the chat's images.
	 * A request to the ChatGPT plan while it cools down after its usage limit,
	 * or one that finds the limit, goes to the deployment's default model.
	 */
	modelCatalog(): Models {
		if (!this.host.catalogKept) {
			this.#models = this.host.models();
			this.#syncProviders();
			this.#ownCatalog = this.host.images.resolving(this.host.usage.meter(this.#models));
			this.host.catalogKept = withChatContextLimit(
				failingOver(this.#ownCatalog, {
					cooldowns: this.host.providerCooldowns,
					subscription: (provider) => this.subscription(provider),
					fallback: (provider, sessionId) => this.host.fallbackModel(provider, sessionId === undefined ? undefined : this.host.providerSessions.get(sessionId)),
					cooled: (cooldown) => this.#cooled(cooldown),
				}),
			);
		}
		return this.host.catalogKept;
	}

	/** Notes a subscription's cooldown, and has the chats held on it go on: on the default model at once, or when the cooldown ends. */
	#cooled({ provider, until, failures, resetFrom }: Cooldown): void {
		this.host.note("provider_cooldown", { provider, until: new Date(until).toISOString(), failures, resetFrom });
		void this.host.keepAliveWhile(() => this.host.retryAfterCooldown({ provider })).catch((error) => console.warn("retrying after a cooldown failed", error));
	}

	/** The catalog without failing over, for side jobs, which choose their own model when the plan can't answer (see `#askUtility`). */
	#ownCatalog: Models | undefined;

	/** Whether a provider is a subscription: one that is free per call and has a usage limit, which is only the ChatGPT plan. */
	subscription(provider: string): boolean {
		return provider === CHATGPT_PROVIDER;
	}

	/**
	 * The model a subscription's runs go to while it cools down: the
	 * deployment's default, when that is another provider's and can run here;
	 * else none, and the runs wait for the limit to reset.
	 */
	fallbackModel(provider: string, session?: string): Model<Api> | undefined {
		// The agent's own fallbacks come first, then the space's, then the deployment's default.
		const agent = session === undefined ? undefined : this.host.agents.findOfSession(session);
		const listed = [...(agent ? this.#fallbackModels(agent) : []), ...this.workspaceFallbacks()].find((model) => model.provider !== provider);
		if (listed) return this.host.modelCatalog().getModel(listed.provider, listed.id);
		const model = this.host.defaultModel();
		if (model.provider === provider) return undefined;
		// Without Workers AI, the default is the first custom provider's model; with none, there is nothing to run.
		if (!this.hasWorkersAi() && !this.host.customProviders().some((entry) => entry.provider.models.length > 0)) return undefined;
		// As pi resolves a session's model.
		return this.host.modelCatalog().getModel(model.provider, model.id);
	}

	/** The catalog before metering, which providers are added to and taken from as they change. */
	#models: MutableModels | undefined;

	/** The model providers the person can use, by catalog id: the admin's, then their own. Keys included. */
	customProviders(): { catalogId: string; shared: boolean; provider: CustomProvider }[] {
		const read = (key: string) => JSON.parse(this.host.store.meta(key) ?? "[]") as CustomProvider[];
		return [
			...read(SHARED_PROVIDERS_KEY).map((provider) => ({ catalogId: `${SHARED_PROVIDER}${provider.id}`, shared: true, provider })),
			...read(OWN_PROVIDERS_KEY).map((provider) => ({ catalogId: `${OWN_PROVIDER}${provider.id}`, shared: false, provider })),
		];
	}

	/** Puts the providers as they are now in the catalog, which pi keeps, and takes out those that are gone. */
	#syncProviders(): void {
		const models = this.#models;
		if (!models) return;
		const current = this.host.customProviders();
		const gone = models
			.getProviders()
			.map((provider) => provider.id)
			.filter((id) => (id.startsWith(OWN_PROVIDER) || id.startsWith(SHARED_PROVIDER)) && !current.some((entry) => entry.catalogId === id));
		for (const id of gone) models.deleteProvider(id);
		for (const { catalogId, provider } of current) models.setProvider(piProvider(catalogId, provider));
	}

	/** After providers change: sessions and side jobs on a model that's gone go back to the defaults. */
	async providersChanged(): Promise<void> {
		// A catalog not built yet will have them when it is.
		if (this.host.catalogKept) this.#syncProviders();
		const catalog = this.host.modelCatalog();
		const missing = (key: string) => {
			const json = this.host.store.meta(key);
			if (json === undefined) return false;
			const { provider, id } = JSON.parse(json) as { provider: string; id: string };
			return (provider.startsWith(OWN_PROVIDER) || provider.startsWith(SHARED_PROVIDER)) && !catalog.getModel(provider, id);
		};
		if (missing(UTILITY_MODEL_KEY)) this.host.store.deleteMeta(UTILITY_MODEL_KEY);
		this.dropModels(({ provider, id }) => (provider.startsWith(OWN_PROVIDER) || provider.startsWith(SHARED_PROVIDER)) && !catalog.getModel(provider, id));
		// Without Workers AI, the default is a provider's model, so it changes as providers come and go.
		if (missing(MODEL_KEY) || (!this.hasWorkersAi() && this.host.store.meta(MODEL_KEY) === undefined)) await this.host.chooseModel(null);
	}

	/** The person adds a model provider of their own, or changes one; its models are read from the server again. */
	async putOwnProvider(id: string | null, input: ProviderInput): Promise<CustomProvider> {
		const own = () => JSON.parse(this.host.store.meta(OWN_PROVIDERS_KEY) ?? "[]") as CustomProvider[];
		const providers = own();
		const existing = id === null ? null : (providers.find((provider) => provider.id === id) ?? null);
		if (id !== null && !existing) throw new HttpError(404, `No provider ${id}`);
		if (!existing && providers.length >= MAX_PROVIDERS) throw new HttpError(400, `You can add up to ${MAX_PROVIDERS} providers.`);
		const provider = await prepareProvider(input, existing, new Set(providers.map((candidate) => candidate.id)));
		// Reading the models took a while: another may have been added, or this one removed, since.
		const now = own();
		if (now.some((candidate) => candidate.id === provider.id) !== (existing !== null)) {
			throw new HttpError(409, existing ? "That provider was just removed." : "Another provider was just added: try again.");
		}
		const next = existing ? now.map((candidate) => (candidate.id === provider.id ? provider : candidate)) : [...now, provider];
		this.host.store.setMeta(OWN_PROVIDERS_KEY, JSON.stringify(next));
		await this.providersChanged();
		return provider;
	}

	/**
	 * Platform models besides the default that sessions may use: `PIM_MODELS`.
	 * None allows any Workers AI or AI Gateway model, as a deployment that
	 * doesn't mind the cost; one with members lists the ones it pays for.
	 */
	allowedModels(): readonly string[] | null {
		const { models } = this.host.deployment();
		return models.length === 0 ? null : models;
	}

	/** How this deployment sends email (`EMAIL` and `PIM_EMAIL_FROM`); null when it can't. */
	mailer(): Mailer | null {
		return mailerFrom(this.host.env);
	}

	/** The deployment's model (`PIM_MODEL`), used whenever no other is chosen. */
	defaultModel(): PiModel {
		if (!this.hasWorkersAi()) {
			// The first model of the first provider: the admin's, then the person's own.
			for (const { catalogId, provider } of this.host.customProviders()) {
				if (provider.models[0]) return providerModel(catalogId, provider, provider.models[0]);
			}
		}
		return this.host.ai(this.host.deployment().model);
	}

	/** Whether this deployment has Workers AI: the `AI` binding. */
	hasWorkersAi(): boolean {
		return (this.host.env as AiEnv).AI !== undefined;
	}

	/** The model of agents that have none of their own: the one chosen for the space through the API, or the default. */
	chosenModel(): PiModel {
		const json = this.host.store.meta(MODEL_KEY);
		if (json !== undefined) {
			const { provider, id } = JSON.parse(json) as { provider: string; id: string };
			const model = this.host.modelCatalog().getModel(provider, id);
			if (model) return model;
		}
		return this.host.defaultModel();
	}

	/** The model an agent's conversations run on: its own, else the space's. One that's gone, or on a plan that isn't connected, is not read: see `#dropModels`. */
	agentModel(agent: Agent): PiModel {
		if (agent.model) {
			const model = this.host.modelCatalog().getModel(agent.model.provider, agent.model.id);
			if (model) return model;
		}
		return this.host.chosenModel();
	}

	/** The model a chat runs on: the one chosen for it alone, else its agent's, else the space's. One that's gone is not read. */
	sessionModel(session: string, agent: Agent = this.host.agents.ofSession(session)): PiModel {
		const chosen = this.host.store.sessionInfo(session)?.model;
		const model = chosen && this.host.modelCatalog().getModel(chosen.provider, chosen.id);
		return model || this.host.agentModel(agent);
	}

	/** The model a new run starts on: the chat's own, or while its subscription cools down, the first model of its chain on another provider. */
	runModel(session: string): PiModel {
		const own = this.host.sessionModel(session);
		if (!this.subscription(own.provider) || !this.host.providerCooldowns.active(own.provider)) return own;
		return this.#chain(this.host.agents.ofSession(session), session).find((model) => model.provider !== own.provider && !this.host.providerCooldowns.active(model.provider)) ?? own;
	}

	/** The models the space moves on to, in order, after an agent's own fallbacks; ones that are gone are not read: see `#dropModels`. */
	workspaceFallbacks(): PiModel[] {
		const list = JSON.parse(this.host.store.meta(MODEL_FALLBACKS_KEY) ?? "[]") as AgentModel[];
		return list.flatMap(({ provider, id }) => this.host.modelCatalog().getModel(provider, id) ?? []);
	}

	/** Sets the models every agent moves on to after its own fallbacks, from `GET /model`'s choices. */
	chooseModelFallbacks(models: PiModel[]): PiModel[] {
		if (models.length === 0) this.host.store.deleteMeta(MODEL_FALLBACKS_KEY);
		else this.host.store.setMeta(MODEL_FALLBACKS_KEY, JSON.stringify(models.map(({ provider, id }) => ({ provider, id }))));
		return this.workspaceFallbacks();
	}

	/** The models an agent moves on to, in order, when its own fails for good; ones that are gone are not read: see `#dropModels`. */
	#fallbackModels(agent: Agent): PiModel[] {
		return agent.fallbacks.flatMap((fallback) => this.host.modelCatalog().getModel(fallback.provider, fallback.id) ?? []);
	}

	/**
	 * A model from `GET /model`'s choices, by provider and id: the deployment's,
	 * one it allows besides, or one on the connected ChatGPT plan.
	 */
	async choice(provider: string, id: string): Promise<PiModel> {
		const fallback = this.host.defaultModel();
		if (provider === fallback.provider && id === fallback.id) return fallback;
		if (this.hasWorkersAi() && provider === fallback.provider && this.allowedModels()?.includes(id)) return this.host.ai(id);
		const model = this.host.modelCatalog().getModel(provider, id);
		if (!model) throw new HttpError(400, `No model ${provider}/${id}`);
		if (provider === CHATGPT_PROVIDER && !(await this.host.chatgpt.status()).connected) {
			throw new HttpError(409, "Sign in with ChatGPT first");
		}
		return model;
	}

	/** Makes `model` the space's, for agents that have none of their own; null goes back to the default. */
	async chooseModel(model: PiModel | null): Promise<PiModel> {
		if (model === null) this.host.store.deleteMeta(MODEL_KEY);
		else this.host.store.setMeta(MODEL_KEY, JSON.stringify({ provider: model.provider, id: model.id }));
		await this.syncModels();
		return this.host.chosenModel();
	}

	/** Makes `model` an agent's; null follows the space's again. */
	async chooseAgentModel(agent: Agent, model: PiModel | null): Promise<Agent> {
		const changed = this.host.agents.setModel(agent.id, model);
		await this.syncModels();
		return changed;
	}

	/** Sets the models an agent moves on to when its own fails, from `GET /model`'s choices. */
	async chooseAgentFallbacks(agent: Agent, models: PiModel[]): Promise<Agent> {
		return this.host.agents.setFallbacks(agent.id, models);
	}

	/** Makes `model` the model of one chat alone, over its agent's; null follows the agent's again. */
	async chooseSessionModel(session: string, model: PiModel | null): Promise<PiModel> {
		this.host.store.setSessionModel(session, model);
		const resolved = this.host.sessionModel(session);
		await this.host.harness.session(session).setModel(resolved);
		this.host.broadcastMessage({ type: "sessions" });
		return resolved;
	}

	/** Puts every session on its own model, else its agent's. */
	async syncModels(): Promise<void> {
		for (const session of await this.host.harness.sessions.list()) {
			await this.host.harness.session(session.id).setModel(this.host.sessionModel(session.id));
		}
	}

	/** Agents whose model `gone` says can't be used any more go back to following the space's. */
	dropModels(gone: (model: AgentModel) => boolean): void {
		const shared = JSON.parse(this.host.store.meta(MODEL_FALLBACKS_KEY) ?? "[]") as AgentModel[];
		if (shared.some(gone)) {
			const kept = shared.filter((model) => !gone(model));
			if (kept.length === 0) this.host.store.deleteMeta(MODEL_FALLBACKS_KEY);
			else this.host.store.setMeta(MODEL_FALLBACKS_KEY, JSON.stringify(kept));
		}
		for (const agent of this.host.agents.list()) {
			if (agent.model && gone(agent.model)) this.host.agents.setModel(agent.id, null);
			if (agent.fallbacks.some(gone)) this.host.agents.setFallbacks(agent.id, agent.fallbacks.filter((model) => !gone(model)));
		}
	}

	/**
	 * The model that compresses memories: `PIM_MEMORY_MODEL`, else `PIM_MODEL`.
	 * Never the chosen model, so background work does not spend a ChatGPT plan.
	 */
	memoryModel(): ModelRef | undefined {
		if (!this.hasWorkersAi()) {
			// The conversation's own model, unless it is the plan, which is out of quota: then a custom provider's.
			const alternative = this.#planCooledDown() || this.host.chosenModel().provider === CHATGPT_PROVIDER ? this.#customFallback() : undefined;
			return alternative ? { provider: alternative.provider, modelId: alternative.id } : undefined;
		}
		const { memoryModel, model: fallback } = this.host.deployment();
		const model = this.host.ai(memoryModel ?? fallback);
		return { provider: model.provider, modelId: model.id };
	}

	/**
	 * The deployment's utility model (`PIM_UTILITY_MODEL` on Workers AI), for
	 * side jobs such as naming chats (see ./utility.ts). `off` turns them off.
	 */
	defaultUtilityModel(): Model<Api> | undefined {
		const { utilityModel } = this.host.deployment();
		return utilityModel && this.hasWorkersAi() ? this.host.ai(utilityModel) : undefined;
	}

	/**
	 * Whether a provider's models may be the utility model: the ChatGPT plan's,
	 * and those of a provider that answers in a JSON schema (see `answersInSchema`),
	 * which structured jobs need. The deployment's default is the admin's choice.
	 */
	utilityProvider(provider: string): boolean {
		return provider === CHATGPT_PROVIDER || this.host.customProviders().some((entry) => entry.catalogId === provider && answersInSchema(entry.provider));
	}

	/**
	 * The utility model: the one chosen through the API, or the default.
	 * A ChatGPT model counts only while the plan is connected, and a chosen
	 * model whose provider no longer answers in a schema is skipped.
	 */
	async utilityModel(): Promise<Model<Api> | undefined> {
		const model = await this.#chosenUtilityModel();
		// The plan said it is out of quota: side jobs use the default or a custom provider's model until it has had time to recover.
		// With no other model to use, side jobs go without one: never back to the plan that just failed.
		if (model?.provider === CHATGPT_PROVIDER && this.#planCooledDown()) return this.host.defaultUtilityModel() ?? this.#customFallback();
		return model;
	}

	/** Whether the ChatGPT plan is cooling down after its usage limit, or failed otherwise a moment ago, so side jobs leave it alone. */
	#planCooledDown(): boolean {
		return this.host.providerCooldowns.active(CHATGPT_PROVIDER) !== undefined || this.#cooldowns.blocked(CHATGPT_PROVIDER);
	}

	/** Leaves the plan alone after a side job's failure: until its limit resets, when it says it is out, else for a minute. */
	#planFailed(message: string | undefined): void {
		const cooldown = this.host.providerCooldowns.failed(CHATGPT_PROVIDER, { message });
		if (!cooldown) this.#cooldowns.failed(CHATGPT_PROVIDER);
	}

	readonly #cooldowns = new Cooldowns();

	/** A custom provider's model that answers in a JSON schema, the chosen model's provider first, for when the plan can't be asked. */
	#customFallback(): Model<Api> | undefined {
		const chosen = this.host.chosenModel().provider;
		const entries = this.host.customProviders().filter((entry) => answersInSchema(entry.provider));
		const entry = entries.find((candidate) => candidate.catalogId === chosen) ?? entries[0];
		const first = entry?.provider.models[0];
		return entry && first ? this.host.modelCatalog().getModel(entry.catalogId, first.id) : undefined;
	}

	async #chosenUtilityModel(): Promise<Model<Api> | undefined> {
		const json = this.host.store.meta(UTILITY_MODEL_KEY);
		if (json !== undefined) {
			const { provider, id } = JSON.parse(json) as { provider: string; id: string };
			const model = this.host.modelCatalog().getModel(provider, id);
			if (model && this.utilityProvider(provider) && (provider !== CHATGPT_PROVIDER || (await this.host.chatgpt.status()).connected)) return model;
		}
		return this.host.defaultUtilityModel();
	}

	/**
	 * Runs a side job on the utility model and returns its answer, cleaned as
	 * the task says. It counts against the daily model limits, but not as a run.
	 */
	async utility(task: UtilityTask, input: string): Promise<string> {
		const answer = await this.#askUtility(task.instructions, task.maxTokens, input);
		const text = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		const result = task.clean ? task.clean(text) : text.trim();
		if (answer.stopReason === "error" || result === "") {
			throw new HttpError(502, `The utility model couldn't answer: ${answer.errorMessage ?? "it said nothing"}`);
		}
		return result;
	}

	/**
	 * Runs a side job whose answer is structured: the model answers in JSON
	 * that follows the task's schema, which its provider enforces. Only models
	 * that can are the utility model (see `utilityModel`).
	 */
	async utilityStructured<T extends readonly unknown[]>(task: StructuredUtilityTask<T>, input: string): Promise<T> {
		const answer = await this.#askUtility(task.instructions, task.maxTokens, input, (payload, model) => withJsonSchema(model.api, payload, task.schema));
		const text = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {}
		const result = task.result(parsed);
		if (answer.stopReason === "error" || result.length === 0) {
			throw new HttpError(502, `The utility model couldn't answer: ${answer.errorMessage ?? "it didn't answer in the schema"}`);
		}
		return result;
	}

	async #askUtility(instructions: string, maxTokens: number, input: string, onPayload?: (payload: unknown, model: Model<Api>) => unknown) {
		this.host.assertOpen();
		if (this.host.status() !== "active") throw new HttpError(403, "This space is suspended");
		const model = await this.host.utilityModel();
		if (!model) throw new HttpError(503, "This space has no utility model");
		this.host.modelCatalog();
		const ask = (asked: Model<Api>) =>
			this.#ownCatalog!.completeSimple(
				asked,
				{ systemPrompt: instructions, messages: [{ role: "user", content: input, timestamp: Date.now() }] },
				// A reasoning model thinks as little as it can; a cap on its tokens could cut off the answer.
				{ ...(asked.reasoning ? { reasoning: "minimal" } : { maxTokens }), ...(onPayload && { onPayload }), signal: AbortSignal.timeout(60_000) },
			);
		let answer: Awaited<ReturnType<typeof ask>>;
		const sentAt = Date.now();
		try {
			answer = await ask(model);
		} catch (error) {
			// A request that throws instead of answering with an error counts as a failure too.
			if (model.provider === CHATGPT_PROVIDER) this.#planFailed(errorMessage(error));
			throw error;
		}
		if (model.provider !== CHATGPT_PROVIDER) return answer;
		if (answer.stopReason !== "error") {
			if (answer.stopReason !== "aborted") this.host.providerCooldowns.succeeded(CHATGPT_PROVIDER, sentAt);
			return answer;
		}
		// The plan failed, most likely out of quota: leave it alone for a while, and answer this once from another provider.
		this.#planFailed(answer.errorMessage);
		const other = this.host.defaultUtilityModel() ?? this.#customFallback();
		return other ? ask(other) : answer;
	}

	/** A session's conversation as the utility model reads it; 409 when there is nothing in it yet. */
	async conversationText(session: string, limit: number): Promise<string> {
		const text = conversationText(projectEntries(await this.host.harness.session(session).messages()), limit);
		if (text === "") throw new HttpError(409, "This chat has no conversation yet");
		return text;
	}
}
