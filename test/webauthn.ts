import { base64UrlEncode } from "../src/auth/encoding";

/** Where a passkey is made and used: the relying party's ID and the page's origin. */
export type Site = { readonly rpId: string; readonly origin: string };

export const PIM_TEST: Site = { rpId: "pim.test", origin: "https://pim.test" };

export type Tamper = {
	type?: string;
	origin?: string;
	rpId?: string;
	flags?: number;
	credentialId?: Uint8Array;
};

export const encoder = new TextEncoder();
const sha256 = async (bytes: Uint8Array) =>
	new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
export const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

/** r ‖ s as DER, the way authenticators sign ES256. */
export function rawToDer(raw: Uint8Array): Uint8Array {
	const integer = (bytes: Uint8Array) => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		let trimmed = bytes.slice(start);
		if ((trimmed[0] as number) & 0x80)
			trimmed = concat(new Uint8Array([0]), trimmed);
		return concat(new Uint8Array([0x02, trimmed.length]), trimmed);
	};
	const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return concat(new Uint8Array([0x30, body.length]), body);
}

/** A software passkey, standing in for a phone or a security key. */
export class Authenticator {
	id = crypto.getRandomValues(new Uint8Array(16));
	constructor(
		readonly algorithm: "ES256" | "Ed25519",
		readonly keys: CryptoKeyPair,
		readonly site: Site = PIM_TEST,
	) {}

	static async make(algorithm: "ES256" | "Ed25519" = "ES256", site: Site = PIM_TEST) {
		const keys = (await crypto.subtle.generateKey(
			algorithm === "ES256"
				? { name: "ECDSA", namedCurve: "P-256" }
				: { name: "Ed25519" },
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		return new Authenticator(algorithm, keys, site);
	}

	get credentialId() {
		return base64UrlEncode(this.id);
	}

	async #data(rpId: string, flags: number, attested?: Uint8Array) {
		const head = concat(
			await sha256(encoder.encode(rpId)),
			new Uint8Array([flags, 0, 0, 0, 0]),
		);
		if (!attested) return head;
		// aaguid, id length, id, then a COSE key the Worker doesn't read.
		return concat(
			head,
			new Uint8Array(16),
			new Uint8Array([0, attested.length]),
			attested,
			new Uint8Array([0xa0]),
		);
	}

	#clientData(type: string, challenge: string, origin: string) {
		return encoder.encode(JSON.stringify({ type, challenge, origin }));
	}

	async register(options: { challenge: string }, tamper: Tamper = {}) {
		const data = await this.#data(
			tamper.rpId ?? this.site.rpId,
			tamper.flags ?? 0x45,
			tamper.credentialId ?? this.id,
		);
		const spki = (await crypto.subtle.exportKey(
			"spki",
			this.keys.publicKey,
		)) as ArrayBuffer;
		return {
			id: this.credentialId,
			clientDataJSON: base64UrlEncode(
				this.#clientData(
					tamper.type ?? "webauthn.create",
					options.challenge,
					tamper.origin ?? this.site.origin,
				),
			),
			authenticatorData: base64UrlEncode(data),
			publicKey: base64UrlEncode(new Uint8Array(spki)),
			publicKeyAlgorithm: this.algorithm === "ES256" ? -7 : -8,
			name: "Test key",
		};
	}

	async sign(
		options: { challenge: string },
		tamper: Tamper = {},
		signer: Authenticator = this,
	) {
		const data = await this.#data(tamper.rpId ?? this.site.rpId, tamper.flags ?? 0x05);
		const clientData = this.#clientData(
			tamper.type ?? "webauthn.get",
			options.challenge,
			tamper.origin ?? this.site.origin,
		);
		const signed = concat(data, await sha256(clientData));
		const signature = new Uint8Array(
			await crypto.subtle.sign(
				signer.algorithm === "ES256"
					? { name: "ECDSA", hash: "SHA-256" }
					: "Ed25519",
				signer.keys.privateKey,
				signed,
			),
		);
		return {
			id: this.credentialId,
			clientDataJSON: base64UrlEncode(clientData),
			authenticatorData: base64UrlEncode(data),
			signature: base64UrlEncode(
				signer.algorithm === "ES256" ? rawToDer(signature) : signature,
			),
		};
	}
}


