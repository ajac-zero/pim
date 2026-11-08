/**
 * The concrete observers for the triggers runtime (../triggers-runtime.ts):
 * `poll`, `process` and `stream`. A kind is offered only when its options are
 * given; `file` has no observer yet. A source of a kind with no adapter, or
 * not configured here, is refused when its adapter would be made, which the
 * runtime reports as `unsupported`. Configuring `stream` only makes the factory
 * able to build a `StreamAdapter`, and the runtime does that only after the
 * host's source-bound grant check passes; building one launches nothing.
 *
 * Only the triggers host (../triggers-host.ts) configures it, which
 * pim-computer loads as it starts. See docs/triggers-adapters.md.
 */

import type { AdapterFactory } from "../triggers-runtime.ts";
import { PollAdapter, type PollAdapterOptions } from "./poll.ts";
import { type ProcessAdapterOptions, ProcessWatchAdapter } from "./process.ts";
import { StreamAdapter, type StreamAdapterOptions } from "./stream.ts";

export function observerAdapters(options: { readonly poll?: PollAdapterOptions; readonly process?: ProcessAdapterOptions; readonly stream?: StreamAdapterOptions }): AdapterFactory {
	return (source) => {
		if (source.kind === "poll" && options.poll) return new PollAdapter(options.poll);
		if (source.kind === "process" && options.process) return new ProcessWatchAdapter(options.process);
		if (source.kind === "stream" && options.stream) return new StreamAdapter(options.stream);
		throw new Error("unsupported");
	};
}
