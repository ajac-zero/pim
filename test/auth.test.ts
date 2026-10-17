import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pim } from "../src/pim";
import { userHandle } from "../src/auth";
import { base64UrlDecode, base64UrlEncode } from "../src/auth/encoding";
import { derToRaw } from "../src/auth/webauthn";
import type { Directory } from "../src/directory";
import worker from "../src/index";
import { Authenticator, concat, encoder, rawToDer, type Tamper } from "./webauthn";

const ORIGIN = "https://pim.test";
const url = (path: string) => `${ORIGIN}${path}`;

// Tests in a file share storage: every test starts with a Pim that has no accounts and no admin.
beforeEach(async () => {
	await runInDurableObject(env.Directory.getByName("directory"), async (_instance: Directory, state) => {
		for (const table of ["accounts", "registrations", "invites", "cleanups", "identities"]) state.storage.sql.exec(`DELETE FROM ${table}`);
		state.storage.sql.exec("DELETE FROM directory_meta WHERE key NOT IN ('cookie_key', 'salt')");
	});
});

/** This Worker as deployed `ago` milliseconds before now. */
function deployed(ago: number, vars: Partial<Env> = {}): Env {
	return { ...env, ...vars, CF_VERSION_METADATA: { ...env.CF_VERSION_METADATA, timestamp: new Date(Date.now() - ago).toISOString() } };
}

/** Long enough after the deploy that nobody can claim the Pim without the link from the logs. */
const settled = deployed(24 * 60 * 60 * 1000);
/** Right after a deploy: whoever registers first becomes the admin. */
const fresh = () => deployed(60 * 1000);

afterEach(() => {
	vi.useRealTimers();
});

let addresses = 0;

/** One browser, from its own address: keeps the cookies the Worker sets, sends them back. */
class Browser {
	cookies = new Map<string, string>();
	readonly ip = `203.0.113.${++addresses % 250}`;

	constructor(readonly env: Env = settled) {}

