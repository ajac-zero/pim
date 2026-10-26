/**
 * One Cua viewer launch's absolute lifetime (docs/cua-viewer-lifetime.md).
 * A launch is given its lifetime once, when it starts, and from then on is
 * live only until that much monotonic time has passed. Nothing can renew
 * it: there is no method that moves its deadline, a reconnect adopts its
 * transports into the same launch, and neither the browser's `expiresAt`
 * nor an upstream ticket's expiry is read. Cua's `/media` checks its ticket
 * only at the upgrade, so a connection it accepted outlives the ticket; the
 * launch is what ends it.
 *
 * The launch owns the transports registered with it (both halves of a media
 * relay, and any presence RPC stream) and ends them all when its deadline
 * passes or its owner ends it. Its authority is read from the clock on every
 * call, not only when its timer fires, so a timer that runs late never lets
 * a late attach in. What it ends are network transports: that every one has
 * reported itself closed says nothing about processes on the desktop.
 *
 * Importing it does nothing; `startViewerLaunch(...)` starts one launch.
 * It adds no route and is not yet used by the host.
 */

/** The longest lifetime a launch may be given: a ceiling for callers, not a default. */
export const MAX_LAUNCH_MS = 4 * 60 * 60 * 1000;

/** The most transports a launch holds at once that have not reported themselves closed. */
export const MAX_LAUNCH_TRANSPORTS = 8;

/** A monotonic clock in milliseconds, such as `performance.now()`. Only differences between its readings count. */
export type MonotonicClock = () => number;

/** Timers the launch sets for its deadline; one at a time, cleared when the launch ends. */
export type Timers = {
	readonly set: (callback: () => void, ms: number) => unknown;
	readonly clear: (handle: unknown) => void;
};

/** What a launch's transports carry. A label for status only; every kind ends the same way. */
export type TransportKind = "media-viewer" | "media-upstream" | "presence-rpc";

/**
 * A transport the launch owns. `close` ends it at once, as a network
 * transport only (such as `ws.terminate()` or `socket.destroy()`); it must
 * not signal a process or run a command. Its own report that it has closed
 * comes back through the attachment's `closed`.
 */
export type OwnedTransport = {
	readonly close: () => void;
};

/** One adopted transport's registration. `closed` is the owner's report that the transport has closed; later calls do nothing. */
export type Attachment = {
	readonly closed: () => void;
};

/** Why a launch's shutdown was requested: its deadline passed, its owner ended it, or its clock failed. */
export type EndReason = "expired" | "ended" | "clock";

export type LaunchStatus = {
	/**
	 * `live` until a shutdown is requested; then `closing` while any owned
	 * transport has not reported itself closed, and `closed` once every one
	 * has. `closed` is about these transports alone.
	 */
	readonly phase: "live" | "closing" | "closed";
	readonly reason: EndReason | null;
	/** Monotonic milliseconds left; `0` once a shutdown is requested. */
	readonly remainingMs: number;
	/** Transports registered and not yet reported closed, by kind. */
	readonly transports: Readonly<Record<TransportKind, number>>;
	/** Owned transports whose `close` threw. Each stays registered until it reports itself closed. */
	readonly closeFailures: number;
};

export type ViewerLaunch = {
	/** Whether the launch is live now, read from the clock; a launch found past its deadline ends here. */
	readonly live: () => boolean;
	/**
	 * Registers a transport that has opened, such as one whose asynchronous
	 * open finished. If the launch is not live, or already holds
	 * `MAX_LAUNCH_TRANSPORTS`, the transport is closed at once and nothing
	 * is answered.
	 */
	readonly adopt: (kind: TransportKind, transport: OwnedTransport) => Attachment | undefined;
	/** Requests the launch's shutdown: every owned transport is closed. Later calls do nothing. */
	readonly end: () => void;
	readonly status: () => LaunchStatus;
	/** Aborts when a shutdown is requested, for opens still under way. */
	readonly signal: AbortSignal;
};

export type LaunchOptions = {
	/** Whole milliseconds from now, 1 to `MAX_LAUNCH_MS`. */
	readonly lifetimeMs: number;
	readonly clock?: MonotonicClock;
	readonly timers?: Timers;
};

const defaultTimers: Timers = {
	set: (callback, ms) => setTimeout(callback, ms).unref(),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function checkLifetime(ms: number): void {
	if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_LAUNCH_MS) {
		throw new RangeError(`A launch's lifetime must be a whole number of milliseconds from 1 to ${MAX_LAUNCH_MS}.`);
	}
}

