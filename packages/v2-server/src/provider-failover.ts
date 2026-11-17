/**
 * Provider cooldowns and failover for the Runner's model calls. When a request fails before it has produced any output (rate limit, overload, a 5xx, a refused credential,
 * a dropped connection), that provider and model are put on a short cooldown and the same request is made to the next model of the chat's list (the agent's own model and
 * fallbacks, then the owner's, then `PIM_DEFAULT_MODEL`). Events are held back until the first content, so nothing of a failed attempt reaches the transcript, and once
 * content has been shown the attempt is final: a stream that fails midway is never retried, which would duplicate committed output or tool calls. A model on cooldown is
 * skipped by the next requests while another candidate is available.
 */
import { type Models, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";

export type ModelRef = { provider: string; id: string };

const TRANSIENT = /\b(429|500|502|503|504|529)\b|rate.?limit|too many requests|overloaded|capacity|temporarily unavailable|service unavailable|server error|bad gateway|gateway time|timed? ?out|econnreset|econnrefused|fetch failed|socket hang up/i;
const AUTH = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api.?key|token)|authentication|no api key|credential|permission/i;

/** How long a model is skipped after it failed: short for load, longer for a credential that was refused. */
export type Cooldowns = { transientMs: number; authMs: number };
export const DEFAULT_COOLDOWNS: Cooldowns = { transientMs: 30_000, authMs: 120_000 };

export function failureKind(message: AssistantMessage): "transient" | "auth" | null {
	if (message.stopReason !== "error" || !message.errorMessage || isContextOverflow(message)) return null;
	if (TRANSIENT.test(message.errorMessage)) return "transient";
	return AUTH.test(message.errorMessage) ? "auth" : null;
}

const refKey = (ownerId: string, provider: string, id: string) => `${ownerId}\u0000${provider}/${id}`;

/** How long a model stream may stay silent, before its first event or between two, before the request is cut off as stalled. */
export const DEFAULT_STREAM_STALL_MS = 120_000;

const failureMessage = (model: any, text: string, stopReason: "error" | "aborted", at: number): AssistantMessage =>
	({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, errorMessage: text, timestamp: at }) as AssistantMessage;