	async fetch(path: string, init: RequestInit & { json?: unknown } = {}) {
		const headers = new Headers(init.headers);
		if (!headers.has("origin") && init.method && init.method !== "GET") headers.set("origin", ORIGIN);
		if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		if (init.json !== undefined) headers.set("content-type", "application/json");
		headers.set("CF-Connecting-IP", this.ip);
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

	async json<T = any>(path: string, init: RequestInit & { json?: unknown } = {}) {
		const response = await this.fetch(path, init);
		return { status: response.status, body: (await response.json()) as T };
	}

	/** Whether this browser gets into a Pim's API, and whose. */
	async signedIn() {
		return (await this.fetch("/api/sessions")).status === 200;
	}
}

type Registered = { username: string; role: string; setup: string; recoveryCodes: string[] };

async function register(browser: Browser, username: string, extra: Record<string, unknown> = {}) {
	return browser.json<Registered & { error?: string }>("/auth/register", { method: "POST", json: { username, ...extra } });
}

async function addPasskey(browser: Browser, authenticator: Authenticator, allowedBy: Record<string, string> = {}) {
	const options = await browser.fetch("/auth/passkeys/options", { method: "POST", json: allowedBy });
	if (options.status !== 200) return options.status;
	return (await browser.fetch("/auth/passkeys", { method: "POST", json: await authenticator.register(await options.json()) })).status;
}

async function signIn(browser: Browser, authenticator: Authenticator, tamper?: Tamper, signer?: Authenticator) {
	const options = await browser.fetch("/auth/sign-in/options", { method: "POST" });
	return browser.fetch("/auth/sign-in", { method: "POST", json: await authenticator.sign(await options.json(), tamper, signer) });
}

/** Someone who registered and made their first passkey: the admin right after a deploy, then members. */
async function person(username: string, deployment: Env = settled, extra: Record<string, unknown> = {}) {
	const browser = new Browser(deployment);
	const registered = await register(browser, username, extra);
	expect(registered.status).toBe(201);
	const passkey = await Authenticator.make();
	expect(await addPasskey(browser, passkey, { setup: registered.body.setup })).toBe(200);
	const account = (await browser.json<{ ownerId: string; role: string }>("/api/account")).body;
	return { browser, passkey, registered: registered.body, owner: account.ownerId, role: account.role };
}

const admin = () => person("ana", fresh());

/**
 * Asks for a setup link, as the sign-in screen does, and reads it from the
 * Worker's logs, as the person running the Pim does in the dashboard.
 */
async function setupLink(deployment: Env = settled): Promise<{ claim?: string; setup?: string }> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		const response = await new Browser(deployment).fetch("/auth/setup-link", { method: "POST" });
		expect(response.status).toBe(200);
		const line = String(log.mock.calls.findLast((call) => /#(claim|setup)=/.test(String(call[0])))?.[0]);
		expect(line).toContain(`${ORIGIN}/#`);
		const [, kind, code] = /\/#(claim|setup)=([\w.-]+)/.exec(line) ?? [];
		// The answer itself never carries the code.
		expect(await response.text()).not.toContain(code);
		return { [kind as string]: code };
	} finally {
		log.mockRestore();
	}
}

describe("claiming a fresh Pim", () => {
	it("makes whoever registers first, right after a deploy, its admin", async () => {
		const browser = new Browser(fresh());
		expect((await browser.json("/auth/session")).body).toMatchObject({ signedIn: false, claimed: false, canClaim: true });

		const first = await person("ana", fresh());
		expect(first.role).toBe("admin");
		expect(await first.browser.signedIn()).toBe(true);

		expect((await new Browser(fresh()).json("/auth/session")).body).toMatchObject({ claimed: true, canClaim: false });
		// The next person is a member.
		expect((await person("ben", fresh())).role).toBe("member");
	});

	it("closes the window 15 minutes after the deploy", async () => {
		expect((await new Browser(deployed(14 * 60 * 1000)).json("/auth/session")).body).toMatchObject({ canClaim: true });
		const late = new Browser(deployed(16 * 60 * 1000));
		expect((await late.json("/auth/session")).body).toMatchObject({ canClaim: false });
		expect((await register(late, "ana")).status).toBe(403);
	});

	it("is closed when the deploy time is unknown", async () => {
		const unknown = new Browser({ ...env, CF_VERSION_METADATA: { ...env.CF_VERSION_METADATA, timestamp: "" } });
		expect((await unknown.json("/auth/session")).body).toMatchObject({ canClaim: false });
		expect((await register(unknown, "ana")).status).toBe(403);
	});

	it("can be claimed later with the link from the logs, once", async () => {
		const { claim } = await setupLink();
		expect(claim).toBeDefined();
		expect((await register(new Browser(), "ana", { claim: `${claim}x` })).status).toBe(403);
		const ana = await person("ana", settled, { claim });
		expect(ana.role).toBe("admin");
		// Used: it makes no second admin, and nobody else gets in without an invite or open registration.
		expect((await register(new Browser(deployed(0, { PIM_REGISTRATION: "invite" })), "ben", { claim })).status).toBe(403);
	});

	it("makes only one of two people in the window its admin", async () => {
		const [first, second] = await Promise.all([register(new Browser(fresh()), "ana"), register(new Browser(fresh()), "ben")]);
		expect([first.body.role, second.body.role].sort()).toEqual(["admin", "member"]);
	});

	it("can be claimed again when the admin's registration lapses without a passkey", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		expect((await register(new Browser(fresh()), "ana")).body.role).toBe("admin");
		vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
		expect((await new Browser(fresh()).json("/auth/session")).body).toMatchObject({ claimed: false });
		expect((await register(new Browser(fresh()), "ben")).body.role).toBe("admin");
	});

	it("gives the admin no limits, and members the deployment's", async () => {
		const ana = await person("ana", fresh());
		const ben = await person("ben", fresh());
		// As if the deployment set PIM_LIMITS.
		const dailyRuns = (owner: string) =>
			runInDurableObject(env.Pim.getByName(owner), (instance: Pim) => {
				const deployment = (instance as unknown as { env: { PIM_LIMITS: string } }).env;
				const before = deployment.PIM_LIMITS;
				deployment.PIM_LIMITS = '{"dailyRuns": 5}';
				try {
					return instance.limits().dailyRuns;
				} finally {
					deployment.PIM_LIMITS = before;
				}
			});
		expect(await dailyRuns(ana.owner)).toBeNull();
		expect(await dailyRuns(ben.owner)).toBe(5);
	});
});

