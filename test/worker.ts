import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import type { PiModel } from "agents/harness/pi";
import { Pim as RealPim } from "../src/agent";

export { default } from "../src/index";
export { Auth } from "../src/auth";

/** The scripted model every test agent talks to. Tests set its responses. */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", contextWindow: 200_000 }] });

/** The scripted model that compresses memories, kept apart so naps never take the conversation's responses. */
export const napper = fauxProvider({ provider: "napper", models: [{ id: "napper-model" }] });

export class Pim extends RealPim {
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

	/** Long enough for a test to answer an approval, short enough to wait out. */
	protected override approvalTimeoutMs(): number {
		return 1_500;
	}

	/** Compactions keep almost nothing, so a test can compact a short conversation. */
	protected override harnessSettings(): HarnessSettings {
		return { ...super.harnessSettings(), compaction: { keepRecentTokens: 1 } };
	}

	protected override memoryModel(): ModelRef {
		return { provider: "napper", modelId: "napper-model" };
	}
}
