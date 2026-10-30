/**
 * This Pim's computer host: a machine of the operator's (Linux with KVM,
 * or a Mac with Apple silicon) that runs Cua and ../computer/pim-host.ts,
 * and keeps one computer for each space that asks for one: a VM that runs
 * all the time, Omarchy, or Ubuntu where Omarchy can't run. The
 * admin pairs it in Settings → Deployment, which makes its token,
 * `pimh_<secret>`; the Directory keeps only the token's digest.
 *
 * The host needs no open port. It asks the Worker for work at
 * `/api/computer-host/sync` every few seconds, with the token, and reports
 * what it did with the work it took before: each request is to make a
 * space's computer, with the token the computer connects to the space with,
 * or to remove one. Requests live in the Directory until the host reports
 * them done; one it took and never reported is given again after
 * `RETAKE_MS`, so a host that restarts mid-way does it again. A space has at
 * most one request at a time: a newer one replaces it.
 *
 * Whether a computer is up is between it and its space: it connects to the
 * space itself, once the host has set it up. Only a failure to set it up
 * comes back this way, to the space (`computerSetupFailed`).
 */

/** The prefix of a host's token. */
export const HOST_TOKEN_PREFIX = "pimh_";
/** How long the host may take over a request before it's given again. */
export const RETAKE_MS = 20 * 60_000;
/** How long since the host last asked for work it's still counted as connected. */
export const HOST_SEEN_MS = 2 * 60_000;

/** What the host is asked to do. */
export type HostRequest =
	| { readonly id: string; readonly op: "create"; readonly name: string; readonly token: string }
	| { readonly id: string; readonly op: "delete"; readonly name: string };

/** What the host did with a request it took: done, or failed with why. */
export type HostResult = { readonly id: string; readonly error?: string };

/** What the host reports each time it asks for work. */
export type HostSync = {
	readonly results: readonly HostResult[];
	/** The computers it keeps, by name, and whether each runs. */
	readonly machines?: readonly { readonly name: string; readonly running: boolean }[];
	/** The image it makes computers from, as which kind (`vm` or `container`), and its version, for the admin to see. */
	readonly image?: string;
	readonly kind?: string;
	readonly version?: string;
	/** Only checking its token, as `pim-host install` and `status` do: it takes no work and isn't counted as seen. */
	readonly check?: true;
};

/** The host, as the admin sees it in Settings → Deployment. */
export type HostStatus = {
	readonly paired: boolean;
	readonly pairedAt: number | null;
	/** When it last asked for work, and whether that's recent enough to call it connected. */
	readonly seenAt: number | null;
	readonly connected: boolean;
	readonly image: string | null;
	readonly kind: string | null;
	readonly version: string | null;
	/** The computers it said it keeps, and how many of them run. */
	readonly machines: number;
	readonly running: number;
	/** Requests it hasn't reported done. */
	readonly pending: number;
};

/** The name of a space's computer on the host: `pim-` and its owner, as a hostname may be written. */
export function machineName(owner: string): string {
	return `pim-${owner.replace("_", "-")}`;
}

/** Reads what a host sent to `/api/computer-host/sync`, keeping only what it should have sent. */
export function readSync(body: unknown): HostSync {
	const given = (body ?? {}) as Record<string, unknown>;
	const results = (Array.isArray(given.results) ? given.results : [])
		.filter((result): result is { id: string; error?: unknown } => typeof result?.id === "string")
		.map((result) => ({ id: result.id, ...(typeof result.error === "string" ? { error: result.error.slice(0, 500) } : {}) }));
	const machines = Array.isArray(given.machines)
		? given.machines
				.filter((machine): machine is { name: string; running?: unknown } => typeof machine?.name === "string")
				.map((machine) => ({ name: machine.name, running: machine.running === true }))
		: undefined;
	return {
		results,
		...(machines ? { machines } : {}),
		...(typeof given.image === "string" ? { image: given.image.slice(0, 200) } : {}),
		...(typeof given.kind === "string" ? { kind: given.kind.slice(0, 20) } : {}),
		...(typeof given.version === "string" ? { version: given.version.slice(0, 50) } : {}),
		...(given.check === true ? { check: true as const } : {}),
	};
}
