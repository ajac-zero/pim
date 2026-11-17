/**
 * The computer host, ported from v1 (`src/computer-host.ts`, `src/directory.ts`): a machine of the operator's, running `computer/pim-host.ts`, that keeps one computer for each
 * person who asks for one. The admin pairs it in Settings → Deployment, which makes its `pimh_` token (a `token_consumers` row of the admin, kind host, scope `host:sync`; only the
 * token's digest is kept). The host needs no open port and is outside the control plane: it asks this process for work at `/api/computer-host/sync` every few seconds, with its own
 * machine credential, and reports what it did with the work it took before. Each request is to make a person's computer or to remove one.
 *
 * A computer the host makes is an ordinary paired computer (`pim_app.computers`, a `pimc_` token for exactly that person, scope `computer:connect`): it dials out to the stack as a
 * person's own does, and the person's tools reach it over the Relay. The token is made when the host takes the request and goes to the host in the answer to that sync only, so no
 * computer's token is ever stored in the clear. A request the host took and never reported is given again after 20 minutes (and then a new token replaces the old); one that failed
 * keeps its error, for the person to see, until they ask again. A person has at most one request at a time: a newer one replaces it.
 *
 * What a person's `/api/computer` answers where a host is paired is in `./managed.ts`.
 */
import type { Db } from "@pim/v2-app/db";
import type { Identity } from "@pim/v2-app/identity";
import { ConflictError, UnauthorizedError } from "@pim/v2-app/errors";
import { newId } from "@pim/v2-app/ids";
import type { Principal } from "@pim/v2-contracts/identity";

/** How long the host may take over a request before it is given again, and how long since it last asked for work it still counts as connected. */
export const RETAKE_MS = 20 * 60_000;
export const HOST_SEEN_MS = 2 * 60_000;
export const HOST_SCOPE = "host:sync";

export type HostRequest = { readonly id: string; readonly op: "create"; readonly name: string; readonly token: string } | { readonly id: string; readonly op: "delete"; readonly name: string };
export type HostResult = { readonly id: string; readonly error?: string };
export type HostSync = { readonly results: readonly HostResult[]; readonly machines?: readonly { readonly name: string; readonly running: boolean }[]; readonly image?: string; readonly kind?: string; readonly version?: string; readonly check?: true };
export type HostStatus = { paired: boolean; pairedAt: number | null; seenAt: number | null; connected: boolean; image: string | null; kind: string | null; version: string | null; machines: number; running: number; pending: number };

/** The name of a person's computer on the host: `pim-` and their owner id, as a hostname may be written. */
export const machineName = (ownerId: string) => `pim-${ownerId.replace("_", "-")}`;
/** The owner a machine name is for, or null for a machine that is not one of ours. */
export const ownerOfMachine = (name: string) => (/^pim-o-[0-9a-f]{24}$/.test(name) ? `o_${name.slice(6)}` : null);

/** Reads what a host sent to `/api/computer-host/sync`, keeping only what it should have sent. */
export function readSync(body: unknown): HostSync {
	const given = (body ?? {}) as Record<string, unknown>;
	const results = (Array.isArray(given.results) ? given.results : []).filter((r): r is { id: string; error?: unknown } => typeof r?.id === "string").map((r) => ({ id: r.id, ...(typeof r.error === "string" ? { error: r.error.slice(0, 500) } : {}) }));
	const machines = Array.isArray(given.machines) ? given.machines.filter((m): m is { name: string; running?: unknown } => typeof m?.name === "string").map((m) => ({ name: m.name, running: m.running === true })) : undefined;
	return { results, ...(machines ? { machines } : {}), ...(typeof given.image === "string" ? { image: given.image.slice(0, 200) } : {}), ...(typeof given.kind === "string" ? { kind: given.kind.slice(0, 20) } : {}), ...(typeof given.version === "string" ? { version: given.version.slice(0, 50) } : {}), ...(given.check === true ? { check: true as const } : {}) };
}

export class ComputerHost {
	constructor(private readonly db: Db, private readonly identity: Identity, private readonly onProvided: (ownerId: string) => void = () => undefined) {}

