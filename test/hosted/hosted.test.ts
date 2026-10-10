import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Auth } from "../../src/auth";
import { type PimSite, toAgent } from "../../src/gateway";
import type { Directory, RegistrationPolicy } from "../../src/hosted/directory";
import { z } from "zod";
import { toolUse } from "../helpers";
import { faux, Pim } from "../worker";
import { Authenticator } from "../webauthn";

const DOMAIN = "pimling.test";
const FRONT = `https://${DOMAIN}`;
const hostOf = (username: string) => `https://${username}.${DOMAIN}`;

afterEach(() => {
	// Every scripted model response was used.
	expect(faux.getPendingResponseCount()).toBe(0);
});

let browsers = 0;

/** One browser on one origin, from its own address: keeps the cookies the Worker sets, sends them back. */
class Browser {
	cookies = new Map<string, string>();

	constructor(
		readonly origin: string,
		readonly ip = `203.0.${Math.floor(++browsers / 250)}.${browsers % 250}`,
	) {}

	async fetch(path: string, init: RequestInit & { json?: unknown } = {}) {
		const headers = new Headers(init.headers);
		if (!headers.has("origin") && init.method && init.method !== "GET") headers.set("origin", this.origin);
		if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		if (init.json !== undefined) headers.set("content-type", "application/json");
		headers.set("CF-Connecting-IP", this.ip);
		const response = await exports.default.fetch(
			new Request(`${this.origin}${path}`, { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) }),
		);
		for (const cookie of response.headers.getSetCookie()) {
			const [pair = "", ...attributes] = cookie.split("; ");
			const [name = "", ...value] = pair.split("=");
			if (attributes.includes("Max-Age=0")) this.cookies.delete(name);
			else this.cookies.set(name, value.join("="));
		}
		return response;
	}

	async json<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: T }> {
		const response = await this.fetch(path, init);
		return { status: response.status, body: (await response.json()) as T };
	}
}

type Registered = { username: string; url: string; setupUrl: string; recoveryCodes: string[] };

let addresses = 0;
/** Registers from a fresh address, so the per-address limit is only met where a test means to. */
async function register(username: string, extra: Record<string, unknown> = {}) {
	const front = new Browser(FRONT, `198.51.100.${++addresses}`);
	return front.json<Registered & { error?: string }>("/auth/register", { method: "POST", json: { username, ...extra } });
}

async function addPasskey(browser: Browser, authenticator: Authenticator, allowedBy: { setup?: string; recovery?: string } = {}) {
	const options = await browser.json("/auth/passkeys/options", { method: "POST", json: allowedBy });
	if (options.status !== 200) return options.status;
	return (await browser.fetch("/auth/passkeys", { method: "POST", json: await authenticator.register(options.body) })).status;
}

async function signIn(browser: Browser, authenticator: Authenticator) {
	const options = await browser.json("/auth/sign-in/options", { method: "POST" });
	return (await browser.fetch("/auth/sign-in", { method: "POST", json: await authenticator.sign(options.body) })).status;
}

/** A registered, set-up Pimling, and a browser signed in to it. */
async function person(username: string) {
	const registered = await register(username);
	expect(registered.status).toBe(201);
	const browser = new Browser(hostOf(username));
	const passkey = await Authenticator.make("ES256", { rpId: `${username}.${DOMAIN}`, origin: hostOf(username) });
	const setup = new URL(registered.body.setupUrl).hash.replace("#setup=", "");
	expect(await addPasskey(browser, passkey, { setup })).toBe(200);
	const account = (await browser.json("/api/account")).body as { ownerId: string };
	return { browser, passkey, registered: registered.body, setup, ownerId: account.ownerId };
}

const directory = () => env.Directory!.getByName("directory");
/** A Directory of its own, for tests that need an empty one. */
const freshDirectory = () => env.Directory!.getByName(`fresh-${crypto.randomUUID()}`);
const OPEN: RegistrationPolicy = { mode: "open", maxAccounts: null, perAddressPerDay: 100 };

/** Everything that holds the person's data, so a test can tell it was kept or erased. */
async function holdings(ownerId: string) {
	const agent = await runInDurableObject(env.Pim.getByName(ownerId), async (instance: Pim) => ({
		remaining: await instance.remainingData(),
		memories: instance.memory.store.count(),
		credentials: instance.store.credentialProviders(),
	}));
	const auth = env.Auth.getByName(ownerId);
	return { ...agent, passkeys: (await auth.passkeys()).length, tokens: (await auth.tokens()).length };
}

/** Makes the Directory's queued cleanup for `ownerId` due now, as if its wait had passed. */
async function makeDue(stub: DurableObjectStub<Directory>, ownerId: string) {
	await runInDurableObject(stub, (_instance: Directory, state) => {
		state.storage.sql.exec("UPDATE cleanups SET next_attempt_at = ? WHERE owner_id = ?", Date.now() - 1, ownerId);
	});
}

/** Swaps a method of the test Pim for the length of `run`. */
async function withAgentMethod<K extends "deleteEverything">(name: K, replacement: (original: Pim[K]) => Pim[K], run: () => Promise<void>) {
	const prototype = Pim.prototype as Pim;
	const original = prototype[name];
	prototype[name] = replacement(original);
	try {
		await run();
	} finally {
		prototype[name] = original;
	}
}
const admin = (path: string, init: RequestInit & { json?: unknown } = {}) =>
	new Browser(FRONT).json(path, { ...init, headers: { Authorization: "Bearer admin-token", ...init.headers } });