describe("joining", () => {
	it("takes an invite the admin made, once, when registration needs one", async () => {
		const ana = await admin();
		const invites = await ana.browser.json("/api/admin/invites", { method: "POST", json: { count: 1 } });
		expect(invites.status).toBe(201);
		const [link] = invites.body.links as string[];
		expect(link).toMatch(/^https:\/\/pim\.test\/#invite=inv_[\w-]+$/);
		const invite = link!.split("#invite=")[1];

		const byInvite = deployed(24 * 60 * 60 * 1000, { PIM_REGISTRATION: "invite" });
		expect((await register(new Browser(byInvite), "ben")).status).toBe(403);
		expect((await person("ben", byInvite, { invite })).role).toBe("member");
		expect((await register(new Browser(byInvite), "cai", { invite })).status).toBe(403);
	});

	it("refuses taken, reserved and malformed usernames", async () => {
		await admin();
		const browser = new Browser();
		expect((await register(browser, "ana")).status).toBe(409);
		for (const name of ["pim", "admin", "ab", "Has Space", "-dash", "a--b"]) expect((await register(new Browser(), name)).status).toBe(400);
		expect((await browser.json("/auth/username?name=ana")).body).toEqual({ available: false, reason: "That username is taken." });
		expect((await browser.json("/auth/username?name=someone")).body).toEqual({ available: true });
	});
});

describe("setting up with a link", () => {
	it("makes the first passkey from registration's setup link, which signs this browser in", async () => {
		const browser = new Browser(fresh());
		const { body } = await register(browser, "ana");
		expect(body.setup).toMatch(/^o_[0-9a-z]{26}\.[\w-]+$/);
		expect(body.recoveryCodes).toHaveLength(10);
		expect(await browser.signedIn()).toBe(false);

		expect(await addPasskey(browser, await Authenticator.make(), { setup: body.setup })).toBe(200);
		expect((await browser.json("/auth/session")).body).toMatchObject({ signedIn: true, method: "passkey", account: { username: "ana", role: "admin" } });
		expect(await browser.signedIn()).toBe(true);
	});

	it("refuses to start a passkey without a valid link or a session", async () => {
		const browser = new Browser(fresh());
		const { setup } = (await register(browser, "ana")).body;
		const [owner, code] = setup.split(".") as [string, string];
		for (const json of [{}, { setup: "" }, { setup: code }, { setup: `${setup}x` }, { setup: `${owner}.${code.slice(0, -1)}` }, { setup: `o_${"0".repeat(26)}.${code}` }]) {
			expect((await browser.fetch("/auth/passkeys/options", { method: "POST", json })).status).toBe(401);
		}
	});

	it("uses a setup link once, and only one of two tabs that opened it finishes", async () => {
		const { setup } = (await register(new Browser(fresh()), "ana")).body;
		const tabs = [new Browser(), new Browser()];
		const challenges: { challenge: string }[] = [];
		for (const tab of tabs) challenges.push((await tab.json("/auth/passkeys/options", { method: "POST", json: { setup } })).body);
		const statuses = [];
		for (const [i, tab] of tabs.entries()) {
			const response = await tab.fetch("/auth/passkeys", { method: "POST", json: await (await Authenticator.make()).register(challenges[i]!) });
			statuses.push(response.status);
		}
		expect(statuses).toEqual([200, 401]);
		expect(await tabs[1]?.signedIn()).toBe(false);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { setup })).toBe(401);
	});

	it("logs the admin a setup link once there is one, the same until it expires", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const ana = await admin();
		const first = (await setupLink()).setup!;
		expect(first.startsWith(`${ana.owner}.`)).toBe(true);
		expect((await setupLink()).setup).toBe(first);
		vi.setSystemTime(Date.now() + 61 * 60 * 1000);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { setup: first })).toBe(401);
		const second = (await setupLink()).setup!;
		expect(second).not.toBe(first);
		const phone = new Browser();
		expect(await addPasskey(phone, await Authenticator.make(), { setup: second })).toBe(200);
		expect((await phone.json("/auth/session")).body).toMatchObject({ account: { username: "ana" } });
	});

	it("lets a signed-in browser add a passkey without a link", async () => {
		const { browser } = await admin();
		const phone = await Authenticator.make();
		expect(await addPasskey(browser, phone)).toBe(200);
		expect((await signIn(new Browser(), phone)).status).toBe(200);
	});

	it("refuses a passkey started as a sign-in, which anyone can start", async () => {
		const browser = new Browser();
		const options = await browser.fetch("/auth/sign-in/options", { method: "POST" });
		const response = await browser.fetch("/auth/passkeys", { method: "POST", json: await (await Authenticator.make()).register(await options.json()) });
		expect(response.status).toBe(400);
	});

	it.each<[string, Tamper]>([
		["for another site", { rpId: "evil.example.com" }],
		["from another origin", { origin: "https://evil.example.com" }],
		["without verifying the person", { flags: 0x41 }],
		["whose id isn't the one the authenticator made", { credentialId: new Uint8Array(16) }],
		["from a sign-in ceremony", { type: "webauthn.get" }],
	])("refuses a passkey made %s", async (_case, tamper) => {
		const browser = new Browser(fresh());
		const { setup } = (await register(browser, "ana")).body;
		const options = await browser.fetch("/auth/passkeys/options", { method: "POST", json: { setup } });
		const response = await browser.fetch("/auth/passkeys", { method: "POST", json: await (await Authenticator.make()).register(await options.json(), tamper) });
		expect(response.status).toBe(400);
		expect(await browser.signedIn()).toBe(false);
	});
});

