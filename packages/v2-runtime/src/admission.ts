import type { AssistantMessageEventStream, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export type AdmissionOptions = {
	/** Model calls in flight across every owner of this Runner. */
	readonly globalLimit: number;
	/** The most one owner may hold at once, so a owner waiting on slow or rate-limited streams cannot take every slot. */
	readonly perOwnerLimit: number;
	/** The most one provider may hold at once across owners; unset for no provider cap. */
	readonly perProviderLimit?: number;
};

export type Permit = { release(): void };

type Waiter = { ownerId: string; providerId: string; grant: (permit: Permit) => void; cancel: () => void };

/**
 * Admission for model calls. A call waits for a slot; slots are handed to owners in turn, so a owner with a deep
 * queue does not starve the others, and no owner or provider holds more than its cap. A permit is held for the life of
 * the call (a stream until it ends), then released.
 */
export class ModelAdmission {
	readonly #options: AdmissionOptions;
	readonly #queues = new Map<string, Waiter[]>();
	#order: string[] = [];
	readonly #byOwner = new Map<string, number>();
	readonly #byProvider = new Map<string, number>();
	#inFlight = 0;

	constructor(options: AdmissionOptions) {
		this.#options = options;
	}

	get inFlight(): number {
		return this.#inFlight;
	}
	inFlightFor(ownerId: string): number {
		return this.#byOwner.get(ownerId) ?? 0;
	}
	get waiting(): number {
		let n = 0;
		for (const queue of this.#queues.values()) n += queue.length;
		return n;
	}

	/** Wait for a permit. Resolves `undefined` when `signal` aborts first: the caller then proceeds without one and lets the provider report the abort. */
	acquire(ownerId: string, providerId: string, signal?: AbortSignal): Promise<Permit | undefined> {
		if (signal?.aborted) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const waiter: Waiter = {
				ownerId,
				providerId,
				grant: (permit) => {
					signal?.removeEventListener("abort", waiter.cancel);
					resolve(permit);
				},
				cancel: () => {
					const queue = this.#queues.get(ownerId);
					const index = queue?.indexOf(waiter) ?? -1;
					if (queue !== undefined && index >= 0) queue.splice(index, 1);
					resolve(undefined);
				},
			};
			signal?.addEventListener("abort", waiter.cancel, { once: true });
			let queue = this.#queues.get(ownerId);
			if (queue === undefined) {
				queue = [];
				this.#queues.set(ownerId, queue);
				this.#order.push(ownerId);
			}
			queue.push(waiter);
			this.#dispatch();
		});
	}

	#canStart(ownerId: string, providerId: string): boolean {
		if (this.#inFlight >= this.#options.globalLimit) return false;
		if ((this.#byOwner.get(ownerId) ?? 0) >= this.#options.perOwnerLimit) return false;
		const cap = this.#options.perProviderLimit;
		return cap === undefined || (this.#byProvider.get(providerId) ?? 0) < cap;
	}

	#dispatch(): void {
		let progressed = true;
		while (progressed && this.#inFlight < this.#options.globalLimit) {
			progressed = false;
			// One round over the owners with waiters, each taking at most one slot, starting after the last owner served.
			const order = this.#order;
			for (let i = 0; i < order.length && this.#inFlight < this.#options.globalLimit; i++) {
				const ownerId = order[i] as string;
				const queue = this.#queues.get(ownerId);
				const head = queue?.[0];
				if (queue === undefined || head === undefined || !this.#canStart(ownerId, head.providerId)) continue;
				queue.shift();
				this.#start(head);
				// The served owner goes to the back of the line.
				this.#order = [...order.slice(i + 1), ...order.slice(0, i + 1)];
				progressed = true;
				break;
			}
		}
		for (const [ownerId, queue] of this.#queues) {
			if (queue.length === 0) {
				this.#queues.delete(ownerId);
				this.#order = this.#order.filter((id) => id !== ownerId);
			}
		}
	}

	#start(waiter: Waiter): void {
		this.#inFlight++;
		this.#byOwner.set(waiter.ownerId, (this.#byOwner.get(waiter.ownerId) ?? 0) + 1);
		this.#byProvider.set(waiter.providerId, (this.#byProvider.get(waiter.providerId) ?? 0) + 1);
		let released = false;
		waiter.grant({
			release: () => {
				if (released) return;
				released = true;
				this.#inFlight--;
				this.#byOwner.set(waiter.ownerId, (this.#byOwner.get(waiter.ownerId) ?? 1) - 1);
				this.#byProvider.set(waiter.providerId, (this.#byProvider.get(waiter.providerId) ?? 1) - 1);
				this.#dispatch();
			},
		});
	}
}

const STREAMS = new Set(["stream", "streamSimple", "streamDeferred"]);
const CALLS = new Set(["complete", "completeSimple", "fetchDeferred"]);

/**
 * `models` with every call going through `admission` for one owner, and every call aborted when `signal` does: a
 * Runner whose lease was lost cuts its in-flight model streams. Streams are re-emitted from the provider's own stream
 * once a permit is held; the permit is released when the stream ends.
 */
export function admitModels<M extends Models>(models: M, options: { admission: ModelAdmission; ownerId: string; signal: AbortSignal }): M {
	const { admission, ownerId, signal } = options;
	const withSignal = (callOptions: { signal?: AbortSignal } | undefined): { signal: AbortSignal } & Record<string, unknown> => ({
		...(callOptions ?? {}),
		signal: callOptions?.signal === undefined ? signal : AbortSignal.any([callOptions.signal, signal]),
	});
	return new Proxy(models, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== "function") return value;
			const call = (value as (...args: unknown[]) => unknown).bind(target);
			if (typeof property !== "string") return call;
			if (STREAMS.has(property)) {
				return (model: { provider: string }, second: unknown, callOptions?: { signal?: AbortSignal }): AssistantMessageEventStream => {
					const merged = withSignal(callOptions);
					const outer = createAssistantMessageEventStream();
					void (async () => {
						const permit = await admission.acquire(ownerId, model.provider, merged.signal);
						try {
							const inner = call(model, second, merged) as AssistantMessageEventStream;
							for await (const event of inner) outer.push(event);
							outer.end(await inner.result());
						} catch (error) {
							outer.end({ role: "assistant", content: [], stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) } as never);
						} finally {
							permit?.release();
						}
					})();
					return outer;
				};
			}
			if (CALLS.has(property)) {
				return async (model: { provider: string }, second: unknown, callOptions?: { signal?: AbortSignal }): Promise<unknown> => {
					const merged = withSignal(callOptions);
					const permit = await admission.acquire(ownerId, model.provider, merged.signal);
					try {
						return await call(model, second, merged);
					} finally {
						permit?.release();
					}
				};
			}
			return call;
		},
	});
}
