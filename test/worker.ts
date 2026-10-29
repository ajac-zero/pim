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

export { default, Auth, Directory, Gallery } from "../src/index";

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
 * A deployment's own extension, as tests install it: a blueprint with a dashboard
 * mixing its own widgets with Pim's, one of which always fails, and an
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
	blueprints: [
		{
			id: "budget",
			name: "Budget",
			description: "Keeps the books.",
			instructions: "Answer every money question with a number first.",
			dashboard: ["test.ledger/bills", "test.ledger/broken", "pim.goals/active"],
			apps: ["test.ledger/weather"],
			starters: [{ en: "How much did I spend?", es: "¿Cuánto gasté?" }],
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

/** The spaces, by owner, whose agents get the desktop's tools in tests (`nativeDesktop`); no deployment's or preview's do. */
export const desktopSpaces = new Set<string>();

export class Pim extends RealPim {
	/** The deployment's extensions, and the tests' own. */
	protected override pimConfig(): PimConfig {
		const config = super.pimConfig();
		return { ...config, extensions: [...config.extensions, ledger, google] };
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

	/** Under `auto`, long enough for a test to answer an approval, short enough to wait out. */
	protected override approvalTimeoutMs(policy = this.settings().approvalPolicy): number | null {
		return policy === "auto" ? 1_500 : null;
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

	/** The desktop's tools, with Pim's real run authority, only in a space a test named in `desktopSpaces`. */
	protected override nativeDesktop(): boolean {
		return desktopSpaces.has(this.name);
	}

	/** The deployment's default image model, on the stand-in for Workers AI. */
	protected override imageModel(): ImageModel {
		return workersAiImageModel(imageAi, deploymentSettings(this.env).imageModel!);
	}
}

/**
 * The preview's own Pim and Directory (preview/worker.ts), bound as `PREVIEW_PIM` and `PREVIEW_DIRECTORY` in the test
 * configurations only, for the preview's Cua fixture's and evaluation mode's tests.
 */
export { Directory as PreviewDirectory, Pim as PreviewPim } from "../preview/worker";
