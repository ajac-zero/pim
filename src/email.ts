import { digestHex } from "./auth/store";
import { HttpError } from "./http";
import type { PimStore } from "./store";

/**
 * Email to the person, through Cloudflare Email Service. It is optional: a
 * deployment that adds a `send_email` binding named `EMAIL` and sets
 * `PIM_EMAIL_FROM` to an address on a domain onboarded to Email Service lets
 * each person confirm an address in Settings, and Pim can then send them
 * messages there. Pim only ever emails that one confirmed address.
 */

export type Mail = { readonly to: string; readonly subject: string; readonly text: string };

export type Mailer = { send(mail: Mail): Promise<void> };

/** What the bindings in `wrangler.jsonc` add when email is set up. */
type EmailEnv = { readonly EMAIL?: SendEmail; readonly PIM_EMAIL_FROM?: string };

/** The deployment's mailer, or null when it can't send email. */
export function mailerFrom(env: Env): Mailer | null {
	const { EMAIL: binding, PIM_EMAIL_FROM: from } = env as unknown as EmailEnv;
	if (!binding || !from) return null;
	return {
		async send({ to, subject, text }) {
			await binding.send({ from: { email: from, name: "Pim" }, to, subject, text });
		},
	};
}

/** Emails one person's space sends them in a UTC day, so a runaway schedule can't flood an inbox. */
export const EMAILS_PER_DAY = 50;
/** Confirmation codes one person can have sent in a UTC day, so Pim can't be used to pester someone else's inbox. */
const CODES_PER_DAY = 5;
/** How long a confirmation code works, and how many wrong tries it takes. */
const CODE_MS = 30 * 60_000;
const CODE_ATTEMPTS = 5;

const ADDRESS_KEY = "email";
const PENDING_KEY = "email_pending";

type Pending = { readonly address: string; readonly digest: string; readonly expiresAt: number; readonly attempts: number };

/** The person's email as the API shows it. */
export type EmailState = {
	/** This Pim can send email at all. */
	readonly available: boolean;
	/** The confirmed address Pim emails, or null. */
	readonly address: string | null;
	/** An address waiting for its code, or null. */
	readonly pending: string | null;
};

function validAddress(value: unknown): string {
	const address = typeof value === "string" ? value.trim() : "";
	if (address.length > 254 || !/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(address)) {
		throw new HttpError(400, "address must be an email address");
	}
	return address;
}

/** Midnight UTC today, in ms. */
function today(): number {
	return Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
}

/**
 * The person's confirmed address, a code waiting to confirm another, and
 * sending them email, kept in their space's database.
 */
export class Email {
	readonly #store: PimStore;
	readonly #mailer: () => Mailer | null;

	constructor(store: PimStore, mailer: () => Mailer | null) {
		this.#store = store;
		this.#mailer = mailer;
	}

	/** The confirmed address, or null. */
	address(): string | null {
		const json = this.#store.meta(ADDRESS_KEY);
		return json === undefined ? null : (JSON.parse(json) as { address: string }).address;
	}

	state(): EmailState {
		const pending = this.#pending();
		return { available: this.#mailer() !== null, address: this.address(), pending: pending?.address ?? null };
	}

	/** Emails a code to `value`; it becomes the address once the code comes back. */
	async start(value: unknown): Promise<EmailState> {
		const mailer = this.#mailer();
		if (!mailer) throw new HttpError(409, "This Pim can't send email");
		const address = validAddress(value);
		if (this.#store.emailsSince(today(), "codes") >= CODES_PER_DAY) {
			throw new HttpError(429, `You can ask for ${CODES_PER_DAY} codes a day. Try again tomorrow.`);
		}
		const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
		await mailer.send({
			to: address,
			subject: `${code} is your Pim confirmation code`,
			text: `Enter ${code} in Pim's Settings to have Pim email you here. It works for 30 minutes.\n\nIf you didn't ask for this, ignore this email: nothing will be sent to you.`,
		});
		this.#store.recordEmail({ id: crypto.randomUUID(), session: null, subject: "Confirmation code" });
		const pending: Pending = { address, digest: await digestHex(code), expiresAt: Date.now() + CODE_MS, attempts: 0 };
		this.#store.setMeta(PENDING_KEY, JSON.stringify(pending));
		return this.state();
	}

	/** Confirms the waiting address with its code. */
	async confirm(code: unknown): Promise<EmailState> {
		const pending = this.#pending();
		if (!pending) throw new HttpError(409, "No address is waiting for a code");
		if (pending.attempts >= CODE_ATTEMPTS) throw new HttpError(429, "Too many wrong codes. Ask for a new one.");
		if (typeof code !== "string" || (await digestHex(code.trim())) !== pending.digest) {
			this.#store.setMeta(PENDING_KEY, JSON.stringify({ ...pending, attempts: pending.attempts + 1 }));
			throw new HttpError(400, "That code is wrong");
		}
		this.#store.setMeta(ADDRESS_KEY, JSON.stringify({ address: pending.address, confirmedAt: Date.now() }));
		this.#store.deleteMeta(PENDING_KEY);
		return this.state();
	}

	/**
	 * Emails the person at their confirmed address, as a message from
	 * `session`; the same `id` again (a replayed tool call) sends nothing.
	 * Returns the address, or says why it can't.
	 */
	async send(mail: { id: string; session: string; subject: string; text: string }): Promise<{ to: string } | { error: string }> {
		const mailer = this.#mailer();
		const to = this.address();
		if (!mailer) return { error: "This Pim can't send email." };
		if (!to) return { error: "The person hasn't added an email address in Settings yet." };
		if (this.#store.emailSent(mail.id)) return { to };
		if (this.#store.emailsSince(today(), "messages") >= EMAILS_PER_DAY) {
			return { error: `Pim can email the person ${EMAILS_PER_DAY} times a day, and has today.` };
		}
		await mailer.send({ to, subject: mail.subject, text: mail.text });
		this.#store.recordEmail({ id: mail.id, session: mail.session, subject: mail.subject });
		return { to };
	}

	/** Forgets the address, and any waiting for a code. */
	remove(): EmailState {
		this.#store.deleteMeta(ADDRESS_KEY);
		this.#store.deleteMeta(PENDING_KEY);
		return this.state();
	}

	#pending(): Pending | null {
		const json = this.#store.meta(PENDING_KEY);
		if (json === undefined) return null;
		const pending = JSON.parse(json) as Pending;
		return pending.expiresAt > Date.now() ? pending : null;
	}
}
