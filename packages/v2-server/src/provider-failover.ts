/**
 * Provider cooldowns and failover for the Runner's model calls. When a request fails before it has produced any output (rate limit, overload, a 5xx, a refused credential,
 * a dropped connection), that provider and model are put on a short cooldown and the same request is made to the next model of the chat's list (the agent's own model and
 * fallbacks, then the owner's, then `PIM_DEFAULT_MODEL`). Events are held back until the first content, so nothing of a failed attempt reaches the transcript, and once
 * content has been shown the attempt is final: a stream that fails midway is never retried, which would duplicate committed output or tool calls. A model on cooldown is
 * skipped by the next requests while another candidate is available.
 *
 * A stream that goes silent before it has shown anything (the idle limit, `DEFAULT_STREAM_STALL_MS`) is asked again once on the same model, after a short pause, before the request falls
 * to the next one: a stall is often one dropped connection. Quota, a refused credential and a request the provider calls invalid never get that second try. The worst case before a
 * fallback answers is then two idle limits and the pause, a little over four minutes. A fallback that answers is kept for the rest of the turn (`turnOf`), so a turn does not bounce
 * between the agent's model and its fallback; the next message of the person starts on the agent's own model again.
 */
import { type Models, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isDeliveryReminder } from "@pim/shared/transcript";
import { isUsageLimitError, limitCooldown, type LimitState } from "./usage-limits.ts";
import { type CallDetail, type FailedAttempt, keepCall, SLOW_CALL_MS, trackAttempt } from "./call-details.ts";

export type ModelRef = { provider: string; id: string };

const TRANSIENT = /\b(429|500|502|503|504|529)\b|rate.?limit|too many requests|overloaded|capacity|temporarily unavailable|service unavailable|server error|bad gateway|gateway time|timed? ?out|econnreset|econnrefused|fetch failed|socket hang up/i;
const AUTH = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api.?key|token)|authentication|no api key|credential|permission/i;

/** How long a model is skipped after it failed: short for load, longer for a credential that was refused. */
export type Cooldowns = { transientMs: number; authMs: number };
export const DEFAULT_COOLDOWNS: Cooldowns = { transientMs: 30_000, authMs: 120_000 };

export function failureKind(message: AssistantMessage): "transient" | "auth" | null {
	if (message.stopReason !== "error" || !message.errorMessage || isContextOverflow(message)) return null;
	// A plan that says its usage is used up is as unavailable as one that is overloaded: the request goes to the next model.
	if (TRANSIENT.test(message.errorMessage) || isUsageLimitError(message.errorMessage)) return "transient";
	return AUTH.test(message.errorMessage) ? "auth" : null;
}

const refKey = (ownerId: string, provider: string, id: string) => `${ownerId}\u0000${provider}/${id}`;

/** How long a model stream may stay silent, before its first event or between two, before the request is cut off as stalled. */
export const DEFAULT_STREAM_STALL_MS = 120_000;

/** How long a stalled model rests before the one second try on the same model. */
export const DEFAULT_STALL_RETRY_MS = 2_000;
/** What the events say when a stall is tried again, so an admin reading diagnostics finds it by its words. */
export const STALL_RETRY_NOTE = "model stalled; retrying once";

/** Turns that have a fallback kept, at most; the oldest is forgotten first. */
const STICKY_KEPT = 1_000;

/**
 * The turn a model request belongs to: from the last message a person (or a trigger, a task or a room) put in front of the agent to the answer that ends it, which every request of the
 * run shares, its tool rounds and the harness's own retries included. Delivery reminders are the harness's, not a new message. Named by how many such messages the context holds and
 * when the last was written, so a new message, a compaction and a conversation carried on elsewhere are each another turn; a held run asked again is the same one.
 */
export function turnOf(context: { messages?: readonly any[] } | undefined): string | undefined {
	let count = 0;
	let at: unknown;
	for (const m of context?.messages ?? []) {
		if (m?.role !== "user") continue;
		const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((part: any) => (part?.type === "text" ? part.text : "")).join("") : "";
		if (isDeliveryReminder(text)) continue;
		count++;
		at = m.timestamp;
	}
	return count === 0 ? undefined : `${count}:${String(at)}`;
}

