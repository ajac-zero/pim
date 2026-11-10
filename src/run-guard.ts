import { awaitWithContext } from "@earendil-works/chord/context";
import type { Registry, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Makes every tool stoppable. pi-durable cancels a call's context when its
 * chat is stopped, and then waits for the call to return; a tool that
 * ignores the cancellation, such as one waiting on a Durable Object that
 * never answers, would hold the run, its queue and the Stop itself for good.
 * With the wait cut short by the cancellation, the call ends at once, and
 * whatever the tool was waiting for is left to finish or fail unheard.
 */
export function stoppable<R extends Registry>(registry: R): R {
	const guard = (tool: ToolRegistration): ToolRegistration => ({
		...tool,
		execute: (args, api, context) => {
			const called = Promise.resolve(tool.execute(args, api, context));
			// Called directly, as a test does, a tool has no run to be stopped with.
			return context ? awaitWithContext(called, context) : called;
		},
	});
	return new Proxy(registry, {
		get(target, property) {
			if (property === "install") {
				return (extension: Parameters<Registry["install"]>[0]) => target.install(extension.tools ? { ...extension, tools: extension.tools.map(guard) } : extension);
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** How long runs have gone without progress: a fingerprint of each run's live state, and since when it has been the same. */
export class Stalls {
	readonly #seen = new Map<string, { fingerprint: string; since: number }>();

	/** Notes a run's state at `now`, and says for how long it has been the same. A run that changed starts over. */
	observe(key: string, fingerprint: string, now: number): number {
		const seen = this.#seen.get(key);
		if (seen?.fingerprint === fingerprint) return now - seen.since;
		this.#seen.set(key, { fingerprint, since: now });
		return 0;
	}

	/** Forgets every run not in `keys`: it ended, or waits for the person, which is no stall. */
	keepOnly(keys: ReadonlySet<string>): void {
		for (const key of this.#seen.keys()) if (!keys.has(key)) this.#seen.delete(key);
	}
}