describe("signing in", () => {
	it.each(["ES256", "Ed25519"] as const)("signs a new browser in to its own account with an %s passkey", async (algorithm) => {
		await admin();
		const browser = new Browser(fresh());
		const { setup } = (await register(browser, "ben")).body;
		const passkey = await Authenticator.make(algorithm);
		expect(await addPasskey(browser, passkey, { setup })).toBe(200);
		const elsewhere = new Browser();
		expect((await signIn(elsewhere, passkey)).status).toBe(200);
		expect((await elsewhere.json("/auth/session")).body).toMatchObject({ signedIn: true, account: { username: "ben", role: "member" } });
	});

	it.each<[string, Tamper]>([
		["for another site", { rpId: "evil.example.com" }],
		["from another origin", { origin: "https://evil.example.com" }],
		["without verifying the person", { flags: 0x01 }],
		["from a creation ceremony", { type: "webauthn.create" }],
	])("refuses a sign-in %s", async (_case, tamper) => {
		const { passkey } = await admin();
		const browser = new Browser();
		expect((await signIn(browser, passkey, tamper)).status).toBe(401);
		expect(await browser.signedIn()).toBe(false);
	});

	it("refuses a passkey that names someone else's account", async () => {
		const ana = await admin();
		const ben = await person("ben");
		const browser = new Browser();
		// Ben's passkey, claiming to be Ana's: her account has no such passkey.
		expect((await signIn(browser, ben.passkey, { userHandle: userHandle(ana.owner) })).status).toBe(401);
		expect((await signIn(browser, ben.passkey, { userHandle: "not-an-owner" })).status).toBe(401);
		expect(await browser.signedIn()).toBe(false);
	});

	it("refuses a signature from a key other than the passkey's", async () => {
		const { passkey } = await admin();
		expect((await signIn(new Browser(), passkey, {}, await Authenticator.make())).status).toBe(401);
	});

	it("refuses a passkey this Pim never saw, and a signature over a challenge this browser wasn't given", async () => {
		const { passkey } = await admin();
		expect((await signIn(new Browser(), await Authenticator.make())).status).toBe(401);
		const browser = new Browser();
		await browser.fetch("/auth/sign-in/options", { method: "POST" });
		const other = await new Browser().fetch("/auth/sign-in/options", { method: "POST" });
		expect((await browser.fetch("/auth/sign-in", { method: "POST", json: await passkey.sign(await other.json()) })).status).toBe(401);
	});

	it("refuses a suspended account, and lets it in again once restored", async () => {
		const ana = await admin();
		const ben = await person("ben");
		expect((await ana.browser.fetch("/api/admin/accounts/ben/suspend", { method: "POST", json: {} })).status).toBe(200);
		expect(await ben.browser.signedIn()).toBe(false);
		expect((await signIn(new Browser(), ben.passkey)).status).toBe(403);
		expect((await ana.browser.fetch("/api/admin/accounts/ben/unsuspend", { method: "POST", json: {} })).status).toBe(200);
		const browser = new Browser();
		expect((await signIn(browser, ben.passkey)).status).toBe(200);
	});
});

