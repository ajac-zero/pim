import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

export type Alg = "EdDSA" | "ES256" | "RS256";
const COSE = { EdDSA: -8, ES256: -7, RS256: -257 } as const;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/** A software passkey: makes the registration and assertion JSON a browser's WebAuthn API hands the page. */
export class Authenticator {
	readonly id = b64(randomBytes(32));
	readonly #priv: KeyObject;
	readonly spki: string;
	constructor(readonly alg: Alg) {
		const pair = alg === "EdDSA" ? generateKeyPairSync("ed25519") : alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
		this.#priv = pair.privateKey;
		this.spki = b64(pair.publicKey.export({ type: "spki", format: "der" }));
	}

	#authData(rpId: string, flags: number, attested: boolean) {
		const head = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.alloc(4)]);
		if (!attested) return head;
		const id = Buffer.from(this.id, "base64url");
		return Buffer.concat([head, Buffer.alloc(16), Buffer.from([id.length >> 8, id.length & 255]), id, Buffer.from([0xa0])]);
	}

	create(options: { challenge: string; rp: { id: string } }, origin: string, overrides: { rpId?: string; flags?: number } = {}) {
		const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin }));
		return {
			id: this.id,
			clientDataJSON: b64(clientData),
			authenticatorData: b64(this.#authData(overrides.rpId ?? options.rp.id, overrides.flags ?? 0x45, true)),
			publicKey: this.spki,
			publicKeyAlgorithm: COSE[this.alg],
		};
	}

	get(options: { challenge: string; rpId: string }, origin: string, userHandle: string, overrides: { rpId?: string } = {}) {
		const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin }));
		const authData = this.#authData(overrides.rpId ?? options.rpId, 0x05, false);
		const signed = Buffer.concat([authData, sha256(clientData)]);
		const signature = this.alg === "EdDSA" ? sign(null, signed, this.#priv) : sign("sha256", signed, this.#priv);
		return { id: this.id, clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle };
	}
}
