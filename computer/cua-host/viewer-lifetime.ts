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
 * a late attach in. A transport it refuses (one that opened late, or past
 * its bound) is asked to close at once and counted as open until its owner
 * reports it closed. What it ends are network transports: that every one
 * has reported itself closed says nothing about processes on the desktop.
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

/**
 * Timers the launch sets for its deadline, one at a time, cleared when a
 * shutdown is requested. `set` must call back later, never from within
 * itself. A `set` that throws ends the launch (`timer`); a `clear` that
 * throws is ignored, after every transport has been asked to close, as a
 * timer that fires after the launch ended does nothing.
 */
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
 * comes back through the adoption's `closed`.
 */
export type OwnedTransport = {
	readonly close: () => void;
};

/** What `adopt` answers for every transport it is handed, taken or not. */
export type Adoption = {
	/** Whether the launch took the transport. One it refused has been asked to close once, and is the launch's no further. */
	readonly admitted: boolean;
	/**
	 * The owner's report that the transport has closed, which every
	 * transport needs, refused ones too: until then it counts as open.
	 * Later calls do nothing.
	 */
	readonly closed: () => void;
};

/** Why a launch's shutdown was requested: its deadline passed, its owner ended it, its clock failed, or its timer couldn't be set. */
export type EndReason = "expired" | "ended" | "clock" | "timer";

export type LaunchStatus = {
	/**
	 * `live` until a shutdown is requested; then `closing` while any
	 * transport handed to `adopt`, taken or refused, has not reported itself
	 * closed, and `closed` once every one has. `closed` is about these
	 * transports alone.
	 */
	readonly phase: "live" | "closing" | "closed";
	readonly reason: EndReason | null;
	/** Monotonic milliseconds left; `0` once a shutdown is requested. */
	readonly remainingMs: number;
	/** Transports the launch took and that have not reported themselves closed, by kind. */
	readonly transports: Readonly<Record<TransportKind, number>>;
	/** Transports the launch refused and asked to close that have not reported themselves closed. */
	readonly refused: number;
	/** Calls to a transport's `close` that threw, taken or refused. Each such transport still counts as open until it reports itself closed. */
	readonly closeFailures: number;
};

export type ViewerLaunch = {
	/** Whether the launch is live now, read from the clock; a launch found past its deadline ends here. */
	readonly live: () => boolean;
	/**
	 * Hands the launch a transport that has opened, such as one whose
	 * asynchronous open finished. If the launch is not live, or already
	 * holds `MAX_LAUNCH_TRANSPORTS`, the transport is refused: its `close`
	 * is called at once, and only a count of it is kept until its owner
	 * reports it closed.
	 */
	readonly adopt: (kind: TransportKind, transport: OwnedTransport) => Adoption;
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
	// Counted from the whole millisecond at or before the start, so the deadline is a safe integer, never later than the start plus the lifetime.
	const deadline = Math.floor(started) + options.lifetimeMs;
	if (!Number.isSafeInteger(deadline)) {
		throw new RangeError("A launch's clock must read a finite time its lifetime can be added to exactly.");
	}

	const controller = new AbortController();
	/** Taken transports that have not reported themselves closed; each removes itself when it does. At most `MAX_LAUNCH_TRANSPORTS`. */
	const owned = new Map<Adoption, { readonly kind: TransportKind; readonly transport: OwnedTransport }>();
	/** Refused transports that have not reported themselves closed: a count, not a record of them. */
	let refused = 0;
	/** The latest the clock has read, so a clock that goes back gives back no time. */
	let latest = started;
	let reason: EndReason | null = null;
	let timer: unknown;
	let armed = false;
	let closeFailures = 0;

	const close = (transport: OwnedTransport) => {
		try {
			transport.close();
		} catch {
			// The transport still counts as open until it reports itself closed.
			closeFailures++;
		}
	};

	function request(why: EndReason): void {
		if (reason !== null) return;
		reason = why;
		controller.abort();
		// Each is closed once, from a copy, as a `close` may report itself closed at once; one that throws stops none of the others.
		for (const { transport } of [...owned.values()]) close(transport);
		if (armed) {
			armed = false;
			try {
				timers.clear(timer);
			} catch {
				// A timer that still fires finds the launch ended and does nothing.
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
		const fire = () => {
			armed = false;
			// A timer that fires early sets another for what is left; one that fires late finds the launch ended already, or ends it.
			if (live()) arm();
		};
		try {
			timer = timers.set(fire, Math.ceil(deadline - now));
		} catch {
			return request("timer");
		}
		armed = true;
	};

	const adopt = (kind: TransportKind, transport: OwnedTransport): Adoption => {
		let reported = false;
		if (!live() || owned.size >= MAX_LAUNCH_TRANSPORTS) {
			refused++;
			const adoption: Adoption = Object.freeze({
				admitted: false,
				closed: () => {
					if (reported) return;
					reported = true;
					refused--;
				},
			});
			close(transport);
			return adoption;
		}
		const adoption: Adoption = Object.freeze({
			admitted: true,
			closed: () => {
				owned.delete(adoption);
			},
		});
		owned.set(adoption, { kind, transport });
		return adoption;
	};

	const status = (): LaunchStatus => {
		live();
		const counts: Record<TransportKind, number> = { "media-viewer": 0, "media-upstream": 0, "presence-rpc": 0 };
		for (const { kind } of owned.values()) counts[kind]++;
		return {
			phase: reason === null ? "live" : owned.size > 0 || refused > 0 ? "closing" : "closed",
			reason,
			remainingMs: reason === null ? deadline - latest : 0,
			transports: counts,
			refused,
			closeFailures,
		};
	};

	arm();
	return Object.freeze({ live, adopt, end: () => request("ended"), status, signal: controller.signal });
}
