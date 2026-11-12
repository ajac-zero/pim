import type { MutableModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace";
import type { PiModel } from "agents/harness/pi";
import { Pim as RealPim } from "../src/pim";
import type { Mail, Mailer } from "../src/email";
import { deploymentSettings } from "../src/deployment";
import { type ImageModel, workersAiImageModel } from "../src/extensions/image-generation";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
import { section } from "@earendil-works/pi-durable";
import { defineAppTool, defineGatedAction, definePimExtension, oauth2, type PimConfig } from "../src/extensions/define";
import { GOOGLE_SCOPES, googleApp, googleJson } from "../src/extensions/google";
import { hostOpsExtension } from "../src/extensions/hostops";
import { CodingSchedulerDO as RealCodingSchedulerDO, type SchedulerNotifier } from "../src/coding/scheduler-do";
import { type CodingEventSink, type CodingThreadEvent, CodingThreadDO as RealCodingThreadDO } from "../src/coding/thread-do";
import type { Fetch, GitHubApp } from "../src/coding/git-broker/github-app";
import { DEFAULT_GATEWAY_LIMITS, type GatewayLimits } from "../src/coding/model-gateway";
import type { OrbClientFactory } from "../src/coding/orb/types";
import type { ComputeProvider, ComputeQuota } from "../src/compute";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { workspaceRegistry, type WorkspaceProviderRegistry } from "../src/coding/workspace/registry";
import type { Provider } from "@earendil-works/pi-ai";
import { loginProvider } from "./fake-claude-login";
import { fakeContainers } from "./fake-container";
import { fakeGit } from "./fake-git";

export { default, Auth, Directory, Gallery, HostOps } from "../src/index";

/** The scripted model every test agent talks to. Tests set its responses. */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", contextWindow: 200_000 }] });

/** The scripted model that compresses memories, kept apart so naps never take the conversation's responses. */
export const napper = fauxProvider({ provider: "napper", models: [{ id: "napper-model" }] });

/** The scripted utility model (src/utility.ts). With no responses set it fails, so a session keeps its first message's start. */
export const utility = fauxProvider({ provider: "utility", models: [{ id: "utility-model" }] });

/** A chat completions stream, as an OpenAI-compatible server sends it, that delivers `text` through send_to_user. */
export function completionStream(model: string, text: string): Response {
	const chunk = (choice: Record<string, unknown>) => ({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, ...choice }] });
	const call = { index: 0, id: "call_1", type: "function", function: { name: "send_to_user", arguments: "" } };
	const events = [
		chunk({ delta: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: null }),
		chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ message: text }) } }] }, finish_reason: null }),
		chunk({ delta: {}, finish_reason: "tool_calls" }),
		{ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
	];
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Every span the test agents' traces sent, as the deployment's OTLP backend would get them. */
export const spans = new InMemorySpanExporter();

/** Every email the test agents sent, in order: tests read it as an inbox. */
export const outbox: Mail[] = [];

/** What the test agents asked Workers AI's image model for, as it read each request's multipart form. */
export const paintings: { model: string; fields: Record<string, string> }[] = [];