export function createFailover(options: { now?: (() => number) | undefined; cooldowns?: Partial<Cooldowns> | undefined; stallMs?: number | undefined } = {}) {
	const stallMs = options.stallMs ?? DEFAULT_STREAM_STALL_MS;
	const now = options.now ?? Date.now;
	const cooldowns = { ...DEFAULT_COOLDOWNS, ...options.cooldowns };
	const until = new Map<string, number>();
	const chains = new Map<string, ModelRef[]>();
	const cooling = (ownerId: string, m: ModelRef) => (until.get(refKey(ownerId, m.provider, m.id)) ?? 0) > now();

	return {
		/** Records the models a chat falls over to, in order, when `primary` is the one it runs. */
		setChain(ownerId: string, primary: ModelRef, chain: ModelRef[]) {
			chains.set(refKey(ownerId, primary.provider, primary.id), chain);
		},
		isCooling: cooling,
		wrap(models: Models, ownerId: string): Models {
			return new Proxy(models, {
				get(target, property, receiver) {
					const value = Reflect.get(target, property, receiver) as unknown;
					if (typeof value !== "function") return value;
					const call = (value as (...args: unknown[]) => unknown).bind(target);
					if (property !== "stream" && property !== "streamSimple") return call;
					return (model: any, ...rest: any[]) => {
						const out = createAssistantMessageEventStream();
						void run(target, ownerId, model, rest, call as never, out).catch((error) => {
							const message = failureMessage(model, error instanceof Error ? error.message : String(error), "error", now());
							out.push({ type: "error", reason: "error", error: message } as AssistantMessageEvent);
						});
						return out;
					};
				},
			});
		},
	};

	async function candidates(models: Models, ownerId: string, model: any): Promise<any[]> {
		const seen = new Set<string>([`${model.provider}/${model.id}`]);
		const list: any[] = [model];
		for (const ref of chains.get(refKey(ownerId, model.provider, model.id)) ?? []) {
			if (seen.has(`${ref.provider}/${ref.id}`)) continue;
			seen.add(`${ref.provider}/${ref.id}`);
			const found = models.getModel(ref.provider, ref.id);
			if (found && (await models.getAuth(found).catch(() => undefined))) list.push(found);
		}
		// Models that are cooling go last, so they are tried only when nothing else is left.
		return [...list.filter((m) => !cooling(ownerId, m)), ...list.filter((m) => cooling(ownerId, m))];
	}

	async function run(models: Models, ownerId: string, model: any, rest: any[], call: (model: unknown, ...rest: unknown[]) => AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }, out: ReturnType<typeof createAssistantMessageEventStream>): Promise<void> {
		const signal = (rest[1] as { signal?: AbortSignal } | undefined)?.signal;
		const list = await candidates(models, ownerId, model);
		for (let i = 0; i < list.length; i++) {
			const current = list[i];
			const last = i === list.length - 1 || signal?.aborted === true;
			const held: AssistantMessageEvent[] = [];
			let shown = false;
			let failed: AssistantMessage | undefined;
			// The request is cut off when the caller stops it or the stream goes silent, even if the provider's own client ignores the signal: a hung stream must not hold a chat busy.
			const inner = new AbortController();
			const forward = () => inner.abort(signal?.reason);
			if (signal?.aborted) forward();
			else signal?.addEventListener("abort", forward, { once: true });
			const events = call(current, rest[0], { ...(rest[1] as object | undefined), signal: inner.signal }, ...rest.slice(2));
			const iterator = events[Symbol.asyncIterator]();
			let stalled: AssistantMessage | undefined;
			for (;;) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const cut = new Promise<"stalled" | "aborted">((resolve) => {
					timer = setTimeout(() => resolve("stalled"), stallMs);
					inner.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
				});
				const next = await Promise.race([iterator.next(), cut]).finally(() => clearTimeout(timer));
				if (next === "stalled" || next === "aborted") {
					inner.abort(next === "stalled" ? new Error("The model stopped responding") : signal?.reason);
					stalled = next === "stalled" ? failureMessage(current, `The model timed out: it sent nothing for ${Math.round(stallMs / 1000)} seconds`, "error", now()) : failureMessage(current, "Request was aborted", "aborted", now());
					break;
				}
				if (next.done) break;
				const event = next.value;
				if (shown) {
					out.push(event);
					continue;
				}
				if (event.type === "error" && !last && failureKind(event.error)) {
					failed = event.error;
					break;
				}
				held.push(event);
				if (event.type !== "start") {
					shown = true;
					for (const e of held) out.push(e);
				}
			}
			signal?.removeEventListener("abort", forward);
			if (stalled && !shown && !last && stalled.stopReason === "error") failed = stalled;
			if (stalled && !failed) {
				// Nothing more can be retried: content was shown, or the caller stopped the request. The chat ends with the error, not with a stream that never finishes.
				if (!shown) for (const e of held) out.push(e);
				out.push({ type: "error", reason: stalled.stopReason as "error" | "aborted", error: stalled } as AssistantMessageEvent);
				return;
			}
			if (failed) {
				until.set(refKey(ownerId, current.provider, current.id), now() + (failureKind(failed) === "auth" ? cooldowns.authMs : cooldowns.transientMs));
				continue;
			}
			if (!shown) for (const e of held) out.push(e);
			// A final failure of a model that was already tried still cools it for the next request.
			const message = await events.result();
			const kind = failureKind(message);
			if (kind && !shown) until.set(refKey(ownerId, current.provider, current.id), now() + (kind === "auth" ? cooldowns.authMs : cooldowns.transientMs));
			out.end(message);
			return;
		}
	}
}
