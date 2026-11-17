// A software passkey for the rehearsal: registers with the legacy Worker and signs in to the new stack with the same key, so passkey continuity is proved by a real assertion.
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const b64 = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

export class Passkey {
	constructor(id, privatePkcs8, spki) {
		this.id = id;
		this.priv = createPrivateKey({ key: Buffer.from(privatePkcs8, "base64"), format: "der", type: "pkcs8" });
		this.privatePkcs8 = privatePkcs8;
		this.spki = spki;
	}
	static make() {
		const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
		return new Passkey(b64(randomBytes(32)), pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), b64(pair.publicKey.export({ type: "spki", format: "der" })));
	}
	/** Rebuilds a key from what a rehearsal's expectations file kept. */
	static from(saved) {
		return new Passkey(saved.id, saved.privatePkcs8, saved.spki);
	}
	save() {
		return { id: this.id, privatePkcs8: this.privatePkcs8, spki: this.spki };
	}
	#authData(rpId, flags, attested) {
		const head = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.alloc(4)]);
		if (!attested) return head;
		const id = Buffer.from(this.id, "base64url");
		return Buffer.concat([head, Buffer.alloc(16), Buffer.from([id.length >> 8, id.length & 255]), id, Buffer.from([0xa0])]);
	}
	create(options, origin, name = "Rehearsal key") {
		const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin }));
		return { id: this.id, clientDataJSON: b64(clientData), authenticatorData: b64(this.#authData(options.rp.id, 0x45, true)), publicKey: this.spki, publicKeyAlgorithm: -7, name };
	}
	get(options, origin, userHandle) {
		const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin }));
		const authData = this.#authData(options.rpId, 0x05, false);
		return { id: this.id, clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.priv)), userHandle };
	}
}