describe("sessions", () => {
	it("end when their passkey is removed, but not when another one is", async () => {
		const { browser: laptop, passkey } = await admin();
		const phone = await Authenticator.make();
		await addPasskey(laptop, phone);
		const phoneBrowser = new Browser();
		await signIn(phoneBrowser, phone);

		const removed = await phoneBrowser.fetch(`/auth/passkeys/${encodeURIComponent(passkey.credentialId)}`, { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect(await laptop.signedIn()).toBe(false);
		expect(await phoneBrowser.signedIn()).toBe(true);
		const list = (await phoneBrowser.json<{ passkeys: { id: string }[] }>("/auth/passkeys")).body;
		expect(list.passkeys.map((p) => p.id)).toEqual([phone.credentialId]);
	});

	it("list and remove passkeys only for someone signed in", async () => {
		const { passkey } = await admin();
		const stranger = new Browser();
		expect((await stranger.fetch("/auth/passkeys")).status).toBe(401);
		expect((await stranger.fetch(`/auth/passkeys/${passkey.credentialId}`, { method: "DELETE" })).status).toBe(401);
	});

	it("end on sign-out", async () => {
		const { browser } = await admin();
		await browser.fetch("/auth/sign-out", { method: "POST" });
		expect(await browser.signedIn()).toBe(false);
	});

	it("last 30 days", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { browser } = await admin();
		vi.setSystemTime(Date.now() + 29 * 24 * 3600 * 1000);
		expect(await browser.signedIn()).toBe(true);
		vi.setSystemTime(Date.now() + 2 * 24 * 3600 * 1000);
		expect(await browser.signedIn()).toBe(false);
	});

	it("refuse an edited session cookie, such as one naming someone else", async () => {
		const ana = await admin();
		const ben = await person("ben");
		const name = "__Host-pim-session";
		const edit = (browser: Browser, change: (payload: any) => void) => {
			const [body, mac] = (browser.cookies.get(name) as string).split(".");
			const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body as string)));
			change(payload);
			browser.cookies.set(name, `${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}.${mac}`);
		};
		edit(ana.browser, (payload) => (payload.exp += 365 * 24 * 3600));
		expect(await ana.browser.signedIn()).toBe(false);
		edit(ben.browser, (payload) => (payload.value.owner = ana.owner));
		expect(await ben.browser.signedIn()).toBe(false);
	});

	it("can't be used by other sites for writes or sockets", async () => {
		const { browser } = await admin();
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

describe("the Pim behind a passkey session", () => {
	it("learns the address its owner uses, for apps' callbacks", async () => {
		const { browser, owner } = await admin();
		await runInDurableObject(env.Pim.getByName(owner), async (instance: Pim) => instance.store.setMeta("public_origin", "https://old.example"));
		expect(await browser.signedIn()).toBe(true);
		const origin = await runInDurableObject(env.Pim.getByName(owner), async (instance: Pim) => instance.store.meta("public_origin"));
		expect(origin).toBe(ORIGIN);
	});
});

describe("adding another device", () => {
	it("lets a browser signed in with a passkey link another device, once, and nobody else", async () => {
		const { browser, owner } = await admin();
		const made = await browser.json("/auth/device-link", { method: "POST" });
		expect(made.status).toBe(201);
		const link = made.body.url as string;
		expect(link).toMatch(new RegExp(`^https://pim\\.test/#device=${owner}\\.[\\w-]+$`));
		const device = link.split("#device=")[1]!;

		const phone = new Browser();
		expect(await addPasskey(phone, await Authenticator.make(), { device })).toBe(200);
		expect(await phone.signedIn()).toBe(true);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device })).toBe(401);
	});
});

describe("recovery codes", () => {
	it("make one new passkey each, once, with the username they belong to", async () => {
		await admin();
		const ben = await person("ben");
		const [code] = ben.registered.recoveryCodes;
		expect(await addPasskey(new Browser(), await Authenticator.make(), { recovery: code!, username: "ana" })).toBe(401);
		const browser = new Browser();
		expect(await addPasskey(browser, await Authenticator.make(), { recovery: code!.toUpperCase(), username: "ben" })).toBe(200);
		expect((await browser.json("/auth/session")).body).toMatchObject({ account: { username: "ben" } });
		expect(await addPasskey(new Browser(), await Authenticator.make(), { recovery: code!, username: "ben" })).toBe(401);
	});
});