	async has(): Promise<boolean> {
		return this.db.anonymous(async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.computer_hosts")).rowCount);
	}

	async status(now = Date.now()): Promise<HostStatus> {
		return this.db.anonymous(async (tx) => {
			const h = (await tx.query("SELECT * FROM pim_app.computer_hosts")).rows[0];
			const pending = Number((await tx.query("SELECT count(*) AS n FROM pim_app.computer_requests WHERE failed_at IS NULL")).rows[0]!.n);
			return { paired: !!h, pairedAt: h?.paired_at.getTime() ?? null, seenAt: h?.seen_at?.getTime() ?? null, connected: !!h?.seen_at && now - h.seen_at.getTime() < HOST_SEEN_MS, image: h?.image ?? null, kind: h?.kind ?? null, version: h?.version ?? null, machines: h?.machines ?? 0, running: h?.running ?? 0, pending };
		});
	}

	/** Pairs a computer host, in place of any other: its token is returned only here, and only its digest is kept. */
	async pair(admin: Principal): Promise<string> {
		await this.identity.authz.enforce(admin, "admin:compute");
		const consumer = await this.identity.issueConsumer(admin.ownerId, "host", { label: "Computer host", scopes: [HOST_SCOPE] });
		const old = await this.db.anonymous(async (tx) => {
			const previous = (await tx.query("DELETE FROM pim_app.computer_hosts RETURNING admin_owner_id, consumer_id")).rows[0];
			await tx.query("INSERT INTO pim_app.computer_hosts (id, admin_owner_id, consumer_id) VALUES ('host', $1, $2)", [admin.ownerId, consumer.id]);
			return previous;
		});
		await this.#revoke(old);
		return consumer.token;
	}

	/** Revokes a host's token, which belongs to the admin who paired it. */
	async #revoke(host: { admin_owner_id: string; consumer_id: string } | undefined): Promise<void> {
		if (host) await this.db.owner(host.admin_owner_id, (tx) => tx.query("UPDATE pim_app.token_consumers SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1", [host.consumer_id]));
	}

	/** Forgets the computer host: its token stops working. The computers it keeps go on, connected to their owners. */
	async forget(admin: Principal): Promise<void> {
		await this.identity.authz.enforce(admin, "admin:compute");
		await this.#revoke(await this.db.anonymous(async (tx) => (await tx.query("DELETE FROM pim_app.computer_hosts RETURNING admin_owner_id, consumer_id")).rows[0]));
	}

	/** Asks the host to make `ownerId`'s computer (or set theirs up again), in place of anything asked for them before. */
	async request(ownerId: string): Promise<void> {
		await this.#put(ownerId, "create");
	}

	/** Asks the host to remove `ownerId`'s computer, with everything on it. */
	async requestRemoval(ownerId: string): Promise<void> {
		await this.#put(ownerId, "delete");
	}