describe("registration", () => {
	it("gives a username its own Pim, set up with a one-time link, and recovery codes", async () => {
		const { status, body } = await register("alice", { timeZone: "Europe/Lisbon" });
		expect(status).toBe(201);
		expect(body.url).toBe(hostOf("alice"));
		expect(body.setupUrl).toMatch(new RegExp(`^${hostOf("alice")}/#setup=[\\w-]+$`));
		expect(body.recoveryCodes).toHaveLength(10);

		const browser = new Browser(hostOf("alice"));
		expect((await browser.json("/auth/session")).body).toMatchObject({ signedIn: false, hasPasskeys: false, canClaim: false, recovery: "codes" });
		// Nobody gets in by finding the address first: there is no claim window.
		const passkey = await Authenticator.make("ES256", { rpId: `alice.${DOMAIN}`, origin: hostOf("alice") });
		expect(await addPasskey(browser, passkey)).toBe(401);
		const setup = new URL(body.setupUrl).hash.replace("#setup=", "");
		expect(await addPasskey(browser, passkey, { setup })).toBe(200);

		const account = await browser.json("/api/account");
		expect(account.body).toMatchObject({ username: "alice", status: "active", ownerId: expect.stringMatching(/^o_[0-9a-z]{26}$/) });
		expect((await browser.json("/api/settings")).body).toMatchObject({ timeZone: "Europe/Lisbon", approvalPolicy: "explicit" });
		// The link works once.
		expect(await addPasskey(new Browser(hostOf("alice")), await Authenticator.make("ES256", { rpId: `alice.${DOMAIN}`, origin: hostOf("alice") }), { setup })).toBe(401);
	});

	it("refuses taken, reserved and malformed usernames", async () => {
		await register("carol");
		expect((await register("carol")).status).toBe(409);
		expect((await register("admin")).body.error).toBe("That username is reserved.");
		for (const bad of ["ab", "bad_name", "a--b", "-lead", "trail-", "x".repeat(33)]) {
			expect((await register(bad)).status, bad).toBe(400);
		}
		const front = new Browser(FRONT);
		expect((await front.json("/auth/username?name=carol")).body).toEqual({ available: false, reason: "That username is taken." });
		expect((await front.json("/auth/username?name=dave")).body).toEqual({ available: true });
	});

	it("comes only from the front door's own pages", async () => {
		const response = await new Browser(FRONT).fetch("/auth/register", {
			method: "POST",
			json: { username: "mallory" },
			headers: { origin: "https://evil.example" },
		});
		expect(response.status).toBe(403);
	});

	it("limits registrations from one address in a day", async () => {
		const front = new Browser(FRONT, "192.0.2.77");
		for (const name of ["dee1", "dee2", "dee3"]) {
			expect((await front.json("/auth/register", { method: "POST", json: { username: name } })).status).toBe(201);
		}
		const refused = await front.json("/auth/register", { method: "POST", json: { username: "dee4" } });
		expect(refused.status).toBe(429);
	});

	it("takes invite codes once, when registration needs them", async () => {
		const policy = { mode: "invite" as const, maxAccounts: null, perAddressPerDay: 100 };
		const [code] = (await admin("/admin/invites", { method: "POST", json: { count: 1 } })).body.codes as string[];
		await runInDurableObject(directory(), async (instance: Directory) => {
			expect(await instance.register({ username: "ivy", ip: "1", policy })).toMatchObject({ ok: false, status: 403 });
			expect(await instance.register({ username: "ivy", ip: "1", policy, invite: code! })).toMatchObject({ ok: true });
			expect(await instance.register({ username: "ivo", ip: "1", policy, invite: code! })).toMatchObject({ ok: false, status: 403 });
		});
	});

	it("gives the username back at once when the Pimling can't be set up", async () => {
		const agents = env.Pim as unknown as { idFromName: (name: string) => DurableObjectId };
		const real = agents.idFromName.bind(agents);
		agents.idFromName = () => {
			throw new Error("Durable Objects are down");
		};
		try {
			const failed = await register("ursula");
			expect(failed.status).toBe(500);
			expect(failed.body.error).toBe("Your Pimling couldn't be set up. Try again in a moment.");
		} finally {
			agents.idFromName = real;
		}
		expect((await new Browser(FRONT).json("/auth/username?name=ursula")).body).toEqual({ available: true });
		expect((await register("ursula")).status).toBe(201);
	});

	it("gives an invite back with the username when the Pimling can't be set up", async () => {
		const registration = env as unknown as { PIMLING_REGISTRATION: string };
		const agents = env.Pim as unknown as { idFromName: (name: string) => DurableObjectId };
		const real = agents.idFromName.bind(agents);
		registration.PIMLING_REGISTRATION = "invite";
		try {
			const [code] = (await admin("/admin/invites", { method: "POST", json: { count: 1 } })).body.codes as string[];
			agents.idFromName = () => {
				throw new Error("Durable Objects are down");
			};
			try {
				expect((await register("vera", { invite: code })).status).toBe(500);
			} finally {
				agents.idFromName = real;
			}
			// "Try again" works: the same invite takes the same username.
			expect((await register("vera", { invite: code })).status).toBe(201);
			// Still single-use.
			expect((await register("vero", { invite: code })).status).toBe(403);
		} finally {
			agents.idFromName = real;
			registration.PIMLING_REGISTRATION = "open";
		}
	});

	it("keeps invites single-use, giving one back only with the registration that used it", async () => {
		const stub = freshDirectory();
		const policy: RegistrationPolicy = { ...OPEN, mode: "invite" };
		const [code, other] = await stub.createInvites(2, null);
		const first = await stub.register({ username: "wade", ip: "1", policy, invite: code! });
		expect(first.ok).toBe(true);
		// Someone else's abandoned registration gives nothing back.
		const second = await stub.register({ username: "wynn", ip: "1", policy, invite: other! });
		await stub.abandon(second.ok ? second.account.ownerId : "");
		expect(await stub.register({ username: "wyatt", ip: "1", policy, invite: code! })).toMatchObject({ ok: false, status: 403 });
		// Its own does, once.
		await stub.abandon(first.ok ? first.account.ownerId : "");
		expect(await stub.register({ username: "wade", ip: "1", policy, invite: code! })).toMatchObject({ ok: true });
		expect(await stub.register({ username: "wade2", ip: "1", policy, invite: code! })).toMatchObject({ ok: false, status: 403 });
		// An active account's invite is never given back.
		const active = await stub.register({ username: "wren", ip: "1", policy, invite: other! });
		expect(active.ok).toBe(true);
		if (active.ok) {
			await stub.activate(active.account.ownerId);
			await stub.abandon(active.account.ownerId);
		}
		expect(await stub.register({ username: "wrex", ip: "1", policy, invite: other! })).toMatchObject({ ok: false, status: 403 });
	});

	it("frees a lapsed registration's place, username and invite, and erases what it made", async () => {
		const stub = freshDirectory();
		const policy: RegistrationPolicy = { mode: "invite", maxAccounts: 1, perAddressPerDay: 100 };
		const [code] = await stub.createInvites(1, null);
		// Registered 25 hours ago, and never set up. (Real times: the Directory's alarm runs on the clock.)
		const later = Date.now();
		const lapsed = await stub.register({ username: "expired", ip: "1", policy, invite: code!, now: later - 25 * 60 * 60 * 1000 });
		expect(lapsed.ok).toBe(true);
		expect(await stub.resolve("expired", later)).toBeNull();
		// Its place under maxAccounts and its invite are free again.
		const again = await stub.register({ username: "expired", ip: "2", policy, invite: code!, now: later });
		expect(again).toMatchObject({ ok: true });
		expect(await stub.register({ username: "another", ip: "3", policy: { ...OPEN, maxAccounts: 1 }, now: later })).toMatchObject({
			ok: false,
			status: 503,
		});
		// A lapsed registration can't be activated late.
		const oldOwner = lapsed.ok ? lapsed.account.ownerId : "";
		expect(await stub.activate(oldOwner, later)).toBeNull();
		// Its sign-in is erased by a queued cleanup.
		expect(await stub.cleanup(oldOwner)).toMatchObject({ kind: "release" });
		await env.Auth.getByName(oldOwner).newRecoveryCodes(Date.now());
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await stub.cleanup(oldOwner)).toBeNull();
		expect(await env.Auth.getByName(oldOwner).recoveryCodesLeft()).toBe(0);
	});

	it("gives a username back when nobody made a passkey within a day, to a new owner", async () => {
		const lapsed = await runInDurableObject(directory(), (instance: Directory) =>
			instance.register({
				username: "gone",
				ip: "lapsed",
				policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 },
				now: Date.now() - 25 * 60 * 60 * 1000,
			}),
		);
		expect(lapsed.ok).toBe(true);
		expect((await new Browser(FRONT).json("/auth/username?name=gone")).body).toEqual({ available: true });
		expect((await register("gone")).status).toBe(201);
		const now = await runInDurableObject(directory(), (instance: Directory) => instance.resolve("gone"));
		expect(now?.ownerId).not.toBe(lapsed.ok && lapsed.account.ownerId);
	});
});

