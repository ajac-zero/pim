/**
 * The concrete observers for the triggers runtime (../triggers-runtime.ts):
 * `poll` and `process`. `stream` and `file` have none yet, and a source of
 * either kind, or of a kind not configured here, is refused when its adapter
 * would be made, which the runtime reports as `unsupported`.
 *
 * Inert. Nothing imports this module: pim-computer doesn't construct a
 * runtime, and no service registers these adapters. See
 * docs/triggers-adapters.md.
 */

import type { AdapterFactory } from "../triggers-runtime.ts";
import { PollAdapter, type PollAdapterOptions } from "./poll.ts";
import { type ProcessAdapterOptions, ProcessWatchAdapter } from "./process.ts";

export function observerAdapters(options: { readonly poll?: PollAdapterOptions; readonly process?: ProcessAdapterOptions }): AdapterFactory {
	return (source) => {
		if (source.kind === "poll" && options.poll) return new PollAdapter(options.poll);
		if (source.kind === "process" && options.process) return new ProcessWatchAdapter(options.process);
		throw new Error("unsupported");
	};
}
