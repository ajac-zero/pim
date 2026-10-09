import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_NAME } from "../src/agent";
import type { Auth } from "../src/auth";
import { base64UrlDecode, base64UrlEncode } from "../src/auth/encoding";
import { derToRaw } from "../src/auth/webauthn";
import worker from "../src/index";
import { TOKEN, url } from "./helpers";
import type { Pim } from "./worker";

const ORIGIN = "https://pim.test";
const RP_ID = "pim.test";

// Tests in a file share storage: every test starts with a Pim that never had a passkey.
beforeEach(async () => {
	await runInDurableObject(env.Auth.getByName("auth"), async (_instance: Auth, state) => {
		state.storage.sql.exec("DELETE FROM auth_passkeys");
		state.storage.sql.exec("DELETE FROM auth_meta WHERE key != 'cookie_key'");
	});
});

/** This Worker as deployed `ago` milliseconds before now. */
function deployed(ago: number): Env {
	return { ...env, CF_VERSION_METADATA: { ...env.CF_VERSION_METADATA, timestamp: new Date(Date.now() - ago).toISOString() } };
}

/** Long enough after the deploy that a first passkey needs a setup link. */
const settled = deployed(24 * 60 * 60 * 1000);

afterEach(() => {
	vi.useRealTimers();
});

/** One browser: keeps the cookies the Worker sets, sends them back. */
class Browser {
	cookies = new Map<string, string>();

	constructor(readonly env: Env = settled) {}

	async fetch(path: string, init: RequestInit & { json?: unknown } = {}) {
		const headers = new Headers(init.headers);
		if (!headers.has("origin") && init.method && init.method !== "GET") headers.set("origin", ORIGIN);
		if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		if (init.json !== undefined) headers.set("content-type", "application/json");
		const request = new Request(url(path), { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) });
		const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, this.env);
		for (const cookie of response.headers.getSetCookie()) {
			const [pair = "", ...attributes] = cookie.split("; ");
			const [name = "", ...value] = pair.split("=");
			if (attributes.includes("Max-Age=0")) this.cookies.delete(name);
			else this.cookies.set(name, value.join("="));
		}
		return response;
	}

	/** Whether this browser gets into the agent's API. */
	async signedIn() {
		return (await this.fetch("/api/sessions")).status === 200;
	}
}

/**
 * Asks for a setup link, as the sign-in screen does, and reads its code from
 * the Worker's logs, as the account's owner does in the dashboard.
 */
async function setupLink(): Promise<string> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		const response = await new Browser().fetch("/auth/setup-link", { method: "POST" });
		expect(response.status).toBe(200);
		const line = String(log.mock.calls.findLast((call) => String(call[0]).includes("#setup="))?.[0]);
		const code = /\/#setup=([\w-]+)/.exec(line)?.[1] as string;
		expect(line).toContain(`${ORIGIN}/#setup=`);
		// The answer itself never carries the code.
		expect(await response.text()).not.toContain(code);
		return code;
	} finally {
		log.mockRestore();
	}
}

type Tamper = {
	type?: string;
	origin?: string;
	rpId?: string;
	flags?: number;
	credentialId?: Uint8Array;
};

const encoder = new TextEncoder();
const sha256 = async (bytes: Uint8Array) =>
	new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

