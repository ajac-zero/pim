import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { PiModel } from "agents/harness/pi";
import { Pim as RealPim } from "../src/agent";

export { default } from "../src/index";

/** The scripted model every test agent talks to. Tests set its responses. */
export const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", contextWindow: 200_000 }] });

export class Pim extends RealPim {
	protected override models(): Models {
		const models = createModels();
		models.setProvider(faux.provider);
		return models;
	}

	protected override defaultModel(): PiModel {
		return faux.getModel();
	}
}
