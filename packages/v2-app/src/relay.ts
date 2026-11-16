import { Authorizer } from "./authz.ts";
import type { Db } from "./db.ts";
import { CapabilityUnavailableError } from "@pim/v2-contracts/authz";
import { NotFoundError } from "./errors.ts";
import { Identity } from "./identity.ts";
import { newId } from "./ids.ts";
import type { Principal } from "@pim/v2-contracts/identity";

/** What a connected computer's socket can do. The Relay owns these sockets: screen and media signaling never pass through the Runner or the chat bus. */
export interface ComputerLink {
	readonly protocol: 1 | 2;
	send(message: unknown): void;
}

/**
 * Relay's registry of paired personal computers. Pairing issues a `pimc_` token; a v1 or v2 client connects with it. Tools that need a computer
 * ask `require`, which throws CapabilityUnavailableError when none is paired or connected, so everything else in Pim keeps working without one.
 */
export class Relay {
	readonly #links = new Map<string, ComputerLink>();
	constructor(private readonly db: Db, private readonly identity = new Identity(db), private readonly authz = new Authorizer(db)) {}

	async pair(p: Principal, name: string, protocol: 1 | 2): Promise<{ computerId: string; token: string }> {
		await this.authz.enforce(p, "computer:use");
		const computerId = newId("pc");
		const consumer = await this.identity.issueConsumer(p.ownerId, "computer", { label: name, scopes: ["computer:connect"], metadata: { computerId } });
		await this.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.computers (id, owner_id, name, protocol, consumer_id) VALUES ($1,$2,$3,$4,$5)", [computerId, p.ownerId, name, protocol, consumer.id]));
		return { computerId, token: consumer.token };
	}

	/** A computer connects with its pimc_ token; revoked tokens and suspended owners are refused at the Authorizer. */
	async connect(token: string, link: ComputerLink): Promise<string> {
		const p = await this.identity.authenticate(token);
		if (!p.kind || p.kind !== "token" || !p.scopes.includes("computer:connect")) throw new NotFoundError("Not a computer token");
		await this.authz.enforce(p, "computer:connect");
		const computerId = await this.db.owner(p.ownerId, async (tx) => {
			const c = (await tx.query("SELECT c.id FROM pim_app.computers c WHERE c.consumer_id = $1 AND c.revoked_at IS NULL", [p.tokenId])).rows[0];
			if (!c) throw new NotFoundError("This computer is no longer paired");
			await tx.query("UPDATE pim_app.computers SET last_seen_at = now(), protocol = $2 WHERE id = $1", [c.id, link.protocol]);
			return c.id as string;
		});
		this.#links.set(`${p.ownerId}/${computerId}`, link);
		return computerId;
	}

	disconnect(ownerId: string, computerId: string): void {
		this.#links.delete(`${ownerId}/${computerId}`);
	}

	/** The owner's connected computer for a tool that needs one. */
	require(ownerId: string, capability: string): ComputerLink {
		for (const [key, link] of this.#links) if (key.startsWith(`${ownerId}/`)) return link;
		throw new CapabilityUnavailableError(capability, "it needs a paired personal computer, and none is connected");
	}
}