describe("API tokens", () => {
	it("open only their owner's Pim, from anywhere, and can't manage sign-in", async () => {
		const ana = await admin();
		const ben = await person("ben");
		const made = await ben.browser.json("/auth/tokens", { method: "POST", json: { name: "bot" } });
		expect(made.status).toBe(201);
		const token = made.body.token as string;
		expect(token.startsWith(`pim_${ben.owner}_`)).toBe(true);

		const call = (bearer: string, path = "/api/account") =>
			exports.default.fetch(url(path), { headers: { Authorization: `Bearer ${bearer}`, origin: "https://bot.example" } });
		const account = await call(token);
		expect(account.status).toBe(200);
		expect(((await account.json()) as { username: string }).username).toBe("ben");
		// Another owner's ID in front of Ben's secret opens nothing.
		expect((await call(token.replace(ben.owner, ana.owner))).status).toBe(401);
		expect((await call("pim_garbage")).status).toBe(401);
		// A token can't make a device link or run the instance, even the admin's.
		const deviceLink = await exports.default.fetch(url("/auth/device-link"), { method: "POST", headers: { Authorization: `Bearer ${token}`, origin: ORIGIN } });
		expect(deviceLink.status).toBe(401);
		const adminToken = (await ana.browser.json("/auth/tokens", { method: "POST", json: { name: "bot" } })).body.token as string;
		expect((await call(adminToken, "/api/admin/stats")).status).toBe(403);
		expect((await ana.browser.fetch("/api/admin/stats")).status).toBe(200);
		expect((await ben.browser.fetch("/api/admin/stats")).status).toBe(403);
	});
});

/**
 * Google, GitHub and a custom OpenID Connect provider at https://idp.test,
 * behind `fetch`. `account` is who signs in there; a code is good once, for
 * the PKCE verifier its sign-in started with, and the client's own secret.
 */
const IDP = "https://idp.test";
let account = { sub: "1001", email: "ana@example.com" };
let editClaims = (claims: Record<string, unknown>) => claims;
const grants = new Map<string, { challenge: string; nonce: string | null; clientId: string; issuer: string }>();

function fakeProviders() {
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const { href } = new URL(request.url);
		if (href === "https://accounts.google.com/.well-known/openid-configuration") {
			return Response.json({
				issuer: "https://accounts.google.com",
				authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
				token_endpoint: "https://oauth2.googleapis.com/token",
			});
		}
		if (href === `${IDP}/.well-known/openid-configuration`) {
			return Response.json({
				issuer: IDP,
				authorization_endpoint: `${IDP}/authorize`,
				token_endpoint: `${IDP}/token`,
				token_endpoint_auth_methods_supported: ["client_secret_post"],
			});
		}
		if (["https://oauth2.googleapis.com/token", `${IDP}/token`, "https://github.com/login/oauth/access_token"].includes(href)) {
			const form = new URLSearchParams(await request.text());
			const basic = request.headers.get("authorization");
			const [clientId, secret] = basic ? atob(basic.slice(6)).split(":") : [form.get("client_id"), form.get("client_secret")];
			const grant = grants.get(form.get("code") ?? "");
			grants.delete(form.get("code") ?? "");
			const verifier = base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(form.get("code_verifier") ?? ""))));
			if (!grant || grant.challenge !== verifier || grant.clientId !== clientId || secret !== `${clientId}-secret`) {
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			if (href.startsWith("https://github.com")) return Response.json({ access_token: `gh:${account.sub}` });
			const claims = editClaims({ iss: grant.issuer, aud: grant.clientId, sub: account.sub, email: account.email, nonce: grant.nonce, exp: Date.now() / 1000 + 3600 });
			const part = (value: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(value)));
			return Response.json({ access_token: "at", id_token: `${part({ alg: "RS256" })}.${part(claims)}.signature` });
		}
		if (href === "https://api.github.com/user") {
			const token = request.headers.get("authorization")?.slice("Bearer gh:".length);
			return Response.json({ id: Number(token), login: "ana-gh" });
		}
		return realFetch(input, init);
	});
}

