import { randomUUID } from "node:crypto";

/**
 * How a process tells a person's open apps something at once (a canvas to open, a question about it, a file that changed), and hears what an app answers. The wiring is the
 * deployment's: a process that has Pulse (the Gate, a Runner) connects it, and until then publishing is a no-op, so the services work without a bus. What the apps are told is
 * a hint, never state: see `NoticeFrame` in `@pim/v2-contracts/live-seam`.
 */
export type NoticeOut = (ownerId: string, notice: { kind: string; data?: unknown }) => void;
export type SaidIn = (handler: (ownerId: string, said: { kind: string; data?: unknown; connection: string }) => void) => () => void;

export class Notices {
	#out: NoticeOut | null = null;
	#said: SaidIn | null = null;
	#stop: (() => void) | null = null;
	readonly #asked = new Map<string, { ownerId: string; resolve: (answer: unknown) => void }>();

	/** Connects this process to the bus: where notices go, and where what apps said comes from (listened to only once something is asked). */
	connect(out: NoticeOut, said: SaidIn): void {
		this.#stop?.();
		this.#stop = null;
		this.#out = out;
		this.#said = said;
	}

	#listen(): void {
		if (this.#stop || !this.#said) return;
		this.#stop = this.#said((ownerId, heard) => {
			if (heard.kind !== "canvas_answer") return;
			const answer = heard.data as { request?: unknown } | undefined;
			const asked = typeof answer?.request === "string" ? this.#asked.get(answer.request) : undefined;
			if (asked && asked.ownerId === ownerId) asked.resolve(answer);
		});
	}

	/** Tells the owner's open apps; best effort, and never a failure of the caller. */
	publish(ownerId: string, kind: string, data?: unknown): void {
		try {
			this.#out?.(ownerId, { kind, ...(data === undefined ? {} : { data }) });
		} catch {
			// A hint that is not sent costs the app a reload.
		}
	}

	/** Asks the owner's open apps and returns the first answer, or null when none comes in `timeoutMs` (or this process has no bus). The answer is what the app said back, with the `request` it was asked under. */
	ask(ownerId: string, kind: string, data: Record<string, unknown>, timeoutMs = 5_000): Promise<unknown | null> {
		if (!this.#out) return Promise.resolve(null);
		this.#listen();
		const request = randomUUID();
		return new Promise((resolve) => {
			const done = (answer: unknown) => {
				clearTimeout(timer);
				this.#asked.delete(request);
				resolve(answer);
			};
			const timer = setTimeout(() => done(null), timeoutMs);
			this.#asked.set(request, { ownerId, resolve: done });
			this.publish(ownerId, kind, { ...data, request });
		});
	}

	close(): void {
		this.#stop?.();
		this.#stop = null;
		this.#out = null;
		this.#said = null;
		for (const { resolve } of this.#asked.values()) resolve(null);
	}
}
