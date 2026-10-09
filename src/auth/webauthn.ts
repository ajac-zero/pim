/**
 * Checks the two WebAuthn ceremonies, creating a passkey and signing in with
 * one, using only WebCrypto.
 *
 * Pim asks for no attestation: a new passkey is trusted because whoever
 * creates it is already signed in or holds a setup link. So the public key is
 * taken as the browser reports it (`getPublicKey()`, SPKI), and nothing here
 * needs to parse CBOR.
 *
 * See https://www.w3.org/TR/webauthn-3/#sctn-rp-operations
 */

import { base64UrlDecode } from "./encoding";

/** What this deployment expects a ceremony to be bound to. */
export type Ceremony = {
	/** The hostname passkeys belong to. */
	rpId: string;
	/** The page's origin, such as `https://pim.example.com`. */
	origin: string;
	/** The challenge the Worker issued, base64url. */
	challenge: string;
};

/** A created passkey, as the browser hands it over (binary fields base64url). */
export type Registration = {
	id: string;
	clientDataJSON: string;
	authenticatorData: string;
	publicKey: string;
	publicKeyAlgorithm: number;
};

/** A sign-in, as the browser hands it over (binary fields base64url). */
export type Assertion = {
	id: string;
	clientDataJSON: string;
	authenticatorData: string;
	signature: string;
};

/** What the Worker keeps to check a passkey's later sign-ins. */
export type PublicKey = { spki: string; algorithm: number };

const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;

/** COSE algorithms accepted, most preferred first. */
export const ALGORITHMS = [EDDSA, ES256, RS256];

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;

type AuthenticatorData = {
	rpIdHash: Uint8Array;
	flags: number;
	credentialId: Uint8Array | null;
};

function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData | null {
	// rpIdHash (32) ‖ flags (1) ‖ signCount (4) ‖ [aaguid (16) ‖ idLength (2) ‖ id ‖ key]
	if (bytes.length < 37) return null;
	const flags = bytes[32] as number;
	let credentialId: Uint8Array | null = null;
	if (flags & ATTESTED_CREDENTIAL) {
		if (bytes.length < 55) return null;
		const length = ((bytes[53] as number) << 8) | (bytes[54] as number);
		if (bytes.length < 55 + length) return null;
		credentialId = bytes.slice(55, 55 + length);
	}
	return { rpIdHash: bytes.slice(0, 32), flags, credentialId };
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
	);
}

function clientDataMatches(
	bytes: Uint8Array,
	type: "webauthn.create" | "webauthn.get",
	ceremony: Ceremony,
): boolean {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return false;
	}
	return (
		data.type === type &&
		data.challenge === ceremony.challenge &&
		data.origin === ceremony.origin &&
		// Set when the ceremony ran in a frame from another origin.
		data.crossOrigin !== true
	);
}

/** For this site, with the person present and verified (PIN, biometrics). */
async function authenticatorDataMatches(
	data: AuthenticatorData,
	ceremony: Ceremony,
): Promise<boolean> {
	const expected = await sha256(new TextEncoder().encode(ceremony.rpId));
	const required = USER_PRESENT | USER_VERIFIED;
	return equal(data.rpIdHash, expected) && (data.flags & required) === required;
}

function importKey(key: PublicKey): Promise<CryptoKey> {
	const spki = base64UrlDecode(key.spki);
	switch (key.algorithm) {
		case ES256:
			return crypto.subtle.importKey(
				"spki",
				spki,
				{ name: "ECDSA", namedCurve: "P-256" },
				false,
				["verify"],
			);
		case EDDSA:
			return crypto.subtle.importKey("spki", spki, "Ed25519", false, [
				"verify",
			]);
		case RS256:
			return crypto.subtle.importKey(
				"spki",
				spki,
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"],
			);
		default:
			throw new Error(`Unsupported algorithm ${key.algorithm}`);
	}
}

/**
 * Authenticators sign ES256 as DER, `SEQUENCE { INTEGER r, INTEGER s }`;
 * WebCrypto wants r ‖ s, 32 bytes each.
 */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
	if (der[0] !== 0x30 || der[1] !== der.length - 2) return null;
	const raw = new Uint8Array(64);
	let offset = 2;
	for (const half of [0, 32]) {
		if (der[offset] !== 0x02) return null;
		const length = der[offset + 1] as number;
		let integer = der.subarray(offset + 2, offset + 2 + length);
		if (integer.length !== length) return null;
		// DER pads with a zero byte when the top bit is set.
		while (integer.length > 32 && integer[0] === 0)
			integer = integer.subarray(1);
		if (integer.length > 32) return null;
		raw.set(integer, half + 32 - integer.length);
		offset += 2 + length;
	}
	return offset === der.length ? raw : null;
}

/** The public key of a passkey made for this ceremony, or null. */
export async function verifyRegistration(
	registration: Registration,
	ceremony: Ceremony,
): Promise<PublicKey | null> {
	try {
		const clientData = base64UrlDecode(registration.clientDataJSON);
		if (!clientDataMatches(clientData, "webauthn.create", ceremony)) {
			return null;
		}
		const data = parseAuthenticatorData(
			base64UrlDecode(registration.authenticatorData),
		);
		if (!data?.credentialId) return null;
		if (!(await authenticatorDataMatches(data, ceremony))) return null;
		if (!equal(data.credentialId, base64UrlDecode(registration.id))) {
			return null;
		}
		if (!ALGORITHMS.includes(registration.publicKeyAlgorithm)) return null;
		const key = {
			spki: registration.publicKey,
			algorithm: registration.publicKeyAlgorithm,
		};
		await importKey(key); // Throws on a key that isn't one.
		return key;
	} catch {
		return null;
	}
}

/** Whether `assertion` is `key`'s signature over this ceremony. */
export async function verifyAssertion(
	assertion: Assertion,
	key: PublicKey,
	ceremony: Ceremony,
): Promise<boolean> {
	try {
		const clientData = base64UrlDecode(assertion.clientDataJSON);
		if (!clientDataMatches(clientData, "webauthn.get", ceremony)) return false;
		const authenticatorData = base64UrlDecode(assertion.authenticatorData);
		const data = parseAuthenticatorData(authenticatorData);
		if (!data || !(await authenticatorDataMatches(data, ceremony))) {
			return false;
		}

		const signed = new Uint8Array(authenticatorData.length + 32);
		signed.set(authenticatorData);
		signed.set(await sha256(clientData), authenticatorData.length);
		let signature: Uint8Array<ArrayBuffer> | null = base64UrlDecode(
			assertion.signature,
		);
		if (key.algorithm === ES256) signature = derToRaw(signature);
		if (!signature) return false;

		const algorithm =
			key.algorithm === ES256
				? { name: "ECDSA", hash: "SHA-256" }
				: key.algorithm === EDDSA
					? "Ed25519"
					: "RSASSA-PKCS1-v1_5";
		return await crypto.subtle.verify(
			algorithm,
			await importKey(key),
			signature,
			signed,
		);
	} catch {
		return false;
	}
}