/** All three providers on, as a deployment's secrets turn them on: each client's secret is `<client ID>-secret`. */
const PROVIDERS = {
	PIM_GOOGLE_CLIENT_ID: "google-client",
	PIM_GOOGLE_CLIENT_SECRET: "google-client-secret",
	PIM_GITHUB_CLIENT_ID: "github-client",
	PIM_GITHUB_CLIENT_SECRET: "github-client-secret",
	PIM_OIDC_ISSUER: IDP,
	PIM_OIDC_CLIENT_ID: "oidc-client",
	PIM_OIDC_CLIENT_SECRET: "oidc-client-secret",
	PIM_OIDC_NAME: "Acme SSO",
} as unknown as Partial<Env>;
const DAY = 24 * 60 * 60 * 1000;
/** A browser on a Pim whose deployment turns `vars` on. */
const on = (vars: Partial<Env> = PROVIDERS) => new Browser(deployed(DAY, vars));
/** The admin of a fresh Pim whose deployment turns `vars` on. */
const adminOn = (vars: Partial<Env> = PROVIDERS) => person("ana", deployed(60 * 1000, vars));

/**
 * Signs in at a provider: starts in this browser, signs in as `account`
 * there, and follows the provider back. Answers where the Worker sends the
 * browser after, with any error from its fragment.
 */
async function viaProvider(browser: Browser, provider: string, body: Record<string, unknown> = {}, finishIn: Browser = browser) {
	const started = await browser.json<{ url: string; error?: string }>(`/auth/oauth/${provider}`, { method: "POST", json: body });
	if (started.status !== 200) return { status: started.status, error: started.body.error };
	const at = new URL(started.body.url);
	const code = `code-${crypto.randomUUID()}`;
	const params = at.searchParams;
	expect(params.get("redirect_uri")).toBe(url(`/auth/oauth/${provider}/callback`));
	grants.set(code, { challenge: params.get("code_challenge")!, nonce: params.get("nonce"), clientId: params.get("client_id")!, issuer: at.origin });
	const back = await finishIn.fetch(`/auth/oauth/${provider}/callback?${new URLSearchParams({ code, state: params.get("state")! })}`);
	expect(back.status).toBe(302);
	const [to = "", fragment = ""] = back.headers.get("location")!.split("#");
	return { status: back.status, to, error: new URLSearchParams(fragment).get("auth-error") ?? undefined };
}

