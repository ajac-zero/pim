import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import type { PiModel } from "agents/harness/pi";
import { Pim as RealPim } from "../src/agent";
import type { Mail, Mailer } from "../src/email";

export { default, Auth, Directory, Gallery } from "../src/index";

/** The scripted model every test agent talks to. Tests set its responses. */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", contextWindow: 200_000 }] });

/** The scripted model that compresses memories, kept apart so naps never take the conversation's responses. */
export const napper = fauxProvider({ provider: "napper", models: [{ id: "napper-model" }] });

/** Every email the test agents sent, in order: tests read it as an inbox. */
export const outbox: Mail[] = [];

export class Pim extends RealPim {
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
