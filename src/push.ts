/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm encryption
 * (RFC 8188, RFC 8291), on WebCrypto alone, so Pim can notify a phone or
 * browser whose app is closed.
 */

export type PushSubscription = {
	readonly endpoint: string;
	/** The browser's public ECDH key, base64url. */
	readonly p256dh: string;
	/** The browser's authentication secret, base64url. */
	readonly auth: string;
};

/** The deployment's VAPID key pair: the private half as a JWK, the public half as base64url of the raw point. */
export type VapidKeys = { readonly privateKey: JsonWebKey; readonly publicKey: string };

const encoder = new TextEncoder();

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (const byte of view) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
	const publicKey = toBase64Url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	return { privateKey: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey, publicKey };
}

/** A push service accepts only https endpoints. */
export function validSubscription(value: unknown): value is PushSubscription {
	if (typeof value !== "object" || value === null) return false;
	const { endpoint, p256dh, auth } = value as Record<string, unknown>;
	if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") return false;
	try {
		return new URL(endpoint).protocol === "https:" && fromBase64Url(p256dh).length === 65 && fromBase64Url(auth).length === 16;
	} catch {
		return false;
	}
}

async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
	const header = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = toBase64Url(
		encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
	);
	const key = await crypto.subtle.importKey("jwk", keys.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`));
	return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

async function hkdf(salt: Uint8Array, secret: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
	const key = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8);
	return new Uint8Array(bits);
}

/** The request body for one message: a single aes128gcm record (RFC 8291). */
export async function encryptPayload(subscription: PushSubscription, payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const browserKey = fromBase64Url(subscription.p256dh);
	const auth = fromBase64Url(subscription.auth);
	const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const ours = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const theirs = await crypto.subtle.importKey("raw", browserKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: theirs } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256));

	const secret = await hkdf(auth, shared, concat(encoder.encode("WebPush: info\0"), browserKey, ours), 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const contentKey = await crypto.subtle.importKey("raw", await hkdf(salt, secret, encoder.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["encrypt"]);
	const nonce = await hkdf(salt, secret, encoder.encode("Content-Encoding: nonce\0"), 12);
	// 0x02 marks the last (here the only) record.
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, contentKey, concat(payload, new Uint8Array([2]))));

	const recordSize = new Uint8Array(4);
	new DataView(recordSize.buffer).setUint32(0, 4096);
	return concat(salt, recordSize, new Uint8Array([ours.length]), ours, sealed);
}

/**
 * Sends one message. Returns false when the push service says the
 * subscription is gone (404 or 410), so the caller can forget it.
 */
export async function sendPush(subscription: PushSubscription, message: unknown, keys: VapidKeys, subject: string): Promise<boolean> {
	const response = await fetch(subscription.endpoint, {
		method: "POST",
		headers: {
			Authorization: await vapidAuthorization(subscription.endpoint, keys, subject),
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: "86400",
			Urgency: "normal",
		},
		body: await encryptPayload(subscription, encoder.encode(JSON.stringify(message))),
		signal: AbortSignal.timeout(10_000),
	});
	if (response.status === 404 || response.status === 410) return false;
	if (!response.ok) console.warn(`push service answered ${response.status}`);
	return true;
}