describe("signing in with another account", () => {
	beforeEach(() => {
		account = { sub: "1001", email: "ana@example.com" };
		editClaims = (claims) => claims;
		fakeProviders();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("joins with Google instead of a passkey, then signs in with it from another browser", async () => {
		const ana = await adminOn();
		expect((await on().json("/auth/session")).body.providers).toEqual([
			{ id: "google", name: "Google" },
			{ id: "github", name: "GitHub" },
			{ id: "oidc", name: "Acme SSO" },
		]);

		const joining = on();
		const { setup } = (await register(joining, "ben")).body;
		account = { sub: "2002", email: "ben@example.com" };
		editClaims = (claims) => ({ ...claims, name: "Benjamín Ortiz", given_name: "Benjamín" });
		expect(await viaProvider(joining, "google", { setup })).toEqual({ status: 302, to: "/", error: undefined });
		expect((await joining.json("/api/account")).body).toMatchObject({ username: "ben", status: "active" });
		// Google says what to call him, so the app needn't ask; a passkey says nothing.
		expect((await joining.json("/auth/session")).body.name).toBe("Benjamín");
		expect((await ana.browser.json("/auth/session")).body.name).toBeNull();

		const elsewhere = on();
		expect(await viaProvider(elsewhere, "google")).toMatchObject({ to: "/", error: undefined });
		expect((await elsewhere.json("/auth/session")).body).toMatchObject({ signedIn: true, method: "identity", passkey: null, account: { username: "ben" } });
		// The setup link was used up.
		expect((await viaProvider(on(), "google", { setup })).status).toBe(401);
	});

	it("signs nobody in with an account nobody linked, and makes no account for it", async () => {
		const ana = await adminOn();
		const stranger = on();
		account = { sub: "9999", email: "stranger@example.com" };
		const result = await viaProvider(stranger, "google");
		expect(result.error).toMatch(/Nobody on this Pim signs in with that Google account/);
		expect(await stranger.signedIn()).toBe(false);
		expect((await ana.browser.json("/api/admin/stats")).body.accounts.active).toBe(1);
	});

	it("links an account once on this Pim, and unlinking it ends its sessions", async () => {
		const ana = await adminOn();
		expect(await viaProvider(ana.browser, "google")).toMatchObject({ to: "/?dialog=settings&tab=account", error: undefined });
		const { identities } = (await ana.browser.json<{ identities: { id: string; provider: string; label: string }[] }>("/auth/identities")).body;
		expect(identities).toMatchObject([{ provider: "google", label: "ana@example.com" }]);

		const ben = await person("ben", deployed(DAY, PROVIDERS));
		expect(await viaProvider(ben.browser, "google")).toMatchObject({ to: "/?dialog=settings&tab=account", error: "That Google account already signs in to someone else on this Pim." });

		const phone = on();
		await viaProvider(phone, "google");
		expect((await phone.json("/api/account")).body.username).toBe("ana");
		expect((await ana.browser.fetch(`/auth/identities/${identities[0]!.id}`, { method: "DELETE" })).status).toBe(200);
		expect(await phone.signedIn()).toBe(false);
		expect(await ana.browser.signedIn()).toBe(true);
		// Free for someone else now.
		expect(await viaProvider(ben.browser, "google")).toMatchObject({ error: undefined });
		expect(await viaProvider(on(), "google").then(() => ben.browser.json("/api/account"))).toMatchObject({ body: { username: "ben" } });
	});

	it.each<[string, (claims: Record<string, unknown>) => Record<string, unknown>]>([
		["for another sign-in", (claims) => ({ ...claims, nonce: "another" })],
		["for another app", (claims) => ({ ...claims, aud: "someone-else" })],
		["from another issuer", (claims) => ({ ...claims, iss: "https://evil.example.com" })],
		["that expired", (claims) => ({ ...claims, exp: Date.now() / 1000 - 3600 })],
	])("refuses an ID token %s", async (_case, edit) => {
		const ana = await adminOn();
		await viaProvider(ana.browser, "google");
		editClaims = edit;
		const browser = on();
		expect((await viaProvider(browser, "google")).error).toMatch(/wasn't for this sign-in/);
		expect(await browser.signedIn()).toBe(false);
	});

	it("refuses to finish a sign-in in a browser that didn't start it", async () => {
		const ana = await adminOn();
		await viaProvider(ana.browser, "google");
		const victim = on();
		expect((await viaProvider(on(), "google", {}, victim)).error).toMatch(/took too long, or started in another browser/);
		expect(await victim.signedIn()).toBe(false);
	});

	it("keeps each provider's people apart: GitHub by user ID, a custom provider by its issuer", async () => {
		const ana = await adminOn();
		// The same subject at two providers is two people.
		await viaProvider(ana.browser, "github");
		expect((await viaProvider(on(), "oidc")).error).toMatch(/Nobody on this Pim signs in with that Acme SSO account/);
		const browser = on();
		expect(await viaProvider(browser, "github")).toMatchObject({ error: undefined });
		expect((await browser.json("/auth/identities")).body.identities).toMatchObject([{ provider: "github", label: "ana-gh" }]);
	});

	it("turns on only the providers the deployment's secrets fully set, and shows the admin which without their values", async () => {
		const vars = { PIM_GITHUB_CLIENT_ID: "github-client", PIM_GITHUB_CLIENT_SECRET: "github-client-secret", PIM_OIDC_CLIENT_ID: "oidc-client" } as unknown as Partial<Env>;
		const ana = await adminOn(vars);
		const listed = await ana.browser.fetch("/api/admin/sign-in").then((response) => response.text());
		expect(listed).not.toContain("github-client-secret");
		expect(JSON.parse(listed).providers).toEqual([
			expect.objectContaining({ id: "google", enabled: false, problem: null, secrets: ["PIM_GOOGLE_CLIENT_ID", "PIM_GOOGLE_CLIENT_SECRET"] }),
			expect.objectContaining({ id: "github", enabled: true, problem: null, callbackUrl: url("/auth/oauth/github/callback") }),
			// Half set: off, and the admin is told what's missing.
			expect.objectContaining({ id: "oidc", enabled: false, problem: "Set PIM_OIDC_ISSUER and PIM_OIDC_CLIENT_SECRET too." }),
		]);
		const ben = await person("ben", deployed(DAY, vars));
		expect((await ben.browser.fetch("/api/admin/sign-in")).status).toBe(403);

		const elsewhere = on(vars);
		expect((await elsewhere.json("/auth/session")).body.providers).toEqual([{ id: "github", name: "GitHub" }]);
		expect((await viaProvider(elsewhere, "google")).status).toBe(404);
		await viaProvider(ana.browser, "github");
		expect(await viaProvider(elsewhere, "github")).toMatchObject({ error: undefined });
		expect((await elsewhere.json("/api/account")).body.username).toBe("ana");
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