const UNSHOWN = new Set(["start", "thinking_start", "thinking_delta", "thinking_end"]);

export const failureMessage = (model: any, text: string, stopReason: "error" | "aborted", at: number): AssistantMessage =>
	({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, errorMessage: text, timestamp: at }) as AssistantMessage;

/** Where cooldowns are shared between Runners: an owner's models that are cooling, as `refKey` to the time (ms) they end, and one more recorded. */
export type CooldownStore = {
	load(ownerId: string): Promise<Map<string, number>>;
	save(ownerId: string, provider: string, id: string, untilMs: number, reason: string): Promise<void>;
};

export function createFailover(options: { now?: (() => number) | undefined; cooldowns?: Partial<Cooldowns> | undefined; stallMs?: number | undefined; /** The pause before a stalled model is asked once more. */ stallRetryMs?: number | undefined; store?: CooldownStore | undefined; syncMs?: number | undefined; subscription?: ((ownerId: string, provider: string) => boolean) | undefined; /** Told what happened to a request that an admin reading diagnostics would want to find: a model that failed over, a cooldown, a request that failed for good or was slow. Never throws into the request. */ event?: ((ownerId: string, kind: string, detail: Record<string, unknown>) => void) | undefined } = {}) {
	const stallMs = options.stallMs ?? DEFAULT_STREAM_STALL_MS;
	const stallRetryMs = options.stallRetryMs ?? DEFAULT_STALL_RETRY_MS;
	/** The model that answered in place of the requested one, for the rest of the turn it was found in, by the provider's session of the conversation. */
	const sticky = new Map<string, { turn: string; model: string }>();
	const now = options.now ?? Date.now;
	const cooldowns = { ...DEFAULT_COOLDOWNS, ...options.cooldowns };
	const until = new Map<string, number>();
	const chains = new Map<string, ModelRef[]>();
	const cooling = (ownerId: string, m: ModelRef) => (until.get(refKey(ownerId, m.provider, m.id)) ?? 0) > now();
	/** Another Runner's cooldowns are read at most this often per owner; this Runner's own are in memory at once. */
	const syncedAt = new Map<string, number>();
	const sync = async (ownerId: string) => {
		if (!options.store || now() - (syncedAt.get(ownerId) ?? -Infinity) < (options.syncMs ?? 2_000)) return;
		syncedAt.set(ownerId, now());
		for (const [key, end] of await options.store.load(ownerId).catch(() => new Map<string, number>())) if (end > (until.get(`${ownerId}\u0000${key}`) ?? 0)) until.set(`${ownerId}\u0000${key}`, end);
	};
	const tell = (ownerId: string, kind: string, detail: Record<string, unknown>) => {
		try {
			options.event?.(ownerId, kind, detail);
		} catch {
			// A log must not break what it describes.
		}
	};
	/** What a subscription's usage limits in a row did to each model's cooldown, to make the next one longer. */
	const limits = new Map<string, LimitState>();
	const cool = (ownerId: string, m: ModelRef, ms: number, reason: string) => {
		const end = now() + ms;
		tell(ownerId, "provider_cooldown", { provider: m.provider, model: m.id, until: new Date(end).toISOString(), reason: reason.slice(0, 300) });
		until.set(refKey(ownerId, m.provider, m.id), end);
		void options.store?.save(ownerId, m.provider, m.id, end, reason).catch(() => {});
	};

	/**
	 * How long a failed model is skipped. A subscription's usage limit (the ChatGPT plan) is left until it resets, when the error says when, or for a backoff that grows with each limit in a
	 * row, as in v1; anything else for the short cooldowns of a transient or refused request.
	 */
	const coolFor = (ownerId: string, m: ModelRef, message: AssistantMessage, kind: "transient" | "auth") => {
		if (kind === "transient" && options.subscription?.(ownerId, m.provider) && isUsageLimitError(message.errorMessage)) {
			const key = refKey(ownerId, m.provider, m.id);
			const next = limitCooldown(limits.get(key), message.errorMessage, now());
			limits.set(key, next);
			cool(ownerId, m, next.until - now(), message.errorMessage ?? "");
			return;
		}
		cool(ownerId, m, kind === "auth" ? cooldowns.authMs : cooldowns.transientMs, message.errorMessage ?? "");
	};

	return {
		/** Records the models a chat falls over to, in order, when `primary` is the one it runs. */
		setChain(ownerId: string, primary: ModelRef, chain: ModelRef[]) {
			chains.set(refKey(ownerId, primary.provider, primary.id), chain);
		},
		isCooling: cooling,
		/** When the last of a provider's models stops cooling (ms), or undefined when none is. */
		providerCooldownEnd(ownerId: string, provider: string): number | undefined {
			const prefix = `${ownerId}\u0000${provider}/`;
			const ends = [...until].filter(([key, end]) => key.startsWith(prefix) && end > now()).map(([, end]) => end);
			return ends.length > 0 ? Math.max(...ends) : undefined;
		},
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

	/** The request ended with `message`: what was seen of it is left for the ledger, and a failure or a slow one is told. */
	function finished(ownerId: string, message: AssistantMessage, detail: CallDetail, failures: FailedAttempt[]) {
		keepCall(ownerId, message, { ...detail, failures });
		if (message.stopReason === "error") tell(ownerId, "model_call_failed", { provider: message.provider, model: message.model, latencyMs: detail.latencyMs, error: detail.error ?? "", tryingNext: false });
		else if (detail.latencyMs >= SLOW_CALL_MS) tell(ownerId, "slow_model_call", { provider: message.provider, model: message.model, latencyMs: detail.latencyMs });
	}

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
		await sync(ownerId);
		let list = await candidates(models, ownerId, model);
		const requested = `${model.provider}/${model.id}`;
		const turn = turnOf(rest[0]);
		const sessionId = (rest[1] as { sessionId?: string } | undefined)?.sessionId;
		const stuckKey = turn !== undefined && sessionId ? `${ownerId}\u0000${sessionId}` : undefined;
		const stuck = stuckKey === undefined ? undefined : sticky.get(stuckKey);
		// What answered for this turn already goes first, unless it is cooling (another request of the owner found it down) or is not one of this request's models.
		if (stuck && stuck.turn === turn) {
			const found = list.find((m) => `${m.provider}/${m.id}` === stuck.model && !cooling(ownerId, m));
			if (found) list = [found, ...list.filter((m) => m !== found)];
			else sticky.delete(stuckKey!);
		}
		/** After a request is answered: a fallback that answered is kept for the turn, the requested model answering ends that. A model that fails for good is not kept. */
		const settle = (current: any, answered: boolean) => {
			if (stuckKey === undefined) return;
			const name = `${current.provider}/${current.id}`;
			const kept = sticky.get(stuckKey)?.model;
			if (!answered) {
				if (kept === name) sticky.delete(stuckKey);
				return;
			}
			sticky.delete(stuckKey);
			if (name === requested) return;
			if (kept !== name) tell(ownerId, "failover", { provider: current.provider, model: current.id, from: requested, until: "the next message" });
			sticky.set(stuckKey, { turn: turn!, model: name });
			if (sticky.size > STICKY_KEPT) sticky.delete(sticky.keys().next().value as string);
		};
		/** Whether this candidate was already asked again after a stall. */
		let askedAgain = false;
		/** The attempts that failed and went on to the next model, which the request's own record then carries. */
		const failures: FailedAttempt[] = [];
		for (let i = 0; i < list.length; i++) {
			const current = list[i];
			const again = askedAgain;
			askedAgain = false;
			const last = i === list.length - 1 || signal?.aborted === true;
			const held: AssistantMessageEvent[] = [];
			let shown = false;
			let failed: AssistantMessage | undefined;
			// The request is cut off when the caller stops it or the stream goes silent, even if the provider's own client ignores the signal: a hung stream must not hold a chat busy.
			const inner = new AbortController();
			const forward = () => inner.abort(signal?.reason);
			if (signal?.aborted) forward();
			else signal?.addEventListener("abort", forward, { once: true });
			const attempt = trackAttempt(current, rest[0], rest[1], now);
			const events = call(current, rest[0], { ...attempt.options, signal: inner.signal }, ...rest.slice(2));
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
				// A fallback is kept before the caller sees the answer end, so the request that follows it already finds it.
				if (event.type === "done") settle(current, true);
				if (shown) {
					out.push(event);
					continue;
				}
				if (event.type === "error" && !last && failureKind(event.error)) {
					failed = event.error;
					break;
				}
				held.push(event);
				// What is shown stays final, so nothing before the first answer or tool call counts: the model's thinking is held too, and a request that fails during it goes to the next model.
				if (!UNSHOWN.has(event.type)) {
					shown = true;
					for (const e of held) out.push(e);
				}
			}
			signal?.removeEventListener("abort", forward);
			// A silent stream that has shown nothing is asked once more on the same model, after a pause the person's stop cuts short. The second stall, or any other failure, is as before.
			if (stalled && !shown && !again && stalled.stopReason === "error" && !signal?.aborted) {
				const detail = attempt.finish(stalled);
				failures.push({ provider: current.provider, model: current.id, detail });
				tell(ownerId, "model_call_failed", { provider: current.provider, model: current.id, latencyMs: detail.latencyMs, error: detail.error ?? "", tryingNext: false, retrying: true, note: STALL_RETRY_NOTE });
				if (await pause(stallRetryMs, signal)) {
					failures.pop();
					const aborted = failureMessage(current, "Request was aborted", "aborted", now());
					finished(ownerId, aborted, { ...detail, stopReason: "aborted", error: "Request was aborted" }, failures);
					out.push({ type: "error", reason: "aborted", error: aborted } as AssistantMessageEvent);
					return;
				}
				askedAgain = true;
				i--;
				continue;
			}
			if (stalled && !shown && !last && stalled.stopReason === "error") failed = stalled;
			if (stalled && !failed) {
				// Nothing more can be retried: content was shown, or the caller stopped the request. The chat ends with the error, not with a stream that never finishes.
				if (!shown) for (const e of held) out.push(e);
				settle(current, false);
				finished(ownerId, stalled, attempt.finish(stalled), failures);
				out.push({ type: "error", reason: stalled.stopReason as "error" | "aborted", error: stalled } as AssistantMessageEvent);
				return;
			}
			if (failed) {
				const detail = attempt.finish(failed);
				failures.push({ provider: current.provider, model: current.id, detail });
				tell(ownerId, "model_call_failed", { provider: current.provider, model: current.id, latencyMs: detail.latencyMs, error: detail.error ?? "", tryingNext: true, ...(failed === stalled ? { note: "model stalled twice; falling back" } : {}) });
				settle(current, false);
				coolFor(ownerId, current, failed, failureKind(failed) === "auth" ? "auth" : "transient");
				continue;
			}
			if (!shown) for (const e of held) out.push(e);
			// A final failure of a model that was already tried still cools it for the next request.
			const message = await events.result();
			const kind = failureKind(message);
			if (kind && !shown) coolFor(ownerId, current, message, kind);
			finished(ownerId, message, attempt.finish(message), failures);
			if (message.stopReason === "error" || message.stopReason === "aborted") settle(current, false);
			out.end(message);
			return;
		}
	}
}

/** Waits `ms`; true when `signal` stopped it first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(true);
	return new Promise((resolve) => {
		const done = (stopped: boolean) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			resolve(stopped);
		};
		const stop = () => done(true);
		const timer = setTimeout(() => done(false), ms);
		signal?.addEventListener("abort", stop, { once: true });
	});
}