/** r ‖ s as DER, the way authenticators sign ES256. */
function rawToDer(raw: Uint8Array): Uint8Array {
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
class Authenticator {
	id = crypto.getRandomValues(new Uint8Array(16));
	constructor(
		readonly algorithm: "ES256" | "Ed25519",
		readonly keys: CryptoKeyPair,
	) {}

	static async make(algorithm: "ES256" | "Ed25519" = "ES256") {
		const keys = (await crypto.subtle.generateKey(
			algorithm === "ES256"
				? { name: "ECDSA", namedCurve: "P-256" }
				: { name: "Ed25519" },
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		return new Authenticator(algorithm, keys);
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
			tamper.rpId ?? RP_ID,
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
					tamper.origin ?? ORIGIN,
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
		const data = await this.#data(tamper.rpId ?? RP_ID, tamper.flags ?? 0x05);
		const clientData = this.#clientData(
			tamper.type ?? "webauthn.get",
			options.challenge,
			tamper.origin ?? ORIGIN,
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


async function addPasskey(browser: Browser, authenticator: Authenticator, setup?: string) {
	const options = await browser.fetch("/auth/passkeys/options", { method: "POST", json: setup ? { setup } : {} });
	expect(options.status).toBe(200);
	const response = await browser.fetch("/auth/passkeys", { method: "POST", json: await authenticator.register(await options.json()) });
	expect(response.status).toBe(200);
}

async function signIn(browser: Browser, authenticator: Authenticator, tamper?: Tamper, signer?: Authenticator) {
	const options = await browser.fetch("/auth/sign-in/options", { method: "POST" });
	return browser.fetch("/auth/sign-in", { method: "POST", json: await authenticator.sign(await options.json(), tamper, signer) });
}

/** A browser signed in with a passkey made from a setup link. */
async function signedInBrowser() {
	const passkey = await Authenticator.make();
	const browser = new Browser();
	await addPasskey(browser, passkey, await setupLink());
	return { browser, passkey };
}

describe("claiming a fresh Pim", () => {
	it("lets the first visitor create the first passkey right after a deploy, with no link", async () => {
		const browser = new Browser(deployed(60 * 1000));
		expect(await (await browser.fetch("/auth/session")).json()).toMatchObject({ signedIn: false, hasPasskeys: false, canClaim: true });

		await addPasskey(browser, await Authenticator.make());

		expect(await browser.signedIn()).toBe(true);
		const next = new Browser(deployed(60 * 1000));
		expect(await (await next.fetch("/auth/session")).json()).toMatchObject({ hasPasskeys: true, canClaim: false });
		expect((await next.fetch("/auth/passkeys/options", { method: "POST", json: {} })).status).toBe(401);
	});

	it("closes the window 15 minutes after the deploy", async () => {
		const open = new Browser(deployed(14 * 60 * 1000));
		expect(await (await open.fetch("/auth/session")).json()).toMatchObject({ canClaim: true });
		const late = new Browser(deployed(16 * 60 * 1000));
		expect(await (await late.fetch("/auth/session")).json()).toMatchObject({ canClaim: false });
		expect((await late.fetch("/auth/passkeys/options", { method: "POST", json: {} })).status).toBe(401);
	});

	it("never reopens once claimed, even after removing every passkey and deploying again", async () => {
		const owner = new Browser(deployed(60 * 1000));
		const passkey = await Authenticator.make();
		await addPasskey(owner, passkey);
		await owner.fetch(`/auth/passkeys/${encodeURIComponent(passkey.credentialId)}`, { method: "DELETE" });

		const stranger = new Browser(deployed(0));
		expect(await (await stranger.fetch("/auth/session")).json()).toMatchObject({ hasPasskeys: false, canClaim: false });
		expect((await stranger.fetch("/auth/passkeys/options", { method: "POST", json: {} })).status).toBe(401);
		// The owner gets back in with a setup link from the logs.
		await addPasskey(new Browser(), await Authenticator.make(), await setupLink());
	});

	it("lets only one of two visitors in the window claim it", async () => {
		const visitors = [new Browser(deployed(60 * 1000)), new Browser(deployed(60 * 1000))];
		const challenges: { challenge: string }[] = [];
		for (const visitor of visitors) {
			const options = await visitor.fetch("/auth/passkeys/options", { method: "POST", json: {} });
			expect(options.status).toBe(200);
			challenges.push((await options.json()) as { challenge: string });
		}
		const statuses = [];
		for (const [i, visitor] of visitors.entries()) {
			const response = await visitor.fetch("/auth/passkeys", {
				method: "POST",
				json: await (await Authenticator.make()).register(challenges[i] as { challenge: string }),
			});
			statuses.push(response.status);
		}
		expect(statuses).toEqual([200, 401]);
		expect(await visitors[1]?.signedIn()).toBe(false);
	});

	it("is closed when the deploy time is unknown", async () => {
		const unknown = new Browser({ ...env, CF_VERSION_METADATA: { ...env.CF_VERSION_METADATA, timestamp: "" } });
		expect(await (await unknown.fetch("/auth/session")).json()).toMatchObject({ canClaim: false });
	});
});

describe("setting up with a link", () => {
	it("creates the first passkey from a setup link, which signs this browser in to the API", async () => {
		const browser = new Browser();
		expect(await (await browser.fetch("/auth/session")).json()).toMatchObject({ signedIn: false, hasPasskeys: false });
		expect(await browser.signedIn()).toBe(false);

		await addPasskey(browser, await Authenticator.make(), await setupLink());

		expect(await (await browser.fetch("/auth/session")).json()).toMatchObject({ signedIn: true, method: "passkey", hasPasskeys: true });
		expect(await browser.signedIn()).toBe(true);
	});

	it("refuses to start a passkey without a valid setup link or a session", async () => {
		const browser = new Browser();
		const start = (json: unknown) => browser.fetch("/auth/passkeys/options", { method: "POST", json });
		// No link asked for yet: nothing is valid, not even an empty code.
		expect((await start({ setup: "" })).status).toBe(401);

		const code = await setupLink();
		for (const json of [{}, { setup: "" }, { setup: `${code}x` }, { setup: code.slice(0, -1) }, { token: TOKEN }]) {
			expect((await start(json)).status).toBe(401);
		}
	});

	it("logs the same link until it expires, then a new one", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const first = await setupLink();
		expect(await setupLink()).toBe(first);

		vi.setSystemTime(Date.now() + 61 * 60 * 1000);
		const start = await new Browser().fetch("/auth/passkeys/options", { method: "POST", json: { setup: first } });
		expect(start.status).toBe(401);
		const second = await setupLink();
		expect(second).not.toBe(first);
		await addPasskey(new Browser(), await Authenticator.make(), second);
	});

	it("uses a setup link once", async () => {
		const code = await setupLink();
		await addPasskey(new Browser(), await Authenticator.make(), code);
		const again = await new Browser().fetch("/auth/passkeys/options", { method: "POST", json: { setup: code } });
		expect(again.status).toBe(401);
		// Asking again gives a fresh link: how you recover a lost passkey.
		expect(await setupLink()).not.toBe(code);
	});

	it("lets only one of two tabs that opened the same link finish", async () => {
		const code = await setupLink();
		const tabs = [new Browser(), new Browser()];
		const challenges: { challenge: string }[] = [];
		for (const tab of tabs) {
			const options = await tab.fetch("/auth/passkeys/options", { method: "POST", json: { setup: code } });
			challenges.push((await options.json()) as { challenge: string });
		}
		const statuses = [];
		for (const [i, tab] of tabs.entries()) {
			const response = await tab.fetch("/auth/passkeys", {
				method: "POST",
				json: await (await Authenticator.make()).register(challenges[i] as { challenge: string }),
			});
			statuses.push(response.status);
		}
		expect(statuses).toEqual([200, 401]);
		expect(await tabs[1]?.signedIn()).toBe(false);
	});

	it("lets a signed-in browser add a passkey without a link", async () => {
		const { browser } = await signedInBrowser();
		const phone = await Authenticator.make();
		await addPasskey(browser, phone);
		expect((await signIn(new Browser(), phone)).status).toBe(200);
	});

	it("refuses a passkey started as a sign-in, which anyone can start", async () => {
		const browser = new Browser();
		const options = await browser.fetch("/auth/sign-in/options", { method: "POST" });
		const response = await browser.fetch("/auth/passkeys", { method: "POST", json: await (await Authenticator.make()).register(await options.json()) });
		expect(response.status).toBe(400);
		expect(await browser.signedIn()).toBe(false);
	});

	it.each<[string, Tamper]>([
		["for another site", { rpId: "evil.example.com" }],
		["from another origin", { origin: "https://evil.example.com" }],
		["without verifying the person", { flags: 0x41 }],
		["whose id isn't the one the authenticator made", { credentialId: new Uint8Array(16) }],
		["from a sign-in ceremony", { type: "webauthn.get" }],
	])("refuses a passkey made %s", async (_case, tamper) => {
		const browser = new Browser();
		const options = await browser.fetch("/auth/passkeys/options", { method: "POST", json: { setup: await setupLink() } });
		const response = await browser.fetch("/auth/passkeys", { method: "POST", json: await (await Authenticator.make()).register(await options.json(), tamper) });
		expect(response.status).toBe(400);
		expect(await browser.signedIn()).toBe(false);
		expect(await (await browser.fetch("/auth/session")).json()).toMatchObject({ hasPasskeys: false });
	});
});

describe("signing in", () => {
	it.each(["ES256", "Ed25519"] as const)("signs a new browser in with an %s passkey", async (algorithm) => {
		const passkey = await Authenticator.make(algorithm);
		await addPasskey(new Browser(), passkey, await setupLink());
		const browser = new Browser();
		expect((await signIn(browser, passkey)).status).toBe(200);
		expect(await browser.signedIn()).toBe(true);
	});

	it.each<[string, Tamper]>([
		["for another site", { rpId: "evil.example.com" }],
		["from another origin", { origin: "https://evil.example.com" }],
		["without verifying the person", { flags: 0x01 }],
		["from a creation ceremony", { type: "webauthn.create" }],
	])("refuses a sign-in %s", async (_case, tamper) => {
		const { passkey } = await signedInBrowser();
		const browser = new Browser();
		expect((await signIn(browser, passkey, tamper)).status).toBe(401);
		expect(await browser.signedIn()).toBe(false);
	});

	it("refuses a signature from a key other than the passkey's", async () => {
		const { passkey } = await signedInBrowser();
		const browser = new Browser();
		expect((await signIn(browser, passkey, {}, await Authenticator.make())).status).toBe(401);
		expect(await browser.signedIn()).toBe(false);
	});

	it("refuses a passkey this Pim never saw", async () => {
		await signedInBrowser();
		expect((await signIn(new Browser(), await Authenticator.make())).status).toBe(401);
	});

	it("refuses a signature over a challenge this browser wasn't given", async () => {
		const { passkey } = await signedInBrowser();
		const browser = new Browser();
		await browser.fetch("/auth/sign-in/options", { method: "POST" });
		const other = await new Browser().fetch("/auth/sign-in/options", { method: "POST" });
		const response = await browser.fetch("/auth/sign-in", { method: "POST", json: await passkey.sign(await other.json()) });
		expect(response.status).toBe(401);
	});
});

describe("sessions", () => {
	it("end when their passkey is removed, but not when another one is", async () => {
		const { browser: laptop, passkey } = await signedInBrowser();
		const phone = await Authenticator.make();
		await addPasskey(laptop, phone);
		const phoneBrowser = new Browser();
		await signIn(phoneBrowser, phone);

		const removed = await phoneBrowser.fetch(`/auth/passkeys/${encodeURIComponent(passkey.credentialId)}`, { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect(await laptop.signedIn()).toBe(false);
		expect(await phoneBrowser.signedIn()).toBe(true);

		const list = (await (await phoneBrowser.fetch("/auth/passkeys")).json()) as { passkeys: { id: string }[] };
		expect(list.passkeys.map((p) => p.id)).toEqual([phone.credentialId]);
	});

	it("list and remove passkeys only for someone signed in", async () => {
		const { passkey } = await signedInBrowser();
		const stranger = new Browser();
		expect((await stranger.fetch("/auth/passkeys")).status).toBe(401);
		expect((await stranger.fetch(`/auth/passkeys/${passkey.credentialId}`, { method: "DELETE" })).status).toBe(401);
	});

	it("end on sign-out", async () => {
		const { browser } = await signedInBrowser();
		await browser.fetch("/auth/sign-out", { method: "POST" });
		expect(await browser.signedIn()).toBe(false);
	});

	it("last 30 days", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { browser } = await signedInBrowser();
		vi.setSystemTime(Date.now() + 29 * 24 * 3600 * 1000);
		expect(await browser.signedIn()).toBe(true);
		vi.setSystemTime(Date.now() + 2 * 24 * 3600 * 1000);
		expect(await browser.signedIn()).toBe(false);
	});

	it("refuse an edited session cookie", async () => {
		const { browser } = await signedInBrowser();
		const name = "__Host-pim-session";
		const [body, mac] = (browser.cookies.get(name) as string).split(".");
		const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body as string)));
		payload.exp += 365 * 24 * 3600;
		browser.cookies.set(name, `${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}.${mac}`);
		expect(await browser.signedIn()).toBe(false);
	});

	it("can't be used by other sites for writes or sockets", async () => {
		const { browser } = await signedInBrowser();
		const evil = await browser.fetch("/api/sessions", { method: "POST", headers: { origin: "https://evil.example.com" }, json: {} });
		expect(evil.status).toBe(403);
		const socketWithoutOrigin = await browser.fetch("/api/ws?session=1", { headers: { upgrade: "websocket" } });
		expect(socketWithoutOrigin.status).toBe(403);
		const socket = await browser.fetch("/api/ws?session=1", { headers: { upgrade: "websocket", origin: ORIGIN } });
		expect(socket.status).toBe(101);
		socket.webSocket?.accept();
		socket.webSocket?.close();
	});
});

describe("the agent behind a passkey session", () => {
	it("learns the address the owner uses, for apps' callbacks", async () => {
		const { browser } = await signedInBrowser();
		await runInDurableObject(env.Pim.getByName(AGENT_NAME), async (instance: Pim) => instance.store.setMeta("public_origin", "https://old.example"));
		expect(await browser.signedIn()).toBe(true);
		const origin = await runInDurableObject(env.Pim.getByName(AGENT_NAME), async (instance: Pim) => instance.store.meta("public_origin"));
		expect(origin).toBe(ORIGIN);
	});
});

describe("the API token", () => {
	it("still works for other clients, from anywhere, and alongside passkeys", async () => {
		await signedInBrowser();
		const response = await exports.default.fetch(url("/api/sessions"), {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, origin: "https://bot.example", "content-type": "application/json" },
			body: "{}",
		});
		expect(response.status).toBe(200);
	});

	it("is optional: without one set, only passkey sessions get in", async () => {
		const { browser } = await signedInBrowser();
		const noToken = { ...env, PIM_API_TOKEN: undefined };
		const call = (headers: Record<string, string>) =>
			worker.fetch(new Request(url("/api/sessions"), { headers }) as Request<unknown, IncomingRequestCfProperties>, noToken);
		expect((await call({ Authorization: `Bearer ${TOKEN}` })).status).toBe(401);
		expect((await call({ Authorization: "Bearer " })).status).toBe(401);
		const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
		expect((await call({ cookie })).status).toBe(200);
	});
});

describe("derToRaw", () => {
	it("drops DER's sign padding and restores short integers' leading zeros", () => {
		const r = new Uint8Array(32).fill(0x81); // top bit set: DER pads it
		const s = new Uint8Array(32).fill(0x22);
		s[0] = 0; // a leading zero DER leaves out
		const raw = concat(r, s);
		expect(derToRaw(rawToDer(raw))).toEqual(raw);
		expect(rawToDer(raw).length).toBe(2 + (2 + 33) + (2 + 31));
	});

	it("refuses integers longer than the curve", () => {
		const long = new Uint8Array([0x30, 70, 0x02, 33, ...new Uint8Array(33).fill(1), 0x02, 33, ...new Uint8Array(33).fill(1)]);
		expect(derToRaw(long)).toBeNull();
	});
});