	async #put(ownerId: string, op: "create" | "delete"): Promise<void> {
		await this.db.anonymous((tx) =>
			tx.query("INSERT INTO pim_app.computer_requests (owner_id, id, op, name) VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id) DO UPDATE SET id = $2, op = $3, name = $4, requested_at = now(), taken_at = NULL, failed_at = NULL, error = NULL", [ownerId, newId("cr"), op, machineName(ownerId)]),
		);
	}

	/** What a person's computer is where the host keeps it: whether theirs is a machine of the host's, and the request for it, with why it failed, while it is not yet up. */
	async managedState(ownerId: string): Promise<{ machine: string | null; request: { requestedAt: number; error: string | null } | null }> {
		const machine = await this.db.owner(ownerId, async (tx) => ((await tx.query("SELECT machine FROM pim_app.computers WHERE revoked_at IS NULL")).rows[0]?.machine as string | null | undefined) ?? null);
		const r = await this.db.anonymous(async (tx) => (await tx.query("SELECT requested_at, error FROM pim_app.computer_requests WHERE owner_id = $1 AND op = 'create'", [ownerId])).rows[0]);
		return { machine, request: r ? { requestedAt: r.requested_at.getTime(), error: r.error } : null };
	}

	/** Makes the person's computer a machine of the host's: a new `pimc_` token for it, in place of any computer they had. It is returned only here, to go to the host. */
	async #provide(ownerId: string, name: string): Promise<string> {
		const computerId = newId("pc");
		const consumer = await this.identity.issueConsumer(ownerId, "computer", { label: name, scopes: ["computer:connect"], metadata: { computerId, machine: name } });
		await this.db.owner(ownerId, async (tx) => {
			await tx.query("UPDATE pim_app.computers SET revoked_at = now() WHERE revoked_at IS NULL");
			await tx.query("UPDATE pim_app.token_consumers SET revoked_at = coalesce(revoked_at, now()) WHERE kind = 'computer' AND id <> $1", [consumer.id]);
			await tx.query("INSERT INTO pim_app.computers (id, owner_id, name, protocol, consumer_id, machine) VALUES ($1,$2,$3,2,$4,$5)", [computerId, ownerId, name, consumer.id, name]);
		});
		this.onProvided(ownerId);
		return consumer.token;
	}

	/** Whether `p` is the host's own credential: a `pimh_` token of the paired host, and nothing else. */
	async #isHost(p: Principal): Promise<boolean> {
		if (p.kind !== "token" || !p.scopes.includes(HOST_SCOPE)) return false;
		return this.db.anonymous(async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.computer_hosts WHERE consumer_id = $1", [p.tokenId])).rowCount);
	}

	/**
	 * The host asked for work, with its token, and reported what it did with work it took before: done requests go, and a person whose computer could not be made hears why. Returns the
	 * requests to do now. A token that is not the paired host's is refused with 401.
	 */
	async sync(p: Principal, sync: HostSync, now = Date.now()): Promise<{ requests: HostRequest[] }> {
		if (!(await this.#isHost(p))) throw new UnauthorizedError("This isn't this Pim's computer host token");
		if (sync.check) return { requests: [] };
		await this.db.anonymous(async (tx) => {
			await tx.query("UPDATE pim_app.computer_hosts SET seen_at = $1, image = coalesce($2, image), kind = coalesce($3, kind), version = coalesce($4, version), machines = coalesce($5, machines), running = coalesce($6, running)", [
				new Date(now), sync.image ?? null, sync.kind ?? null, sync.version ?? null, sync.machines?.length ?? null, sync.machines ? sync.machines.filter((m) => m.running).length : null,
			]);
			for (const result of sync.results) {
				const row = (await tx.query("SELECT owner_id, op FROM pim_app.computer_requests WHERE id = $1", [result.id])).rows[0];
				if (!row) continue;
				// A removal that failed is given again later; a computer that could not be made is the person's to ask for again.
				if (result.error && row.op === "delete") continue;
				if (result.error) await tx.query("UPDATE pim_app.computer_requests SET failed_at = now(), error = $2 WHERE id = $1", [result.id, result.error]);
				else await tx.query("DELETE FROM pim_app.computer_requests WHERE id = $1", [result.id]);
			}
		});
		// A machine whose person is gone (deleting or deleted) is removed, with everything on it.
		for (const machine of sync.machines ?? []) {
			const owner = ownerOfMachine(machine.name);
			if (!owner) continue;
			const gone = await this.db.owner(owner, async (tx) => ["deleting", "deleted"].includes((await tx.query("SELECT status FROM pim_app.accounts WHERE owner_id = $1", [owner])).rows[0]?.status));
			const open = await this.db.anonymous(async (tx) => !!(await tx.query("SELECT 1 FROM pim_app.computer_requests WHERE owner_id = $1 AND op = 'delete'", [owner])).rowCount);
			if (gone && !open) await this.requestRemoval(owner);
		}
		const due = await this.db.anonymous(async (tx) => (await tx.query("UPDATE pim_app.computer_requests SET taken_at = $1 WHERE owner_id IN (SELECT owner_id FROM pim_app.computer_requests WHERE failed_at IS NULL AND (taken_at IS NULL OR taken_at <= $2) ORDER BY requested_at LIMIT 20) RETURNING *", [new Date(now), new Date(now - RETAKE_MS)])).rows);
		const requests: HostRequest[] = [];
		for (const row of due) {
			if (row.op === "delete") {
				requests.push({ id: row.id, op: "delete", name: row.name });
				continue;
			}
			// Only a person who may act gets a computer: one suspended or deleted since asking is dropped.
			const alive = await this.identity.authz.requireLive(row.owner_id).then(() => true, () => false);
			if (!alive) {
				await this.db.anonymous((tx) => tx.query("DELETE FROM pim_app.computer_requests WHERE id = $1", [row.id]));
				continue;
			}
			requests.push({ id: row.id, op: "create", name: row.name, token: await this.#provide(row.owner_id, row.name) });
		}
		return { requests };
	}

	/** Authenticates the bearer of a sync request; 401 for none or an unknown one. */
	async authenticate(bearer: string | undefined): Promise<Principal> {
		if (!bearer?.startsWith("pimh_")) throw new UnauthorizedError("This isn't this Pim's computer host token");
		return this.identity.authenticate(bearer);
	}

	/** A person asking for their own computer where the host keeps one. */
	conflict(): ConflictError {
		return new ConflictError("This Pim keeps a computer for you, so you can't connect another.");
	}
}