/** A stand-in for Workers AI's `AI.run` with an image model: it reads the form FLUX.2 takes, and answers a 1×1 PNG, as JSON. */
const imageAi = {
	async run(model: string, input: { multipart: { body: ReadableStream; contentType: string } }) {
		const form = await new Response(input.multipart.body, { headers: { "content-type": input.multipart.contentType } }).formData();
		paintings.push({ model, fields: Object.fromEntries([...form].map(([name, value]) => [name, String(value)])) });
		return { image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" };
	},
} as unknown as Ai;

type Bill = { name: string; amount: number; due: string; paid: boolean };

/**
 * A deployment's own extension, as tests install it: apps, widgets,
 * one of which always fails, and an
 * ability that keeps bills in the extension's data: a tool to add one, an
 * action that asks before paying one, and a section listing them.
 */
export const ledger = definePimExtension({
	id: "test.ledger",
	name: "Ledger",
	description: "Keeps the books.",
	ability: ({ data }) => {
		const bills = () => data.list<Bill>("bill:").map(({ value }) => value);
		return {
			sections: [section("ledger_bills", () => bills().map((bill) => `${bill.name}: ${bill.amount}${bill.paid ? " (paid)" : ""}`).join("\n") || "No bills.")],
			actions: [
				defineGatedAction({
					name: "ledger_add_bill",
					description: "Record a bill to pay.",
					parameters: Type.Object({ name: Type.String(), amount: Type.Number(), due: Type.String() }),
					summarize: ({ name }) => `Record ${name}`,
					async run({ name, amount, due }) {
						data.put(`bill:${name}`, { name, amount, due, paid: false });
						return `Recorded ${name}.`;
					},
				}),
				defineGatedAction({
					name: "ledger_pay_bill",
					description: "Pay a recorded bill.",
					explicitApproval: true,
					parameters: Type.Object({ name: Type.String() }),
					summarize: ({ name }) => `Pay ${name}`,
					async run({ name }) {
						const bill = data.get<Bill>(`bill:${name}`);
						if (!bill) return `No bill called ${name}.`;
						data.put(`bill:${name}`, { ...bill, paid: true });
						return `Paid ${name}.`;
					},
				}),
			],
		};
	},
	widgets: {
		bills: {
			title: { en: "Upcoming bills", es: "Próximas facturas" },
			empty: "No bills.",
			description: "Bills not paid yet, with when each is due.",
			load: ({ data }) => ({
				kind: "list",
				items: data
					.list<Bill>("bill:")
					.filter(({ value }) => !value.paid)
					.map(({ value }) => ({ title: `${value.name}: ${value.amount}`, time: value.due })),
			}),
		},
		broken: {
			title: "Bank balance",
			empty: "",
			description: "The bank balance.",
			load: () => {
				throw new Error("The bank is unreachable");
			},
		},
	},
	// The apps tests connect: each test routes its URL to an MCP server of its own, or to none.
	apps: [
		{ id: "weather", name: "Weather", description: "Tomorrow's forecast.", url: "https://weather.example.test/mcp" },
		{ id: "calendar", name: "Calendar", description: "Your events.", url: "https://calendar.example.test/mcp" },
		{ id: "notes", name: "Notes", description: "Search your notes.", url: "https://notes.example.test/mcp" },
		{ id: "firecrawl", name: "Firecrawl", description: "Crawls web pages.", url: "https://firecrawl.example.test/mcp" },
		{ id: "travel", name: "Travel", description: "Trips and flights.", url: "https://travel.example.test/mcp" },
		{ id: "down", name: "Down", description: "A server that never answers.", url: "https://down.example.test/mcp" },
		{ id: "strava", name: "Strava", description: "Your runs.", url: "https://mcp.strava.example/mcp" },
		{ id: "github", name: "GitHub", description: "Code and pull requests.", url: "https://mcp.github.example/mcp" },
		{ id: "docs", name: "Docs", description: "Documentation.", url: "https://mcp.docs.example/mcp" },
		// Servers whose sign-in has no client registration: the deployment registered Forge's client (forge.example.test, which tests answer), and never Hub's.
		{
			id: "forge",
			name: "Forge",
			description: "Code review.",
			url: "https://forge.example.test/mcp",
			client: { id: "TEST_FORGE_CLIENT_ID", secret: "TEST_FORGE_CLIENT_SECRET" },
		},
		{ id: "hub", name: "Hub", description: "Never set up.", url: "https://hub.example.test/mcp", client: { id: "TEST_HUB_CLIENT_ID" } },
		// And one whose sign-in lets Pim register itself, as most do (board.example.test, which tests answer).
		{ id: "board", name: "Board", description: "Boards and cards.", url: "https://board.example.test/mcp" },
		// And one whose sign-in takes Pim's client metadata document, as Amp's does (studio.example.test, which tests answer).
		{ id: "studio", name: "Studio", description: "Designs.", url: "https://studio.example.test/mcp", client: "metadata-document" },
		// The real one, for `pnpm test:live`.
		{ id: "hugging-face", name: "Hugging Face", description: "Models, datasets and skills.", url: "https://huggingface.co/mcp" },
		// Apps the extension implements: a bank behind OAuth (its service is bank.example.test, which tests answer), and one whose secret is never set.
		{
			id: "bank",
			name: "Bank",
			description: "Balances and transfers.",
			secrets: ["TEST_BANK_CLIENT_ID", "TEST_BANK_CLIENT_SECRET"],
			...oauth2({
				authorizeUrl: "https://bank.example.test/authorize",
				tokenUrl: "https://bank.example.test/token",
				scopes: ["balances", "transfers"],
				clientId: "TEST_BANK_CLIENT_ID",
				clientSecret: "TEST_BANK_CLIENT_SECRET",
			}),
			tools: [
				defineAppTool({
					name: "balance",
					description: "The person's balances.",
					parameters: Type.Object({}),
					readOnly: true,
					async execute(_args, { credential }) {
						const response = await fetch("https://bank.example.test/balances", { headers: { authorization: `Bearer ${credential.accessToken}` } });
						const accounts = (await response.json()) as { name: string; balance: number }[];
						return {
							text: accounts.map((account) => `${account.name}: ${account.balance}`).join("\n"),
							widget: { title: "Balances", kind: "list", items: accounts.map((account) => ({ title: account.name, detail: String(account.balance) })) },
						};
					},
				}),
				defineAppTool({
					name: "transfer",
					description: "Move money between the person's accounts.",
					destructive: true,
					parameters: Type.Object({ amount: Type.Number() }),
					async execute({ amount }) {
						return `Moved ${amount}.`;
					},
				}),
			],
		},
		{
			id: "vault",
			name: "Vault",
			description: "Never configured.",
			secrets: ["TEST_VAULT_KEY"],
			signIn: async () => ({ url: "https://vault.example.test" }),
			callback: async () => ({}),
			tools: [],
		},
	],
});

/** A Google app's one tool in tests: a request to a Google API, by its URL, with the person's credential. */
const googleRequest = defineAppTool({
	name: "request",
	description: "A request to a Google API.",
	parameters: Type.Object({ url: Type.String(), method: Type.Optional(Type.String()) }),
	readOnly: true,
	async execute({ url, method }, context) {
		return JSON.stringify(await googleJson(context, url, method ? { method } : {}));
	},
});

/**
 * Google apps made as Gmail and Drive are, against Google's addresses,
 * which tests answer: Mail and Files, each with its own OAuth client, and
 * one whose client is never set. (The real Gmail and Drive are the
 * deployment's `google` extension.)
 */
export const google = definePimExtension({ id: "test.google", name: "Test Google", description: "Google apps for tests.", apps: [
	googleApp({ id: "mail", name: "Mail", description: "Reads mail.", client: { id: "TEST_GMAIL_CLIENT_ID", secret: "TEST_GMAIL_CLIENT_SECRET" }, scopes: [GOOGLE_SCOPES.gmailReadonly], tools: [googleRequest] }),
	googleApp({ id: "files", name: "Files", description: "Picked files.", client: { id: "TEST_DRIVE_CLIENT_ID", secret: "TEST_DRIVE_CLIENT_SECRET" }, scopes: [GOOGLE_SCOPES.driveFile], tools: [googleRequest] }),
	googleApp({ id: "unset", name: "Unset", description: "Never configured.", client: { id: "TEST_UNSET_CLIENT_ID", secret: "TEST_UNSET_CLIENT_SECRET" }, scopes: [GOOGLE_SCOPES.driveFile], tools: [] }),
] });

/** How long the tests' host operation tools wait for an operation to end. */
export const HOSTOPS_TEST_WAIT_MS = 4_000;

/** How far tests have moved the triggers' clock on from the time (test/triggers-host.test.ts). */
export const triggerClock = { offset: 0 };

export class Pim extends RealPim {
	/** The triggers' clock, which tests move on to make triggers due without waiting. */
	protected override triggerClock(): number {
		return Date.now() + triggerClock.offset;
	}

	/** The deployment's extensions, with host operations that wait seconds rather than minutes, and the tests' own. */
	protected override pimConfig(): PimConfig {
		const config = super.pimConfig();
		const extensions = config.extensions.map((extension) => (extension.id === "hostops" ? hostOpsExtension({ waitMs: HOSTOPS_TEST_WAIT_MS }) : extension));
		return { ...config, extensions: [...extensions, ledger, google] };
	}

	/** Email works in tests, into `outbox`. */
	protected override mailer(): Mailer {
		return { send: async (mail) => void outbox.push(mail) };
	}

	/** Traces go to `spans`. */
	protected override spanExporter(): SpanExporter {
		return spans;
	}

	/** The scripted models, besides the real providers: tests script OpenAI and people's own providers over `fetch`. */
	protected override models(): MutableModels {
		const models = super.models();
		models.setProvider(faux.provider);
		models.setProvider(napper.provider);
		models.setProvider(utility.provider);
		return models;
	}

	protected override defaultModel(): PiModel {
		return faux.getModel();
	}

	/** None while a test sets `test:no-fallback`, as in a deployment with no other model to run a subscription's chats on. */
	protected override fallbackModel(provider: string, session?: string): Model<Api> | undefined {
		return this.store.meta("test:no-fallback") === undefined ? super.fallbackModel(provider, session) : undefined;
	}

	/** The in-memory workspace backend coding threads have in tests, unless a test sets `test:no-coding-backend`, as in a deployment with none. */
	protected override environmentWorkspaceIds(): string[] {
		return this.store.meta("test:no-coding-backend") === undefined ? ["fake"] : [];
	}

	/** Under `auto`, long enough for a test to answer an approval, short enough to wait out. */
	protected override approvalTimeoutMs(policy = this.settings().approvalPolicy): number | null {
		return policy === "auto" ? 1_500 : null;
	}

	/** What a test sets, as a number of milliseconds, to have a run with no progress for that long stopped; the deployment's otherwise, which no test waits out. */
	protected override stallMs(): number {
		return Number(this.store.meta("test:stall-ms") ?? super.stallMs());
	}

	/** Compactions keep almost nothing, so a test can compact a short conversation. */
	protected override harnessSettings(): HarnessSettings {
		return { ...super.harnessSettings(), compaction: { keepRecentTokens: 1 } };
	}

	protected override memoryModel(): ModelRef {
		return { provider: "napper", modelId: "napper-model" };
	}

	protected override defaultUtilityModel(): Model<Api> {
		return utility.getModel();
	}

	/** The deployment's default image model, on the stand-in for Workers AI. */
	protected override imageModel(): ImageModel {
		return workersAiImageModel(imageAi, deploymentSettings(this.env).imageModel!);
	}
}

/** The coding schedulers' clock and notifier in tests (test/coding-scheduler-do.test.ts): real time and the threads' own Durable Objects until a test sets them. */
export const codingSchedulers: { now: number | null; notifier: SchedulerNotifier | null } = { now: null, notifier: null };

export class CodingSchedulerDO extends RealCodingSchedulerDO {
	protected override now(): number {
		return codingSchedulers.now ?? super.now();
	}

	/** Sign-ins run Claude Code's fake `claude auth login` (test/fake-claude-login.ts). */
	protected override async loginProviders(): Promise<WorkspaceProviderRegistry> {
		return workspaceRegistry([codingLogins]);
	}

	protected override notifier(): SchedulerNotifier {
		return codingSchedulers.notifier ?? super.notifier();
	}
}

/**
 * Coding threads' scripted model (test/coding-thread-do.test.ts), apart from
 * the space's: `coder` costs $1 per million tokens each way, and `pricey`
 * $1 per token, so one call spends any small budget.
 */
export const codingFaux = fauxProvider({
	provider: "coding-faux",
	models: [
		// A context big enough that a 256 KiB file never makes pi compact.
		{ id: "coder", contextWindow: 1_000_000, maxTokens: 64_000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
		{ id: "pricey", contextWindow: 200_000, maxTokens: 4_000, cost: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } },
	],
});

/** The workspaces harness sign-ins run in. */
export const codingLogins = loginProvider();

/** Coding threads' workspaces in tests: in memory, with a fake git (test/fake-git.ts). */
export const codingWorkspaces = new FakeWorkspaceProvider();
codingWorkspaces.register("git", fakeGit);

/**
 * The workspace backends coding threads have: the in-memory one unless a test sets others, such as the Compose provider
 * on a stubbed manager. `production` has the thread's object build them as a deployment does, from its bindings and the
 * compute providers a test sets (`codingCompute`), so a thread the admin's overflow provider runs on is placed as for real.
 */
export const codingBackends: { registry: WorkspaceProviderRegistry | null; production: boolean } = { registry: null, production: false };

/** The compute providers a test has the admin set up, as the Gallery would answer with; none unless a test sets them. */
export const codingCompute: { providers: readonly ComputeProvider[] | null } = { providers: null };

/** A stand-in for the deployment's Cloudflare Containers bindings, so threads on the overflow provider work against in-memory containers (test/fake-container.ts). */
export const codingContainers: { service: ReturnType<typeof fakeContainers> | null } = { service: null };

/**
 * The orb clients agent-hosted threads run on in tests (test/coding-orb-thread.test.ts): none until a test
 * registers a factory, as a deployment has none until a later slice adds the real one. A thread that runs in
 * the agent's cloud fails saying the agent-hosted provider isn't available without one.
 */
export const codingOrbs: { factory: OrbClientFactory | null } = { factory: null };

/** What every space may use of compute in thread tests, in place of its Pim's answer, until a test sets one (test/coding-thread-do.test.ts). */
export const codingQuota: { quota: ComputeQuota | null } = { quota: null };

/** What coding threads emitted, in order. */
export const codingEvents: CodingThreadEvent[] = [];

/**
 * Coding threads' waits in tests: a CLI turn with no output is stalled after a moment, which a test waits out; a
 * workspace that fails and doesn't answer for a second counts as down; a running turn's work is autosaved every three
 * minutes, which a test may set to 0, to autosave at each heartbeat.
 */
export const codingTimings = { stallMs: 300, lostGraceMs: 1_000, autosaveMs: 3 * 60_000, resumeWaitMs: 120_000, retryMs: 30_000, orbPollMs: 30_000 };

/** The coding threads' clock in tests: real time until a test sets it, as the stuck timeout needs (test/coding-thread-do.test.ts). */
export const codingThreadClock: { now: number | null } = { now: null };

export class CodingThreadDO extends RealCodingThreadDO {
	constructor(ctx: DurableObjectState, env: Env) {
		// With the containers stood in, the object answers as one whose Worker has the Cloudflare Containers bindings.
		super(
			ctx,
			codingContainers.service
				? ({
						...env,
						WorkspaceContainer: { getByName: codingContainers.service.containerFor },
						WorkspaceCatalog: { getByName: () => codingContainers.service!.catalog },
					} as Env)
				: env,
		);
	}

	protected override now(): number {
		return codingThreadClock.now ?? super.now();
	}

	protected override workspaceProviders(): WorkspaceProviderRegistry {
		return codingBackends.production ? super.workspaceProviders() : (codingBackends.registry ?? workspaceRegistry([codingWorkspaces]));
	}

	protected override async computeProviders(): Promise<readonly ComputeProvider[]> {
		return codingCompute.providers ?? super.computeProviders();
	}

	protected override async computeQuota(space: string): Promise<ComputeQuota> {
		return codingQuota.quota ?? super.computeQuota(space);
	}

	/** The scripted model besides the space's real providers. */
	protected override async modelProvider(space: string, providerId: string): Promise<Provider> {
		return providerId === "coding-faux" ? codingFaux.provider : super.modelProvider(space, providerId);
	}

	/** Recorded in `codingEvents`, then told as the deployment tells them. */
	protected override eventSink(): CodingEventSink {
		const sink = super.eventSink();
		return {
			emit: (event) => {
				codingEvents.push(event);
				return sink.emit(event);
			},
		};
	}

	protected override githubApp(): GitHubApp | null {
		return codingGitHub.app;
	}

	/** A CLI harness that ignores SIGINT is killed quickly. */
	protected override harnessGraceMs(): number {
		return 200;
	}

	/** A rate limited clone is tried again after a moment, not seconds. */
	protected override gitRetryDelaysMs(): readonly number[] {
		return [5, 5, 5];
	}

	protected override harnessStallMs(): number {
		return codingTimings.stallMs;
	}

	protected override workspaceLostGraceMs(): number {
		return codingTimings.lostGraceMs;
	}

	protected override autosaveMs(): number {
		return codingTimings.autosaveMs;
	}

	protected override retryDelayMs(): number {
		return codingTimings.retryMs;
	}

	/** A rate limited turn is retried after a moment too, longer each time, so tests don't wait out minutes. */
	protected override rateLimitRetryDelayMs(attempt: number, _retryAfterMs: number | null): number {
		return codingTimings.retryMs * attempt;
	}

	protected override resumeWaitMs(): number {
		return codingTimings.resumeWaitMs;
	}

	/** How often a test has an agent-hosted thread's turn looked at. */
	protected override orbPollMs(): number {
		return codingTimings.orbPollMs;
	}

	/** The orb clients a test registered, as a deployment's factory would answer with. */
	protected override orbClients(): OrbClientFactory | null {
		return codingOrbs.factory;
	}

	/** A thread waiting for another's environment looks for it often. */
	protected override environmentPollMs(): number {
		return 50;
	}

	protected override githubFetch(): Fetch | undefined {
		return codingGitHub.fetch ?? undefined;
	}

	protected override gatewayFetch(): typeof fetch {
		return codingGateway.fetch ?? (() => Promise.reject(new Error("No model provider in tests")));
	}

	protected override gatewayLimits(): GatewayLimits {
		return { ...DEFAULT_GATEWAY_LIMITS, ...codingGateway.limits };
	}
}

/** The model providers the model gateway reaches in tests, as a test answers them (none, unless set), and its caps. */
export const codingGateway: { fetch: typeof fetch | null; limits: Partial<GatewayLimits> } = { fetch: null, limits: {} };

/** The GitHub App coding threads push with in tests: none unless a test sets one, and GitHub as a test answers it. */
export const codingGitHub: { app: GitHubApp | null; fetch: Fetch | null } = { app: null, fetch: null };