/**
 * The lifetime left before `notAfter`, a wall-clock time (Unix
 * milliseconds) that Pim itself set for this launch, read against the
 * host's wall clock `now` once, as the launch starts. The answer goes to
 * `startViewerLaunch`, and the wall clock is never read again for that
 * launch, so turning it back later extends nothing. Never pass it the
 * browser's `expiresAt` or an upstream ticket's expiry. A `notAfter` that
 * has passed, or is further off than `MAX_LAUNCH_MS`, is refused.
 */
export function lifetimeUntil(notAfter: number, now: number): number {
	if (!Number.isSafeInteger(notAfter) || !Number.isSafeInteger(now)) {
		throw new RangeError("A launch's wall-clock times must be whole milliseconds.");
	}
	const ms = notAfter - now;
	checkLifetime(ms);
	return ms;
}

export function startViewerLaunch(options: LaunchOptions): ViewerLaunch {
	checkLifetime(options.lifetimeMs);
	const clock = options.clock ?? (() => performance.now());
	const timers = options.timers ?? defaultTimers;
	const started = clock();
	const deadline = started + options.lifetimeMs;
	// A reading so large that adding the lifetime rounds or overflows would move the deadline.
	if (!Number.isFinite(started) || !Number.isFinite(deadline) || deadline - started !== options.lifetimeMs) {
		throw new RangeError("A launch's clock must read a finite time its lifetime can be added to.");
	}

	const controller = new AbortController();
	/** Owned transports that have not reported themselves closed; each removes itself when it does. */
	const owned = new Map<Attachment, { readonly kind: TransportKind; readonly transport: OwnedTransport }>();
	/** The latest the clock has read, so a clock that goes back gives back no time. */
	let latest = started;
	let reason: EndReason | null = null;
	let timer: unknown;
	let armed = false;
	let closeFailures = 0;

	function request(why: EndReason): void {
		if (reason !== null) return;
		reason = why;
		if (armed) {
			armed = false;
			timers.clear(timer);
		}
		controller.abort();
		// Each is closed once, from a copy, as a `close` may report itself closed at once; one that throws stops none of the others.
		for (const { transport } of [...owned.values()]) {
			try {
				transport.close();
			} catch {
				// It stays registered, and the launch `closing`, until it reports itself closed.
				closeFailures++;
			}
		}
	}

	/** Reads the clock and answers the time it counts; a failed reading ends the launch. */
	const read = (): number | undefined => {
		let now: number;
		try {
			now = clock();
		} catch {
			now = Number.NaN;
		}
		if (!Number.isFinite(now)) {
			request("clock");
			return undefined;
		}
		if (now > latest) latest = now;
		return latest;
	};

	const live = (): boolean => {
		if (reason !== null) return false;
		const now = read();
		if (now === undefined) return false;
		if (now >= deadline) {
			request("expired");
			return false;
		}
		return true;
	};

	const arm = () => {
		const now = read();
		if (now === undefined) return;
		if (now >= deadline) return request("expired");
		armed = true;
		timer = timers.set(
			() => {
				armed = false;
				// A timer that fires early sets another for what is left; one that fires late finds the launch ended already, or ends it.
				if (live()) arm();
			},
			Math.ceil(deadline - now),
		);
	};

	const adopt = (kind: TransportKind, transport: OwnedTransport): Attachment | undefined => {
		if (!live() || owned.size >= MAX_LAUNCH_TRANSPORTS) {
			try {
				transport.close();
			} catch {
				// Never registered, so nothing is left to clean up here.
			}
			return undefined;
		}
		const attachment: Attachment = Object.freeze({
			closed: () => {
				owned.delete(attachment);
			},
		});
		owned.set(attachment, { kind, transport });
		return attachment;
	};

	const status = (): LaunchStatus => {
		live();
		const counts: Record<TransportKind, number> = { "media-viewer": 0, "media-upstream": 0, "presence-rpc": 0 };
		for (const { kind } of owned.values()) counts[kind]++;
		return {
			phase: reason === null ? "live" : owned.size > 0 ? "closing" : "closed",
			reason,
			remainingMs: reason === null ? deadline - latest : 0,
			transports: counts,
			closeFailures,
		};
	};

	arm();
	return Object.freeze({ live, adopt, end: () => request("ended"), status, signal: controller.signal });
}
