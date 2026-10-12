import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import type { PiModel } from "agents/harness/pi";
import { Pim as RealPim } from "../src/agent";
import type { Mail, Mailer } from "../src/email";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { defineGatedAction, definePimExtension, type PimConfig } from "../src/extensions/define";

export { default, Auth, Directory, Gallery } from "../src/index";

/** The scripted model every test agent talks to. Tests set its responses. */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", contextWindow: 200_000 }] });

/** The scripted model that compresses memories, kept apart so naps never take the conversation's responses. */
export const napper = fauxProvider({ provider: "napper", models: [{ id: "napper-model" }] });

/** Every email the test agents sent, in order: tests read it as an inbox. */
export const outbox: Mail[] = [];

type Bill = { name: string; amount: number; due: string; paid: boolean };

/**
 * A deployment's own extension, as tests install it: a Pim with a dashboard
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
	pims: [
		{
			id: "budget",
			name: "Budget",
			description: "Keeps the books.",
			instructions: "Answer every money question with a number first.",
			dashboard: ["test.ledger/bills", "test.ledger/broken", "pim.goals/active"],
			apps: [{ name: "Weather", url: "https://weather.example.test/mcp" }],
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
}
