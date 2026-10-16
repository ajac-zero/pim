import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import type { PiModel } from "agents/harness/pi";
import { Pim as RealPim } from "../src/pim";
import type { Mail, Mailer } from "../src/email";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { defineAppTool, defineGatedAction, definePimExtension, oauth2, type PimConfig } from "../src/extensions/define";

export { default, Auth, Directory, Gallery } from "../src/index";

/** The scripted model every test agent talks to. Tests set its responses. */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", contextWindow: 200_000 }] });

/** The scripted model that compresses memories, kept apart so naps never take the conversation's responses. */
export const napper = fauxProvider({ provider: "napper", models: [{ id: "napper-model" }] });

/** The scripted utility model (src/utility.ts). With no responses set it fails, so a session keeps its first message's start. */
export const utility = fauxProvider({ provider: "utility", models: [{ id: "utility-model" }] });

/** Every email the test agents sent, in order: tests read it as an inbox. */
export const outbox: Mail[] = [];

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
			tools: [
				defineTool({
					name: "ledger_add_bill",
					description: "Record a bill to pay.",
					parameters: Type.Object({ name: Type.String(), amount: Type.Number(), due: Type.String() }),
					async execute({ name, amount, due }) {
						data.put(`bill:${name}`, { name, amount, due, paid: false });
						return { content: [{ type: "text", text: `Recorded ${name}.` }] };
					},
				}),
			],
			sections: [section("ledger_bills", () => bills().map((bill) => `${bill.name}: ${bill.amount}${bill.paid ? " (paid)" : ""}`).join("\n") || "No bills.")],
			actions: [
				defineGatedAction({
					name: "ledger_pay_bill",
					description: "Pay a recorded bill.",
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

export class Pim extends RealPim {
	/** The deployment's extensions, and the tests' own. */
	protected override pimConfig(): PimConfig {
		const config = super.pimConfig();
		return { ...config, extensions: [...config.extensions, ledger] };
	}

	/** Email works in tests, into `outbox`. */
	protected override mailer(): Mailer {
		return { send: async (mail) => void outbox.push(mail) };
	}

	/** The scripted models, plus the real ChatGPT provider: tests script OpenAI over `fetch`. */
	protected override models(): Models {
		const models = createModels({ credentials: this.credentials });
		models.setProvider(faux.provider);
		models.setProvider(napper.provider);
		models.setProvider(utility.provider);
		models.setProvider(this.chatgpt.provider());
		return models;
	}

	protected override defaultModel(): PiModel {
		return faux.getModel();
	}

	/** Under `auto`, long enough for a test to answer an approval, short enough to wait out. */
	protected override approvalTimeoutMs(policy = this.settings().approvalPolicy): number | null {
		return policy === "explicit" ? null : 1_500;
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
}