describe("isolation between people", () => {
	it("a session opens only the Pim it was made for", async () => {
		const erin = await person("erin");
		const frank = await person("frank");
		expect((await erin.browser.json("/api/sessions")).status).toBe(200);
		// Erin's cookies, taken to Frank's address, open nothing there.
		const stolen = new Browser(hostOf("frank"));
		stolen.cookies = new Map(erin.browser.cookies);
		expect((await stolen.json("/api/sessions")).status).toBe(401);
		expect((await stolen.json("/auth/session")).body).toMatchObject({ signedIn: false });
		// Nor does Erin's passkey.
		expect(await signIn(new Browser(hostOf("frank")), erin.passkey)).toBe(401);
		expect(erin.ownerId).not.toBe(frank.ownerId);
	});

	it("an API token opens only its owner's Pim, and the deployment's token opens none", async () => {
		const gina = await person("gina");
		await person("hank");
		const made = await gina.browser.json("/auth/tokens", { method: "POST", json: { name: "Phone" } });
		expect(made.status).toBe(201);
		const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
		expect((await new Browser(hostOf("gina")).json("/api/sessions", bearer(made.body.token))).status).toBe(200);
		expect((await new Browser(hostOf("hank")).json("/api/sessions", bearer(made.body.token))).status).toBe(401);
		// PIM_API_TOKEN is set in this deployment, and must be no one's.
		expect((await new Browser(hostOf("gina")).json("/api/sessions", bearer("env-token"))).status).toBe(401);
		// Tokens can't be made or listed with a token.
		expect((await new Browser(hostOf("gina")).json("/auth/tokens", bearer(made.body.token))).status).toBe(401);
		expect((await gina.browser.json("/auth/tokens")).body.tokens).toEqual([expect.objectContaining({ name: "Phone", id: made.body.id })]);
		expect(JSON.stringify((await gina.browser.json("/auth/tokens")).body)).not.toContain(made.body.token);
		expect((await gina.browser.json(`/auth/tokens/${made.body.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await new Browser(hostOf("gina")).json("/api/sessions", bearer(made.body.token))).status).toBe(401);
	});

	it("conversations, memories and ChatGPT sign-ins stay with their owner", async () => {
		const ian = await person("ian");
		const jo = await person("joy");
		const noted = await ian.browser.json("/api/memory/log", { method: "POST", json: { text: "Ian's passport expires in May" } });
		expect(noted.body).toMatchObject({ text: expect.stringContaining("passport") });
		faux.setResponses([fauxAssistantMessage("Noted, Ian.")]);
		expect((await ian.browser.json("/api/sessions/1/messages", { method: "POST", json: { content: "Hi, I'm Ian", wait: true } })).body).toMatchObject({
			status: "done",
		});
		await runInDurableObject(env.Pim.getByName(ian.ownerId), (instance: Pim) => {
			instance.store.putCredential("openai", JSON.stringify({ type: "oauth", access: "ian-access", refresh: "ian-refresh", email: "ian@example.com" }));
		});

		const joMemory = (await jo.browser.json("/api/memory/log")).body;
		expect(JSON.stringify(joMemory)).not.toContain("passport");
		expect((await jo.browser.json("/api/sessions/1/messages")).body.messages).toEqual([]);
		expect((await jo.browser.json("/api/chatgpt")).body).toEqual({ connected: false, email: null });
		expect((await ian.browser.json("/api/chatgpt")).body).toEqual({ connected: true, email: "ian@example.com" });
		// Each Pimling is its own agent host to OpenAI.
		const hostId = async (browser: Browser) =>
			new URL((await browser.json("/api/chatgpt/login", { method: "POST" })).body.url).searchParams.get("ext_agent_host_id");
		const [ianHost, joHost] = [await hostId(ian.browser), await hostId(jo.browser)];
		expect(ianHost).toMatch(/^urn:uuid:/);
		expect(joHost).not.toBe(ianHost);
	});

	it("connected apps, schedules and settings stay with their owner", async () => {
		const gus = await person("gus");
		const hal = await person("hal");
		const notes = () => {
			const server = new McpServer({ name: "notes", version: "1.0.0" });
			server.registerTool(
				"search",
				{ description: "Search notes.", inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
				async ({ query }) => ({ content: [{ type: "text", text: `No notes match ${query}.` }] }),
			);
			return server;
		};
		const realFetch = globalThis.fetch;
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith("https://notes.example.test/mcp")) return realFetch(input, init);
			return createMcpHandler(notes)(request, {}, createExecutionContext());
		});
		try {
			const connected = await gus.browser.json("/api/mcp", { method: "POST", json: { name: "Notes", url: "https://notes.example.test/mcp" } });
			expect(connected).toMatchObject({ status: 201, body: { state: "ready" } });
		} finally {
			spy.mockRestore();
		}
		const toolNames = async (browser: Browser) =>
			((await browser.json("/api/")).body.tools as { name: string }[]).map((tool) => tool.name);
		expect((await gus.browser.json("/api/mcp")).body.servers).toEqual([expect.objectContaining({ id: "notes" })]);
		expect(await toolNames(gus.browser)).toContain("notes_search");
		expect((await hal.browser.json("/api/mcp")).body.servers).toEqual([]);
		expect(await toolNames(hal.browser)).not.toContain("notes_search");

		await runInDurableObject(env.Pim.getByName(gus.ownerId), async (instance: Pim) => {
			await instance.schedule(new Date(Date.now() + 60 * 60_000), "runScheduledTask", { session: "1", instruction: "Water the plants" });
		});
		expect((await gus.browser.json("/api/schedules")).body.schedules).toHaveLength(1);
		expect((await hal.browser.json("/api/schedules")).body.schedules).toEqual([]);

		await gus.browser.json("/api/settings", { method: "PUT", json: { timeZone: "Asia/Tokyo", approvalPolicy: "auto" } });
		expect((await gus.browser.json("/api/settings")).body).toMatchObject({ timeZone: "Asia/Tokyo", approvalPolicy: "auto" });
		expect((await hal.browser.json("/api/settings")).body).toMatchObject({ timeZone: "UTC", approvalPolicy: "explicit" });
	});

	it("the hostname alone opens nothing", async () => {
		await person("kim");
		expect((await new Browser(hostOf("kim")).json("/api/sessions")).status).toBe(401);
		expect((await new Browser(hostOf("nobody-here")).json("/api/sessions")).status).toBe(404);
		expect((await new Browser(`https://deeper.kim.${DOMAIN}`).json("/api/sessions")).status).toBe(404);
		expect((await new Browser("https://kim.elsewhere.test").json("/api/sessions")).status).toBe(404);
		// Self-hosting's ways in are closed: no setup links in the logs.
		expect((await new Browser(hostOf("kim")).json("/auth/setup-link", { method: "POST" })).status).toBe(404);
	});

	it("slows down guessing from one address", async () => {
		await person("lars");
		const guesser = new Browser(hostOf("lars"));
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 31; attempt++) {
			statuses.push((await guesser.fetch("/auth/passkeys/options", { method: "POST", json: { recovery: `guess-${attempt}` } })).status);
		}
		// AUTH_LIMITER allows 30 a minute.
		expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
		expect(statuses[30]).toBe(429);
	});
});

describe("recovery", () => {
	it("a recovery code makes one new passkey, once", async () => {
		const lee = await person("lee");
		const site = { rpId: `lee.${DOMAIN}`, origin: hostOf("lee") };
		const lost = new Browser(hostOf("lee"));
		const replacement = await Authenticator.make("ES256", site);
		const code = lee.registered.recoveryCodes[0]!;
		expect(await addPasskey(lost, replacement, { recovery: "wrong-code-12345" })).toBe(401);
		// Typed loosely: upper case, no dashes.
		expect(await addPasskey(lost, replacement, { recovery: code.replaceAll("-", "").toUpperCase() })).toBe(200);
		expect((await lost.json("/api/sessions")).status).toBe(200);
		expect(await addPasskey(new Browser(hostOf("lee")), await Authenticator.make("ES256", site), { recovery: code })).toBe(401);
		expect((await lost.json("/auth/recovery-codes")).body).toEqual({ left: 9 });

		// A new set replaces the old one.
		const fresh = (await lost.json("/auth/recovery-codes", { method: "POST" })).body.codes as string[];
		expect(fresh).toHaveLength(10);
		expect(await addPasskey(new Browser(hostOf("lee")), await Authenticator.make("ES256", site), { recovery: lee.registered.recoveryCodes[1]! })).toBe(401);
		expect((await new Browser(hostOf("lee")).json("/auth/recovery-codes", { method: "POST" })).status).toBe(401);
	});

	it("the operator can issue a setup link, for someone who lost everything", async () => {
		await person("max");
		const { body } = await admin("/admin/accounts/max/setup-link", { method: "POST" });
		const setup = new URL(body.setupUrl).hash.replace("#setup=", "");
		const browser = new Browser(hostOf("max"));
		expect(await addPasskey(browser, await Authenticator.make("ES256", { rpId: `max.${DOMAIN}`, origin: hostOf("max") }), { setup })).toBe(200);
		expect((await browser.json("/api/sessions")).status).toBe(200);
	});
});

describe("the account", () => {
	it("exports the person's data without secrets", async () => {
		const nia = await person("nia");
		await nia.browser.json("/api/memory/log", { method: "POST", json: { text: "Nia plays the cello" } });
		const token = (await nia.browser.json("/auth/tokens", { method: "POST", json: { name: "CLI" } })).body.token as string;
		const response = await nia.browser.fetch("/api/account/export");
		expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="pimling-nia-/);
		const text = await response.text();
		const data = JSON.parse(text);
		expect(data).toMatchObject({ account: { username: "nia" }, pim: { format: "pim-export" }, tokens: [{ name: "CLI" }] });
		expect(text).toContain("Nia plays the cello");
		expect(text).not.toContain(token);
		for (const code of nia.registered.recoveryCodes) expect(text).not.toContain(code);
	});

	it("is deleted only by its owner, signed in with a passkey, and then is gone for good", async () => {
		const olga = await person("olga");
		await olga.browser.json("/api/memory/log", { method: "POST", json: { text: "Olga's secret recipe" } });
		const token = (await olga.browser.json("/auth/tokens", { method: "POST", json: { name: "CLI" } })).body.token as string;
		const withToken = new Browser(hostOf("olga"));
		const tokenDelete = await withToken.json("/api/account", { method: "DELETE", json: { confirm: "olga" }, headers: { Authorization: `Bearer ${token}` } });
		expect(tokenDelete.status).toBe(403);
		expect((await olga.browser.json("/api/account", { method: "DELETE", json: { confirm: "olgaa" } })).status).toBe(400);

		expect((await olga.browser.json("/api/account", { method: "DELETE", json: { confirm: "olga" } })).body).toEqual({ deleted: true });
		expect((await olga.browser.json("/api/sessions")).status).toBe(410);
		expect((await new Browser(hostOf("olga")).json("/api/sessions", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(410);
		// The username is never someone else's: apps and sign-ins were sent to its address.
		expect((await register("olga")).status).toBe(409);
		// Its agent and sign-in hold nothing.
		const memories = await runInDurableObject(env.Pim.getByName(olga.ownerId), (instance: Pim) => instance.memory.store.count());
		expect(memories).toBe(0);
		expect(await env.Auth.getByName(olga.ownerId).passkeys()).toEqual([]);
	});

	it("keeps a deletion that failed before erasing anything, closed and queued, and finishes it on retry", async () => {
		const rita = await person("rita");
		await rita.browser.json("/api/memory/log", { method: "POST", json: { text: "Rita's bank is in Porto" } });
		await rita.browser.json("/auth/tokens", { method: "POST", json: { name: "CLI" } });
		await runInDurableObject(env.Pim.getByName(rita.ownerId), async (instance: Pim) => {
			instance.store.putCredential("openai", JSON.stringify({ type: "oauth", access: "rita-access", refresh: "rita-refresh" }));
			await instance.schedule(new Date(Date.now() + 60 * 60_000), "runScheduledTask", { session: "1", instruction: "Call the bank" });
		});
		expect((await holdings(rita.ownerId)).remaining).toEqual(expect.arrayContaining(["credentials", "memories", "schedules", "owner profile"]));

		// The agent can't be reached: nothing is erased, and nothing says it was.
		await withAgentMethod(
			"deleteEverything",
			() => async () => {
				throw new Error("Network connection lost");
			},
			async () => {
				const response = await rita.browser.json("/api/account", { method: "DELETE", json: { confirm: "rita" } });
				expect(response.status).toBe(202);
				expect(response.body).toMatchObject({ deleted: false, status: "deleting" });
			},
		);
		// Closed at once, though: the hostname answers nothing, and the username stays taken.
		expect((await rita.browser.json("/api/sessions")).status).toBe(410);
		expect((await register("rita")).status).toBe(409);
		const queued = await directory().cleanup(rita.ownerId);
		expect(queued).toMatchObject({ kind: "deletion", attempts: 1, lastError: expect.stringContaining("still holds") });
		expect((await directory().account(rita.ownerId))?.status).toBe("deleting");
		const kept = await holdings(rita.ownerId);
		expect(kept.memories).toBe(1);
		expect(kept.passkeys).toBe(1);
		expect(await runInDurableObject(directory(), (_instance: Directory, state) => state.storage.getAlarm())).not.toBeNull();

		// The retry, on the Directory's alarm, erases everything and only then says so.
		await makeDue(directory(), rita.ownerId);
		expect(await runDurableObjectAlarm(directory())).toBe(true);
		expect((await directory().account(rita.ownerId))?.status).toBe("deleted");
		expect(await directory().cleanup(rita.ownerId)).toBeNull();
		expect(await holdings(rita.ownerId)).toEqual({ remaining: [], memories: 0, credentials: [], passkeys: 0, tokens: 0 });
	});

	it("doesn't report a deletion done when the agent can't even be addressed", async () => {
		const uma = await person("uma");
		await uma.browser.json("/api/memory/log", { method: "POST", json: { text: "Uma's diary" } });
		const agents = env.Pim as unknown as { idFromName: (name: string) => DurableObjectId };
		const real = agents.idFromName.bind(agents);
		agents.idFromName = () => {
			throw new Error("Durable Objects are down");
		};
		try {
			const response = await uma.browser.json("/api/account", { method: "DELETE", json: { confirm: "uma" } });
			expect(response.status).toBe(202);
			expect(response.body.deleted).toBe(false);
		} finally {
			agents.idFromName = real;
		}
		expect((await holdings(uma.ownerId)).memories).toBe(1);
		expect(await directory().cleanup(uma.ownerId)).toMatchObject({ kind: "deletion", lastError: "Durable Objects are down" });
		await makeDue(directory(), uma.ownerId);
		await runDurableObjectAlarm(directory());
		expect((await holdings(uma.ownerId)).remaining).toEqual([]);
		expect((await directory().account(uma.ownerId))?.status).toBe("deleted");
	});

	it("refuses a request authorized before the deletion that reaches the agent after it", async () => {
		const rex = await person("reviewrace");
		const token = (await rex.browser.json("/auth/tokens", { method: "POST", json: { name: "CLI" } })).body.token as string;
		// Hold the first valid token check after it says yes, until the deletion is done.
		const prototype = Auth.prototype as Auth;
		const original = prototype.checkToken;
		let entered!: () => void;
		const gateEntered = new Promise<void>((resolve) => (entered = resolve));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let held = false;
		prototype.checkToken = async function (this: Auth, ...args: Parameters<Auth["checkToken"]>) {
			const valid = await original.apply(this, args);
			if (valid && !held) {
				held = true;
				entered();
				await gate;
			}
			return valid;
		};
		try {
			const late = new Browser(hostOf("reviewrace")).json("/api/memory/log", {
				method: "POST",
				json: { text: "Written AFTER deletion" },
				headers: { Authorization: `Bearer ${token}` },
			});
			await gateEntered;
			expect((await rex.browser.json("/api/account", { method: "DELETE", json: { confirm: "reviewrace" } })).body).toEqual({ deleted: true });
			await new Promise((resolve) => setTimeout(resolve, 500));
			release();
			const write = await late;
			expect(write.status).toBe(410);
		} finally {
			prototype.checkToken = original;
		}
		expect(await holdings(rex.ownerId)).toMatchObject({ remaining: [], memories: 0 });
		expect((await directory().account(rex.ownerId))?.status).toBe("deleted");
	});

	it("counts a deletion done only when the agent is checked empty, whatever its call said", async () => {
		// The call that erases the agent can end abruptly after erasing it: that is done.
		const sam = await person("sam");
		await sam.browser.json("/api/memory/log", { method: "POST", json: { text: "Sam" } });
		await withAgentMethod(
			"deleteEverything",
			(original) =>
				async function (this: Pim) {
					await original.call(this);
					throw new Error("Durable Object reset");
				},
			async () => {
				expect((await sam.browser.json("/api/account", { method: "DELETE", json: { confirm: "sam" } })).body).toEqual({ deleted: true });
			},
		);
		expect((await holdings(sam.ownerId)).remaining).toEqual([]);

		// A call that returns without erasing anything is not.
		const tia = await person("tia");
		await tia.browser.json("/api/memory/log", { method: "POST", json: { text: "Tia" } });
		await withAgentMethod(
			"deleteEverything",
			() => async () => undefined,
			async () => {
				expect((await tia.browser.json("/api/account", { method: "DELETE", json: { confirm: "tia" } })).status).toBe(202);
			},
		);
		expect((await holdings(tia.ownerId)).memories).toBe(1);
		// The operator can retry it at once.
		expect((await admin("/admin/accounts/tia", { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await holdings(tia.ownerId)).remaining).toEqual([]);
		expect((await admin("/admin/accounts/tia")).body).toMatchObject({ account: { status: "deleted" }, cleanup: null });
	});
});

describe("the operator", () => {
	it("needs the admin token", async () => {
		expect((await new Browser(FRONT).json("/admin/stats")).status).toBe(401);
		expect((await admin("/admin/stats", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
		const stats = await admin("/admin/stats");
		expect(stats.status).toBe(200);
		expect(stats.body.accounts.active).toBeGreaterThan(0);
	});

	it("suspends a Pimling at once, and restores it", async () => {
		const pat = await person("pat");
		expect((await admin("/admin/accounts/pat/suspend", { method: "POST", json: { reason: "spam" } })).body.account).toMatchObject({
			status: "suspended",
			statusReason: "spam",
		});
		expect((await pat.browser.json("/api/sessions")).status).toBe(403);
		// The agent refuses too, whatever a Worker has cached.
		const agent = await runInDurableObject(env.Pim.getByName(pat.ownerId), (instance: Pim) => instance.status());
		expect(agent).toBe("suspended");
		await admin("/admin/accounts/pat/unsuspend", { method: "POST" });
		expect((await pat.browser.json("/api/sessions")).status).toBe(200);
	});

	it("sets one person's limits over everyone's", async () => {
		const quinn = await person("quinn");
		expect((await quinn.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: 300, sessions: 500 });
		await admin("/admin/accounts/quinn/limits", { method: "PUT", json: { limits: { dailyRuns: 0 } } });
		expect((await quinn.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: 0, sessions: 500 });
		const refused = await quinn.browser.json("/api/sessions/1/messages", { method: "POST", json: { content: "Hello" } });
		expect(refused.status).toBe(429);
		expect((await admin("/admin/accounts/quinn/limits", { method: "PUT", json: { limits: { dailyRuns: "lots" } } })).status).toBe(400);
		await admin("/admin/accounts/quinn/limits", { method: "PUT", json: { limits: null } });
		expect((await quinn.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: 300 });
	});
});

/**
 * What erasing an agent must stop, case by case: everything that could
 * still write to it, or act for its owner, once the Directory says it's gone.
 */
describe("erasure boundaries", () => {
	/**
	 * A gate a test holds work on inside an agent, and a flag that the work
	 * reached it. Only plain flags cross between the test and the agent, each
	 * polled with its own timers: a promise made in the test and awaited in an
	 * agent that then ends would hang the test runner itself.
	 */
	function gate() {
		const state = { reached: false, open: false };
		return {
			/** Called by the held work, in the agent. */
			hold: async () => {
				state.reached = true;
				while (!state.open) await new Promise((resolve) => setTimeout(resolve, 10));
			},
			/** Awaited by the test. */
			reached: () => vi.waitFor(() => expect(state.reached).toBe(true), { timeout: 5_000 }),
			release: () => {
				state.open = true;
			},
		};
	}

	async function expectErased(ownerId: string) {
		expect(await holdings(ownerId)).toEqual({ remaining: [], memories: 0, credentials: [], passkeys: 0, tokens: 0 });
		expect(await runInDurableObject(env.Pim.getByName(ownerId), (instance: Pim) => instance.erasure())).toEqual({ sealed: true, remaining: [] });
		expect((await directory().account(ownerId))?.status).toBe("deleted");
	}

	const deleteAccount = async (browser: Browser, username: string) =>
		(await browser.json("/api/account", { method: "DELETE", json: { confirm: username } })).body;

	it("closes a socket that was open across the deletion, and takes nothing from it", async () => {
		const ana = await person("eb-socket");
		const upgrade = await ana.browser.fetch("/api/ws?session=1", { headers: { Upgrade: "websocket", origin: hostOf("eb-socket") } });
		expect(upgrade.status).toBe(101);
		const socket = upgrade.webSocket!;
		const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
		const hello = new Promise<void>((resolve) => socket.addEventListener("message", () => resolve(), { once: true }));
		socket.accept();
		await hello;
		expect(await deleteAccount(ana.browser, "eb-socket")).toEqual({ deleted: true });
		expect(await closed).toBe(4010);
		// A submit sent on it afterwards goes nowhere.
		try {
			socket.send(JSON.stringify({ type: "submit", id: "late", content: "Sent on an old socket" }));
		} catch {
			// Closed: the send itself fails.
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
		await expectErased(ana.ownerId);
	});

	it("refuses the write of a request that was already inside the agent when the deletion began", async () => {
		const ben = await person("eb-inflight");
		const held = gate();
		const prototype = Pim.prototype as Pim;
		const original = prototype.submitTo;
		prototype.submitTo = async function (this: Pim, ...args: Parameters<Pim["submitTo"]>) {
			await held.hold();
			return original.apply(this, args);
		};
		try {
			// Past the Worker and the agent's own check, waiting just before it writes.
			const late = ben.browser.json("/api/sessions/1/messages", { method: "POST", json: { content: "Written after deletion" } });
			await held.reached();
			expect(await deleteAccount(ben.browser, "eb-inflight")).toEqual({ deleted: true });
			held.release();
			// The instance it was in ended: it gets "try again", and trying again gets "gone".
			expect(await late).toMatchObject({ status: 503 });
			const retry = await ben.browser.json("/api/sessions/1/messages", { method: "POST", json: { content: "Written after deletion" } });
			expect(retry.status).toBe(410);
		} finally {
			prototype.submitTo = original;
		}
		await expectErased(ben.ownerId);
	});

	it("keeps a model request under way from writing its answer", async () => {
		const cy = await person("eb-model");
		const held = gate();
		faux.setResponses([
			async () => {
				await held.hold();
				return fauxAssistantMessage("Written after deletion");
			},
		]);
		expect((await cy.browser.json("/api/sessions/1/messages", { method: "POST", json: { content: "Think slowly" } })).status).toBe(202);
		await held.reached();
		expect(await deleteAccount(cy.browser, "eb-model")).toEqual({ deleted: true });
		held.release();
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expectErased(cy.ownerId);
	});

	it("never runs an action whose approval timer outlives the agent", async () => {
		const dot = await person("eb-approval");
		// Auto-approve after the timeout: the dangerous case.
		expect((await dot.browser.json("/api/settings", { method: "PUT", json: { approvalPolicy: "auto" } })).body).toMatchObject({ approvalPolicy: "auto" });
		const realFetch = globalThis.fetch;
		const hook = vi.fn();
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith("https://hooks.example.test/")) return realFetch(input, init);
			hook(request.url);
			return new Response("sent", { status: 201 });
		});
		try {
			faux.setResponses([toolUse("http_request", { method: "POST", url: "https://hooks.example.test/after-deletion" })]);
			await dot.browser.json("/api/sessions/1/messages", { method: "POST", json: { content: "Send it" } });
			await vi.waitFor(async () => {
				const pending = await runInDurableObject(env.Pim.getByName(dot.ownerId), (instance: Pim) => instance.store.approvals("pending"));
				expect(pending).toHaveLength(1);
			});
			expect(await deleteAccount(dot.browser, "eb-approval")).toEqual({ deleted: true });
			// Past the test agent's 1.5-second timeout, which would have approved and sent it.
			await new Promise((resolve) => setTimeout(resolve, 2_500));
			expect(hook).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		await expectErased(dot.ownerId);
	});

	it("runs no scheduled work that comes due after the deletion", async () => {
		const eve = await person("eb-schedule");
		await runInDurableObject(env.Pim.getByName(eve.ownerId), async (instance: Pim) => {
			await instance.schedule(new Date(Date.now() + 200), "runScheduledTask", { session: "1", instruction: "Write something" });
		});
		expect(await deleteAccount(eve.browser, "eb-schedule")).toEqual({ deleted: true });
		await new Promise((resolve) => setTimeout(resolve, 300));
		// Wiping cleared the alarm; firing one anyway does nothing.
		await runDurableObjectAlarm(env.Pim.getByName(eve.ownerId));
		await expectErased(eve.ownerId);
	});

	it("refuses a Worker that still has the account cached, and the hosting service's own writes", async () => {
		const fay = await person("eb-stale");
		expect(await deleteAccount(fay.browser, "eb-stale")).toEqual({ deleted: true });
		// Another Worker that still has the account cached as active, with requests it already authorized.
		const stale: PimSite = {
			owner: fay.ownerId,
			agent: fay.ownerId,
			store: env.Auth.getByName(fay.ownerId),
			mode: "hosted",
			user: { id: "x", name: "eb-stale", displayName: "eb-stale" },
		};
		const write = new Request(`${hostOf("eb-stale")}/api/memory/log`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "Written by a stale gateway" }),
		});
		expect((await toAgent(write, env, stale, "/memory/log", true)).status).toBe(410);
		const socket = new Request(`${hostOf("eb-stale")}/api/ws?session=1`, { headers: { Upgrade: "websocket" } });
		expect((await toAgent(socket, env, stale, "/ws", true)).status).toBe(410);
		const callback = new Request(`${hostOf("eb-stale")}/mcp/events/watch-1`, { method: "POST", body: "{}" });
		expect((await toAgent(callback, env, stale, "/mcp/events/watch-1", false)).status).toBe(410);
		const writes: ((instance: Pim) => Promise<unknown>)[] = [
			(instance) => instance.provision({ ownerId: fay.ownerId, username: "eb-stale", publicUrl: hostOf("eb-stale") }),
			(instance) => instance.applySettings({ timeZone: "Asia/Tokyo" }),
			(instance) => instance.setLimits({ dailyRuns: 1 }),
			(instance) => instance.submitTo("1", "Hello", {}, "pim"),
		];
		for (const write of writes) {
			await expect(runInDurableObject(env.Pim.getByName(fay.ownerId), write)).rejects.toThrow(/erased/);
		}
		await expectErased(fay.ownerId);
	});
});
