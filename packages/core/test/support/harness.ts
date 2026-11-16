import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type HarnessOptions } from "@earendil-works/pi-durable";

export const ctx = BACKGROUND_CONTEXT;

/** A scripted model and a registry, shared by a test's Runners the way a deployment's configuration would be. */
export function scriptedModel() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100_000 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const options = (): HarnessOptions => ({ models, registry });
	return { faux, models, registry, options, agent: { model: { provider: "faux", modelId: "m" } } };
}

export async function until<T>(read: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 20_000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = await read();
		if (value) return value as T;
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
