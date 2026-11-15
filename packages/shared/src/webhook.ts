// Standard Webhooks (standardwebhooks.com) signing and checking, which Pim uses for deliveries from connectors.

/** Deliveries signed longer ago than this are refused (Standard Webhooks). */
const TOLERANCE_S = 300;

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

/** A fresh Standard Webhooks secret: `whsec_` and 32 random bytes. */
export function newSecret(): string {
	return `whsec_${base64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** Whether two byte strings are equal, taking as long for a near miss as for a match. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	let difference = 0;
	for (const [index, byte] of a.entries()) difference |= byte ^ b[index]!;
	return difference === 0;
}

/** The Standard Webhooks `v1` signature of a delivery. */
export async function signWebhook(secret: string, id: string, timestamp: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (char) => char.charCodeAt(0)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
	return `v1,${base64(new Uint8Array(signature))}`;
}

/** Checks a delivery's signature (any of the space-separated ones) and freshness. */
export async function verifyWebhook(secret: string, headers: Headers, body: string, nowSeconds: number): Promise<boolean> {
	const id = headers.get("webhook-id");
	const timestamp = headers.get("webhook-timestamp");
	const signatures = headers.get("webhook-signature");
	if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
	if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_S) return false;
	const expected = new TextEncoder().encode(await signWebhook(secret, id, timestamp, body));
	return signatures.split(" ").some((candidate) => {
		const given = new TextEncoder().encode(candidate);
		return given.length === expected.length && sameBytes(given, expected);
	});
}
