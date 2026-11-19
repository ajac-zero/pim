import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";
import { Authorizer } from "./authz.ts";
import { BadRequestError, ConflictError, PimError } from "./errors.ts";
import type { Principal } from "@pim/v2-contracts/identity";

/**
 * Email to the person, through a deployment's mail sender. It is optional: a deployment that has none (`PIM_SMTP_URL` and `PIM_EMAIL_FROM`, see the server's `smtp.ts`) shows
 * email as unavailable in Settings, and Pim can then send nothing. Pim only ever emails the one address a person confirmed.
 */
export type Mail = { readonly to: string; readonly subject: string; readonly text: string };
export type Mailer = { send(mail: Mail): Promise<void> };

/** Emails one person's space sends them in a UTC day, so a runaway schedule can't flood an inbox. */
export const EMAILS_PER_DAY = 50;
/** Confirmation codes one person can have sent in a UTC day, so Pim can't be used to pester someone else's inbox. */
export const CODES_PER_DAY = 5;
/** How long a confirmation code works, and how many wrong tries it takes. */
export const CODE_MS = 30 * 60_000;
export const CODE_ATTEMPTS = 5;

/** The person's email as the API shows it. */
export type EmailState = {
	/** This Pim can send email at all. */
	available: boolean;
	/** The confirmed address Pim emails, or null. */
	address: string | null;
	/** An address waiting for its code, or null. */
	pending: string | null;
};

const digestOf = (code: string) => createHash("sha256").update(code).digest("hex");

function validAddress(value: unknown): string {
	const address = typeof value === "string" ? value.trim() : "";
	if (address.length > 254 || !/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(address)) throw new BadRequestError("address must be an email address");
	return address;
}

/** Midnight UTC today. */
const today = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

/** The person's confirmed address, a code waiting to confirm another, and sending them email. */
export class Email {
	readonly authz: Authorizer;
	constructor(
		private readonly db: Db,
		private readonly mailer: Mailer | undefined,
	) {
		this.authz = new Authorizer(db);
	}

	/** Whether this deployment can send email. */
	get available(): boolean {
		return this.mailer !== undefined;
	}

	async state(ownerId: string): Promise<EmailState> {
		return this.db.owner(ownerId, async (tx) => ({
			available: this.available,
			address: ((await tx.query("SELECT address FROM pim_app.email_addresses")).rows[0]?.address as string | undefined) ?? null,
			pending: ((await tx.query("SELECT address FROM pim_app.email_pending WHERE expires_at > now()")).rows[0]?.address as string | undefined) ?? null,
		}));
	}

	/** Emails a code to `value`; it becomes the address once the code comes back. */
	async start(p: Principal, value: unknown): Promise<EmailState> {
		await this.authz.enforce(p, "api:write");
		if (!this.mailer) throw new ConflictError("This Pim can't send email", "email_unavailable");
		const address = validAddress(value);
		const sent = await this.db.owner(p.ownerId, async (tx) => Number((await tx.query("SELECT count(*) AS n FROM pim_app.emails_sent WHERE kind = 'code' AND sent_at >= $1", [today()])).rows[0].n));
		if (sent >= CODES_PER_DAY) throw new PimError(429, "too_many_codes", `You can ask for ${CODES_PER_DAY} codes a day. Try again tomorrow.`);
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		await this.mailer.send({
			to: address,
			subject: `${code} is your Pim confirmation code`,
			text: `Enter ${code} in Pim's Settings to have Pim email you here. It works for 30 minutes.\n\nIf you didn't ask for this, ignore this email: nothing will be sent to you.`,
		});
		await this.db.owner(p.ownerId, async (tx) => {
			await tx.query("INSERT INTO pim_app.emails_sent (owner_id, id, kind, subject) VALUES ($1, $2, 'code', 'Confirmation code')", [p.ownerId, `code-${crypto.randomUUID()}`]);
			await tx.query(
				`INSERT INTO pim_app.email_pending (owner_id, address, digest, expires_at) VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')
				 ON CONFLICT (owner_id) DO UPDATE SET address = excluded.address, digest = excluded.digest, expires_at = excluded.expires_at, attempts = 0`,
				[p.ownerId, address, digestOf(code), CODE_MS],
			);
		});
		return this.state(p.ownerId);
	}

	/** Confirms the waiting address with its code. */
	async confirm(p: Principal, code: unknown): Promise<EmailState> {
		await this.authz.enforce(p, "api:write");
		const outcome = await this.db.owner(p.ownerId, async (tx) => {
			const pending = (await tx.query("SELECT address, digest, attempts FROM pim_app.email_pending WHERE expires_at > now() FOR UPDATE")).rows[0];
			if (!pending) return "none";
			if (pending.attempts >= CODE_ATTEMPTS) return "locked";
			const given = typeof code === "string" ? Buffer.from(digestOf(code.trim())) : undefined;
			if (!given || !timingSafeEqual(given, Buffer.from(pending.digest as string))) {
				await tx.query("UPDATE pim_app.email_pending SET attempts = attempts + 1");
				return "wrong";
			}
			await tx.query("INSERT INTO pim_app.email_addresses (owner_id, address) VALUES ($1, $2) ON CONFLICT (owner_id) DO UPDATE SET address = excluded.address, confirmed_at = now()", [p.ownerId, pending.address]);
			await tx.query("DELETE FROM pim_app.email_pending");
			return "confirmed";
		});
		if (outcome === "none") throw new ConflictError("No address is waiting for a code");
		if (outcome === "locked") throw new PimError(429, "too_many_attempts", "Too many wrong codes. Ask for a new one.");
		if (outcome === "wrong") throw new BadRequestError("That code is wrong");
		return this.state(p.ownerId);
	}

	/**
	 * Emails the person at their confirmed address, as a message from `chat`; the same `id` again (a replayed tool call) sends nothing.
	 * Returns the address, or says why it can't.
	 */
	async send(ownerId: string, mail: { id: string; chat: string | null; subject: string; text: string }): Promise<{ to: string } | { error: string }> {
		if (!this.mailer) return { error: "This Pim can't send email." };
		const found = await this.db.owner(ownerId, async (tx) => ({
			to: (await tx.query("SELECT address FROM pim_app.email_addresses")).rows[0]?.address as string | undefined,
			again: (await tx.query("SELECT 1 FROM pim_app.emails_sent WHERE id = $1", [mail.id])).rowCount !== 0,
			today: Number((await tx.query("SELECT count(*) AS n FROM pim_app.emails_sent WHERE kind = 'message' AND sent_at >= $1", [today()])).rows[0].n),
		}));
		if (!found.to) return { error: "The person hasn't added an email address in Settings yet." };
		if (found.again) return { to: found.to };
		if (found.today >= EMAILS_PER_DAY) return { error: `Pim can email the person ${EMAILS_PER_DAY} times a day, and has today.` };
		await this.mailer.send({ to: found.to, subject: mail.subject, text: mail.text });
		await this.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.emails_sent (owner_id, id, kind, public_chat_id, subject) VALUES ($1, $2, 'message', $3, $4) ON CONFLICT DO NOTHING", [ownerId, mail.id, mail.chat, mail.subject]));
		return { to: found.to };
	}

	/** Forgets the address, and any waiting for a code. */
	async remove(p: Principal): Promise<EmailState> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			await tx.query("DELETE FROM pim_app.email_addresses");
			await tx.query("DELETE FROM pim_app.email_pending");
		});
		return this.state(p.ownerId);
	}
}
