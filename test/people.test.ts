import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Auth } from "../src/auth";
import type { Directory, RegistrationPolicy } from "../src/directory";
import { toAgent } from "../src/gateway";
import { z } from "zod";
import { faux, Pim } from "./worker";
import { Authenticator } from "./webauthn";

/**
 * Several people on one Pim: registering, keeping each person's things
 * their own, adding devices, recovery, accounts, the admin, erasure, and
 * what people share with each other.
 */

const ORIGIN = "https://pim.test";

afterEach(() => {
	// Every scripted model response was used.
	expect(faux.getPendingResponseCount()).toBe(0);
});

let browsers = 0;

/** One browser, from its own address: keeps the cookies the Worker sets, sends them back. */
class Browser {
	cookies = new Map<string, string>();

	constructor(readonly ip = `203.0.${Math.floor(++browsers / 250)}.${browsers % 250}`) {}

	async fetch(path: string, init: RequestInit & { json?: unknown } = {}) {
		const headers = new Headers(init.headers);
		if (!headers.has("origin") && init.method && init.method !== "GET") headers.set("origin", ORIGIN);
		if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
		if (init.json !== undefined) headers.set("content-type", "application/json");
		headers.set("CF-Connecting-IP", this.ip);
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}${path}`, { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) }),
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

type Registered = { username: string; role: string; setup: string; recoveryCodes: string[] };

let addresses = 0;
/** Registers from a fresh address, so the per-address limit is only met where a test means to. */
async function register(username: string, extra: Record<string, unknown> = {}) {
	const browser = new Browser(`198.51.100.${++addresses}`);
	return browser.json<Registered & { error?: string }>("/auth/register", { method: "POST", json: { username, ...extra } });
}

async function addPasskey(browser: Browser, authenticator: Authenticator, allowedBy: Record<string, string> = {}) {
	const options = await browser.json("/auth/passkeys/options", { method: "POST", json: allowedBy });
	if (options.status !== 200) return options.status;
	return (await browser.fetch("/auth/passkeys", { method: "POST", json: await authenticator.register(options.body) })).status;
}

async function signIn(browser: Browser, authenticator: Authenticator) {
	const options = await browser.json("/auth/sign-in/options", { method: "POST" });
	return (await browser.fetch("/auth/sign-in", { method: "POST", json: await authenticator.sign(options.body) })).status;
}

/** A registered, set-up person, and a browser signed in as them. */
async function person(username: string, extra: Record<string, unknown> = {}) {
	const registered = await register(username, extra);
	expect(registered.status).toBe(201);
	const browser = new Browser();
	const passkey = await Authenticator.make();
	const setup = registered.body.setup;
	expect(await addPasskey(browser, passkey, { setup })).toBe(200);
	const account = (await browser.json("/api/account")).body as { ownerId: string };
	return { browser, passkey, registered: registered.body, setup, ownerId: account.ownerId };
}

/** The public id of the person's root session. */
async function rootOf(browser: Browser): Promise<string> {
	return (await browser.json("/api/")).body.rootSession;
}

const directory = () => env.Directory.getByName("directory");
const OPEN: RegistrationPolicy = { mode: "open", maxAccounts: null, perAddressPerDay: 100 };
/** A Directory of its own, with only its admin, for tests that need an otherwise empty one. */
async function freshDirectory() {
	const stub = env.Directory.getByName(`fresh-${crypto.randomUUID()}`);
	const admin = await stub.register({ username: "keeper", ip: "0", claim: { window: true }, policy: OPEN });
	if (!admin.ok) throw new Error(admin.error);
	await stub.activate(admin.account.ownerId);
	return stub;
}

/** The person running this Pim: they claimed it with the link from the logs before anyone else registered. */
let operator: Awaited<ReturnType<typeof person>>;

beforeAll(async () => {
	const { code } = await directory().claimCode();
	operator = await person("boss", { claim: code });
	expect(operator.registered.role).toBe("admin");
});

/** The admin's API, as the admin's signed-in browser calls it. */
const admin = (path: string, init: RequestInit & { json?: unknown } = {}) => operator.browser.json(path, init);

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

/** Swaps a method of the test space for the length of `run`. */
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

const toolUse = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });

describe("registration", () => {
	it("gives a username its own space, set up with a one-time link, and recovery codes", async () => {
		const { status, body } = await register("alice", { timeZone: "Europe/Lisbon" });
		expect(status).toBe(201);
		expect(body).toMatchObject({ username: "alice", role: "member", setup: expect.stringMatching(/^o_[0-9a-z]{26}\.[\w-]+$/) });
		expect(body.recoveryCodes).toHaveLength(10);

		const browser = new Browser();
		expect((await browser.json("/auth/session")).body).toMatchObject({ signedIn: false, claimed: true, canClaim: false });
		// The account opens nothing without its setup link.
		const passkey = await Authenticator.make();
		expect(await addPasskey(browser, passkey)).toBe(401);
		const setup = body.setup;
		expect(await addPasskey(browser, passkey, { setup })).toBe(200);

		const account = await browser.json("/api/account");
		expect(account.body).toMatchObject({ username: "alice", role: "member", status: "active", ownerId: expect.stringMatching(/^o_[0-9a-z]{26}$/) });
		expect((await browser.json("/api/settings")).body).toMatchObject({ timeZone: "Europe/Lisbon", approvalPolicy: "auto" });
		// The link works once.
		expect(await addPasskey(new Browser(), await Authenticator.make(), { setup })).toBe(401);
	});

	it("refuses taken, reserved and malformed usernames", async () => {
		await register("carol");
		expect((await register("carol")).status).toBe(409);
		expect((await register("admin")).body.error).toBe("That username is reserved.");
		for (const bad of ["ab", "bad_name", "a--b", "-lead", "trail-", "x".repeat(33)]) {
			expect((await register(bad)).status, bad).toBe(400);
		}
		const front = new Browser();
		expect((await front.json("/auth/username?name=carol")).body).toEqual({ available: false, reason: "That username is taken." });
		expect((await front.json("/auth/username?name=dave")).body).toEqual({ available: true });
	});

	it("comes only from this Pim's own pages", async () => {
		const response = await new Browser().fetch("/auth/register", {
			method: "POST",
			json: { username: "mallory" },
			headers: { origin: "https://evil.example" },
		});
		expect(response.status).toBe(403);
	});

	it("limits registrations from one address in a day", async () => {
		const front = new Browser("192.0.2.77");
		for (const name of ["dee1", "dee2", "dee3"]) {
			expect((await front.json("/auth/register", { method: "POST", json: { username: name } })).status).toBe(201);
		}
		const refused = await front.json("/auth/register", { method: "POST", json: { username: "dee4" } });
		expect(refused.status).toBe(429);
	});

	it("takes invite codes once, when registration needs them", async () => {
		const policy = { mode: "invite" as const, maxAccounts: null, perAddressPerDay: 100 };
		const [code] = (await admin("/api/admin/invites", { method: "POST", json: { count: 1 } })).body.codes as string[];
		await runInDurableObject(directory(), async (instance: Directory) => {
			expect(await instance.register({ username: "ivy", ip: "1", policy })).toMatchObject({ ok: false, status: 403 });
			expect(await instance.register({ username: "ivy", ip: "1", policy, invite: code! })).toMatchObject({ ok: true });
			expect(await instance.register({ username: "ivo", ip: "1", policy, invite: code! })).toMatchObject({ ok: false, status: 403 });
		});
	});

	it("gives the username back at once when the account can't be set up", async () => {
		const agents = env.Pim as unknown as { idFromName: (name: string) => DurableObjectId };
		const real = agents.idFromName.bind(agents);
		agents.idFromName = () => {
			throw new Error("Durable Objects are down");
		};
		try {
			const failed = await register("ursula");
			expect(failed.status).toBe(500);
			expect(failed.body.error).toBe("Your account couldn't be set up. Try again in a moment.");
		} finally {
			agents.idFromName = real;
		}
		expect((await new Browser().json("/auth/username?name=ursula")).body).toEqual({ available: true });
		expect((await register("ursula")).status).toBe(201);
	});

	it("gives an invite back with the username when the account can't be set up", async () => {
		const registration = env as unknown as { PIM_REGISTRATION: string };
		const agents = env.Pim as unknown as { idFromName: (name: string) => DurableObjectId };
		const real = agents.idFromName.bind(agents);
		registration.PIM_REGISTRATION = "invite";
		try {
			const [code] = (await admin("/api/admin/invites", { method: "POST", json: { count: 1 } })).body.codes as string[];
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
			registration.PIM_REGISTRATION = "open";
		}
	});

	it("counts someone else as here only while their account is active", async () => {
		const stub = await freshDirectory();
		const keeper = (await stub.resolve("keeper"))!;
		expect(await stub.hasOthers(keeper.ownerId)).toBe(false);
		const joined = await stub.register({ username: "newcomer", ip: "1", policy: OPEN });
		if (!joined.ok) throw new Error(joined.error);
		// Registered, but no passkey yet.
		expect(await stub.hasOthers(keeper.ownerId)).toBe(false);
		await stub.activate(joined.account.ownerId);
		expect(await stub.hasOthers(keeper.ownerId)).toBe(true);
		expect(await stub.hasOthers(joined.account.ownerId)).toBe(true);
		await stub.setStatus(joined.account.ownerId, "suspended", null);
		expect(await stub.hasOthers(keeper.ownerId)).toBe(false);
		// The admin of the shared Pim isn't alone: everyone these tests register is here too.
		expect((await operator.browser.json("/api/account")).body).toMatchObject({ alone: false });
	});

	it("keeps invites single-use, giving one back only with the registration that used it", async () => {
		const stub = await freshDirectory();
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
		const stub = await freshDirectory();
		// Room for the admin and one more.
		const policy: RegistrationPolicy = { mode: "invite", maxAccounts: 2, perAddressPerDay: 100 };
		const [code] = await stub.createInvites(1, null);
		// Registered 25 hours ago, and never set up. (Real times: the Directory's alarm runs on the clock.)
		const later = Date.now();
		const lapsed = await stub.register({ username: "expired", ip: "1", policy, invite: code!, now: later - 25 * 60 * 60 * 1000 });
		expect(lapsed.ok).toBe(true);
		expect(await stub.resolve("expired", later)).toBeNull();
		// Its place under maxAccounts and its invite are free again.
		const again = await stub.register({ username: "expired", ip: "2", policy, invite: code!, now: later });
		expect(again).toMatchObject({ ok: true });
		expect(await stub.register({ username: "another", ip: "3", policy: { ...OPEN, maxAccounts: 2 }, now: later })).toMatchObject({
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
		expect((await new Browser().json("/auth/username?name=gone")).body).toEqual({ available: true });
		expect((await register("gone")).status).toBe(201);
		const now = await runInDurableObject(directory(), (instance: Directory) => instance.resolve("gone"));
		expect(now?.ownerId).not.toBe(lapsed.ok && lapsed.account.ownerId);
	});
});

describe("isolation between people", () => {
	it("a session or a passkey opens only its owner's space", async () => {
		const erin = await person("erin");
		const frank = await person("frank");
		expect(erin.ownerId).not.toBe(frank.ownerId);
		await erin.browser.json("/api/memory/log", { method: "POST", json: { text: "Erin's locker code is 4512" } });
		expect(JSON.stringify((await frank.browser.json("/api/memory/log")).body)).not.toContain("4512");
		// Signing in with Erin's passkey anywhere opens Erin's space, never Frank's.
		const elsewhere = new Browser();
		expect(await signIn(elsewhere, erin.passkey)).toBe(200);
		expect((await elsewhere.json("/api/account")).body).toMatchObject({ username: "erin" });
		expect(JSON.stringify((await elsewhere.json("/api/memory/log")).body)).toContain("4512");
	});

	it("an API token opens only its owner's space, and can't manage tokens", async () => {
		const gina = await person("gina");
		const hank = await person("hank");
		const made = await gina.browser.json("/auth/tokens", { method: "POST", json: { name: "Phone" } });
		expect(made.status).toBe(201);
		const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
		expect((await new Browser().json("/api/account", bearer(made.body.token))).body).toMatchObject({ username: "gina" });
		// Gina's secret under Hank's owner ID opens nothing.
		expect((await new Browser().json("/api/sessions", bearer(made.body.token.replace(gina.ownerId, hank.ownerId)))).status).toBe(401);
		// Tokens can't be made or listed with a token.
		expect((await new Browser().json("/auth/tokens", bearer(made.body.token))).status).toBe(401);
		expect((await gina.browser.json("/auth/tokens")).body.tokens).toEqual([expect.objectContaining({ name: "Phone", id: made.body.id })]);
		expect(JSON.stringify((await gina.browser.json("/auth/tokens")).body)).not.toContain(made.body.token);
		expect((await gina.browser.json(`/auth/tokens/${made.body.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await new Browser().json("/api/sessions", bearer(made.body.token))).status).toBe(401);
	});

	it("conversations, memories and ChatGPT sign-ins stay with their owner", async () => {
		const ian = await person("ian");
		const jo = await person("joy");
		const noted = await ian.browser.json("/api/memory/log", { method: "POST", json: { text: "Ian's passport expires in May" } });
		expect(noted.body).toMatchObject({ text: expect.stringContaining("passport") });
		faux.setResponses([toolUse("send_to_user", { message: "Noted, Ian." })]);
		expect((await ian.browser.json(`/api/sessions/${await rootOf(ian.browser)}/messages`, { method: "POST", json: { content: "Hi, I'm Ian", wait: true } })).body).toMatchObject({
			status: "done",
		});
		await runInDurableObject(env.Pim.getByName(ian.ownerId), (instance: Pim) => {
			instance.store.putCredential("openai", JSON.stringify({ type: "oauth", access: "ian-access", refresh: "ian-refresh", email: "ian@example.com" }));
		});

		const joMemory = (await jo.browser.json("/api/memory/log")).body;
		expect(JSON.stringify(joMemory)).not.toContain("passport");
		expect((await jo.browser.json(`/api/sessions/${await rootOf(jo.browser)}/messages`)).body.messages).toEqual([]);
		// Each Pim names its chats with ids of its own: Ian's main chat is no chat of Jo's.
		const ianRoot = await rootOf(ian.browser);
		expect(ianRoot).not.toBe(await rootOf(jo.browser));
		expect((await jo.browser.json(`/api/sessions/${ianRoot}/messages`)).status).toBe(404);
		expect((await jo.browser.json("/api/chatgpt")).body).toEqual({ connected: false, email: null });
		expect((await ian.browser.json("/api/chatgpt")).body).toEqual({ connected: true, email: "ian@example.com" });
		// Each person's space is its own agent host to OpenAI.
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
			const connected = await gus.browser.json("/api/mcp", { method: "POST", json: { app: "test.ledger/notes" } });
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
		expect((await hal.browser.json("/api/settings")).body).toMatchObject({ timeZone: "America/New_York", approvalPolicy: "auto" });
	});

	it("an owner ID alone opens nothing", async () => {
		const kim = await person("kim");
		expect((await new Browser().json("/api/sessions")).status).toBe(401);
		// Apps' callbacks name the owner, and are checked another way: by the OAuth state, or the watch's signature.
		expect((await new Browser().fetch(`/mcp/events/${kim.ownerId}/no-such-watch`, { method: "POST", json: {} })).status).toBe(410);
		expect((await new Browser().fetch("/mcp/events/o_nobody/no-such-watch", { method: "POST", json: {} })).status).toBe(404);
		// The logs' setup link is the admin's, never a member's.
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			expect((await new Browser().json("/auth/setup-link", { method: "POST" })).status).toBe(200);
			const line = String(log.mock.calls.findLast((call) => String(call[0]).includes("#setup="))?.[0]);
			expect(line).toContain(`#setup=${operator.ownerId}.`);
			expect(line).not.toContain(kim.ownerId);
		} finally {
			log.mockRestore();
		}
	});

	it("slows down guessing from one address", async () => {
		await person("lars");
		const guesser = new Browser();
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 31; attempt++) {
			statuses.push((await guesser.fetch("/auth/passkeys/options", { method: "POST", json: { username: "lars", recovery: `guess-${attempt}` } })).status);
		}
		// AUTH_LIMITER allows 30 a minute.
		expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
		expect(statuses[30]).toBe(429);
	});
});


/** A device link made by a signed-in browser, and its code. */
async function deviceLink(browser: Browser) {
	const made = await browser.json("/auth/device-link", { method: "POST" });
	expect(made.status).toBe(201);
	return { ...made.body, code: new URL(made.body.url).hash.replace("#device=", "") } as { url: string; expiresAt: string; code: string };
}

describe("adding another device", () => {
	it("lets a signed-in browser link a phone, which makes its own passkey, once", async () => {
		const ada = await person("dl-ada");
		const before = (await ada.browser.json("/auth/passkeys")).body.passkeys;
		const codesBefore = (await ada.browser.json("/auth/recovery-codes")).body.left;
		const link = await deviceLink(ada.browser);
		// Naming its owner, with the code in the fragment, for ten minutes.
		expect(link.url).toMatch(new RegExp(`^${ORIGIN}/#device=${ada.ownerId}\\.[\\w-]{40,}$`));
		expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
		expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000);

		const phone = new Browser();
		const phonePasskey = await Authenticator.make();
		expect((await phone.json("/api/sessions")).status).toBe(401);
		expect(await addPasskey(phone, phonePasskey, { device: link.code })).toBe(200);
		expect((await phone.json("/api/sessions")).status).toBe(200);
		// Later, the phone signs in with its own passkey.
		expect(await signIn(new Browser(), phonePasskey)).toBe(200);
		// A second passkey: the first one, its session and the recovery codes are untouched.
		const after = (await ada.browser.json("/auth/passkeys")).body.passkeys;
		expect(after).toHaveLength(before.length + 1);
		expect(after.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(before.map((p: { id: string }) => p.id)));
		expect((await ada.browser.json("/api/sessions")).status).toBe(200);
		expect((await ada.browser.json("/auth/recovery-codes")).body.left).toBe(codesBefore);
		// Once only, even from another tab.
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: link.code })).toBe(401);
	});

	it("lets only one of two tabs that opened the same link finish", async () => {
		const bo = await person("dl-race");
		const { code } = await deviceLink(bo.browser);
		const [one, two] = [new Browser(), new Browser()];
		const [k1, k2] = [await Authenticator.make(), await Authenticator.make()];
		const o1 = await one.json("/auth/passkeys/options", { method: "POST", json: { device: code } });
		const o2 = await two.json("/auth/passkeys/options", { method: "POST", json: { device: code } });
		expect([o1.status, o2.status]).toEqual([200, 200]);
		const results = await Promise.all([
			one.fetch("/auth/passkeys", { method: "POST", json: await k1.register(o1.body) }),
			two.fetch("/auth/passkeys", { method: "POST", json: await k2.register(o2.body) }),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
	});

	it("is issued only to a browser signed in with a passkey", async () => {
		const cy = await person("dl-issue");
		const token = (await cy.browser.json("/auth/tokens", { method: "POST", json: { name: "CLI" } })).body.token as string;
		// Not to an API token, not to nobody, and not from another site.
		expect((await new Browser().json("/auth/device-link", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
		expect((await new Browser().json("/auth/device-link", { method: "POST" })).status).toBe(401);
		expect((await cy.browser.json("/auth/device-link", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
		// It grants a passkey and nothing else: no API token, no admin, no recovery codes.
		const { code } = await deviceLink(cy.browser);
		const bearer = (value: string) => ({ headers: { Authorization: `Bearer ${value}` } });
		expect((await new Browser().json("/api/sessions", bearer(code))).status).toBe(401);
		expect((await new Browser().json("/api/admin/stats", bearer(code))).status).toBe(401);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { username: "dl-issue", recovery: code })).toBe(401);
	});

	it("works only for the person who made it", async () => {
		const dee = await person("dl-dee");
		const eve = await person("dl-eve");
		const { code } = await deviceLink(dee.browser);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: code.replace(dee.ownerId, eve.ownerId) })).toBe(401);
		// Still good for Dee afterwards.
		const phone = new Browser();
		expect(await addPasskey(phone, await Authenticator.make(), { device: code })).toBe(200);
		expect((await phone.json("/api/account")).body).toMatchObject({ username: "dl-dee" });
	});

	it("stops working when it expires, when a newer one is made, or when its browser signs out", async () => {
		const fin = await person("dl-fin");
		// Expired.
		const old = await deviceLink(fin.browser);
		await runInDurableObject(env.Auth.getByName(fin.ownerId), (_instance: Auth, state) => {
			state.storage.sql.exec("UPDATE auth_device_links SET expires_at = ?", Date.now() - 1);
		});
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: old.code })).toBe(401);
		// Replaced by a newer one.
		const first = await deviceLink(fin.browser);
		const second = await deviceLink(fin.browser);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: first.code })).toBe(401);
		// Its browser signs out.
		expect((await fin.browser.json("/auth/sign-out", { method: "POST" })).status).toBe(200);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: second.code })).toBe(401);
	});

	it("stops working when the passkey that made it is removed, even after the options were given", async () => {
		const gus = await person("dl-gus");
		const extra = new Browser();
		const { code: second } = await deviceLink(gus.browser);
		expect(await addPasskey(extra, await Authenticator.make(), { device: second })).toBe(200);
		// The original browser makes a link, and someone starts using it.
		const { code } = await deviceLink(gus.browser);
		const phone = new Browser();
		const options = await phone.json("/auth/passkeys/options", { method: "POST", json: { device: code } });
		expect(options.status).toBe(200);
		// Meanwhile the owner removes the original passkey from the other device.
		const passkeys = (await extra.json("/auth/passkeys")).body.passkeys as { id: string }[];
		const own = (await extra.json("/auth/session")).body.passkey as string;
		const original = passkeys.find((p) => p.id !== own)!;
		expect((await extra.json(`/auth/passkeys/${encodeURIComponent(original.id)}`, { method: "DELETE" })).status).toBe(200);
		const finish = await phone.fetch("/auth/passkeys", { method: "POST", json: await (await Authenticator.make()).register(options.body) });
		expect(finish.status).toBe(401);
	});

	it("stops working when its browser cancels it, and only that browser's link", async () => {
		const ivo = await person("dl-cancel");
		const { code } = await deviceLink(ivo.browser);
		expect((await new Browser().json("/auth/device-link", { method: "DELETE" })).status).toBe(401);
		expect((await ivo.browser.json("/auth/device-link", { method: "DELETE" })).body).toEqual({ ok: true });
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: code })).toBe(401);
	});

	it("checks expiry again when the passkey is finished, not only when it's started", async () => {
		const jo = await person("dl-late");
		const { code } = await deviceLink(jo.browser);
		const phone = new Browser();
		const options = await phone.json("/auth/passkeys/options", { method: "POST", json: { device: code } });
		expect(options.status).toBe(200);
		// The link runs out while the phone is still asking for a fingerprint.
		await runInDurableObject(env.Auth.getByName(jo.ownerId), (_instance: Auth, state) => {
			state.storage.sql.exec("UPDATE auth_device_links SET expires_at = ?", Date.now() - 1);
		});
		const finish = await phone.fetch("/auth/passkeys", { method: "POST", json: await (await Authenticator.make()).register(options.body) });
		expect(finish.status).toBe(401);
	});

	it("keeps setup codes and device links apart", async () => {
		const kai = await person("dl-apart");
		const { body } = await admin("/api/admin/accounts/dl-apart/setup-link", { method: "POST" });
		const setup = body.setupUrl.split("#setup=")[1]!;
		const { code } = await deviceLink(kai.browser);
		// Neither works as the other.
		expect(await addPasskey(new Browser(), await Authenticator.make(), { setup: code })).toBe(401);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: setup })).toBe(401);
		// Using one leaves the other working.
		expect(await addPasskey(new Browser(), await Authenticator.make(), { setup })).toBe(200);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: code })).toBe(200);
	});

	it("can't add a device to a suspended or deleted account", async () => {
		const hal = await person("dl-hal");
		const suspended = await deviceLink(hal.browser);
		await admin("/api/admin/accounts/dl-hal/suspend", { method: "POST" });
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: suspended.code })).toBe(401);
		await admin("/api/admin/accounts/dl-hal/unsuspend", { method: "POST" });
		const { code } = await deviceLink(hal.browser);
		expect((await hal.browser.json("/api/account", { method: "DELETE", json: { confirm: "dl-hal" } })).body).toEqual({ deleted: true });
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: code })).toBe(401);
		expect(await env.Auth.getByName(hal.ownerId).passkeys()).toEqual([]);
	});
});

describe("recovery", () => {
	it("a recovery code makes one new passkey, once", async () => {
		const lee = await person("lee");
		const lost = new Browser();
		const replacement = await Authenticator.make();
		const code = lee.registered.recoveryCodes[0]!;
		expect(await addPasskey(lost, replacement, { username: "lee", recovery: "wrong-code-12345" })).toBe(401);
		// Typed loosely: upper case, no dashes, and the username with an @.
		expect(await addPasskey(lost, replacement, { username: "@Lee", recovery: code.replaceAll("-", "").toUpperCase() })).toBe(200);
		expect((await lost.json("/api/sessions")).status).toBe(200);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { username: "lee", recovery: code })).toBe(401);
		expect((await lost.json("/auth/recovery-codes")).body).toEqual({ left: 9 });

		// A new set replaces the old one.
		const fresh = (await lost.json("/auth/recovery-codes", { method: "POST" })).body.codes as string[];
		expect(fresh).toHaveLength(10);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { username: "lee", recovery: lee.registered.recoveryCodes[1]! })).toBe(401);
		expect((await new Browser().json("/auth/recovery-codes", { method: "POST" })).status).toBe(401);
	});

	it("voids the registration's setup link once the first passkey is made another way", async () => {
		const registered = await register("rv-first");
		expect(registered.status).toBe(201);
		const setup = registered.body.setup;
		// Activated with a recovery code instead of the link.
		expect(await addPasskey(new Browser(), await Authenticator.make(), { username: "rv-first", recovery: registered.body.recoveryCodes[0]! })).toBe(200);
		// The link from registration, still within its day, makes nothing now.
		expect(await addPasskey(new Browser(), await Authenticator.make(), { setup })).toBe(401);
	});

	it("leaves an admin's setup link working when another device is linked meanwhile", async () => {
		const ola = await person("rv-operator");
		const { body } = await admin("/api/admin/accounts/rv-operator/setup-link", { method: "POST" });
		const setup = body.setupUrl.split("#setup=")[1]!;
		// Another device is added with a device link: the admin's link is a separate record.
		const { code } = await deviceLink(ola.browser);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { device: code })).toBe(200);
		expect(await addPasskey(new Browser(), await Authenticator.make(), { setup })).toBe(200);
	});

	it("the admin can issue a setup link, for someone who lost everything", async () => {
		await person("max");
		const { body } = await admin("/api/admin/accounts/max/setup-link", { method: "POST" });
		const setup = body.setupUrl.split("#setup=")[1]!;
		const browser = new Browser();
		expect(await addPasskey(browser, await Authenticator.make(), { setup })).toBe(200);
		expect((await browser.json("/api/sessions")).status).toBe(200);
	});
});

describe("the account", () => {
	it("exports the person's data without secrets", async () => {
		const nia = await person("nia");
		await nia.browser.json("/api/memory/log", { method: "POST", json: { text: "Nia plays the cello" } });
		const token = (await nia.browser.json("/auth/tokens", { method: "POST", json: { name: "CLI" } })).body.token as string;
		const response = await nia.browser.fetch("/api/account/export");
		expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="pim-nia-/);
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
		const withToken = new Browser();
		const tokenDelete = await withToken.json("/api/account", { method: "DELETE", json: { confirm: "olga" }, headers: { Authorization: `Bearer ${token}` } });
		expect(tokenDelete.status).toBe(403);
		expect((await olga.browser.json("/api/account", { method: "DELETE", json: { confirm: "olgaa" } })).status).toBe(400);

		const otherDevice = new Browser();
		otherDevice.cookies = new Map(olga.browser.cookies);
		expect((await olga.browser.json("/api/account", { method: "DELETE", json: { confirm: "olga" } })).body).toEqual({ deleted: true });
		// This browser is signed out; one still holding the session finds the account gone.
		expect((await olga.browser.json("/api/sessions")).status).toBe(401);
		expect((await otherDevice.json("/api/sessions")).status).toBe(410);
		expect((await new Browser().json("/api/sessions", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(410);
		// The username is never someone else's: others knew Olga by it.
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
			// Images are kept in R2, outside the space's storage.
			await instance.images.keep("1", [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
		});
		expect((await holdings(rita.ownerId)).remaining).toEqual(
			expect.arrayContaining(["credentials", "memories", "schedules", "owner profile", "images"]),
		);

		// The space can't be reached: nothing is erased, and nothing says it was.
		await withAgentMethod(
			"deleteEverything",
			() => async () => {
				throw new Error("Network connection lost");
			},
			async () => {
				const before = new Map(rita.browser.cookies);
				const response = await rita.browser.json("/api/account", { method: "DELETE", json: { confirm: "rita" } });
				// As another device still holding the session would.
				rita.browser.cookies = before;
				expect(response.status).toBe(202);
				expect(response.body).toMatchObject({ deleted: false, status: "deleting" });
			},
		);
		// Closed at once, though: it opens nothing, and the username stays taken.
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

	it("doesn't report a deletion done when the space can't even be addressed", async () => {
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

	it("refuses a request authorized before the deletion that reaches the space after it", async () => {
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
			const late = new Browser().json("/api/memory/log", {
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

	it("counts a deletion done only when the space is checked empty, whatever its call said", async () => {
		// The call that erases the space can end abruptly after erasing it: that is done.
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
		// The admin can retry it at once.
		expect((await admin("/api/admin/accounts/tia", { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await holdings(tia.ownerId)).remaining).toEqual([]);
		expect((await admin("/api/admin/accounts/tia")).body).toMatchObject({ account: { status: "deleted" }, cleanup: null });
	});
});

/** Has the person's space make an HTML artifact, as its model would, and returns its id. */
async function makeArtifact(browser: Browser, content: string) {
	faux.setResponses([toolUse("artifact_create", { title: "Page", kind: "html", content }), toolUse("send_to_user", { message: "Made it." })]);
	expect((await browser.json(`/api/sessions/${await rootOf(browser)}/messages`, { method: "POST", json: { content: "Make a page", wait: true } })).status).toBe(200);
	const { artifacts } = (await browser.json("/api/artifacts")).body as { artifacts: { id: string; title: string }[] };
	return artifacts[0]!.id;
}

describe("artifacts", () => {
	it("are shown only to their owner", async () => {
		const ada = await person("art-ada");
		const bo = await person("art-bo");
		const id = await makeArtifact(ada.browser, "<p>Ada's plans</p>");
		const frame = await ada.browser.fetch(`/api/artifacts/${id}/versions/1/frame`);
		expect(frame.status).toBe(200);
		expect(frame.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
		expect(frame.headers.get("content-security-policy")).toContain(`frame-ancestors ${ORIGIN}`);
		expect(await frame.text()).toContain("Ada's plans");
		// Bo's space has no such artifact, signed in or not, whatever path is asked.
		for (const path of [`/api/artifacts/${id}`, `/api/artifacts/${id}/versions/1`, `/api/artifacts/${id}/versions/1/frame`, `/api/artifacts/${id}/versions/1/download`]) {
			expect((await bo.browser.fetch(path)).status).toBe(404);
		}
		expect((await bo.browser.json("/api/artifacts")).body.artifacts).toEqual([]);
		// Nor anyone not signed in.
		expect((await new Browser().fetch(`/api/artifacts/${id}/versions/1/frame`)).status).toBe(401);
	});

	it("stop showing when the browser signs out, its passkey is removed, the account is suspended, or it is deleted", async () => {
		const cy = await person("art-cy");
		const id = await makeArtifact(cy.browser, "<p>Cy's page</p>");
		const frame = `/api/artifacts/${id}/versions/1/frame`;
		// Signed out: the next load is refused (nothing was cached to show instead).
		const other = new Browser();
		expect(await signIn(other, cy.passkey)).toBe(200);
		expect((await other.fetch(frame)).status).toBe(200);
		expect((await other.json("/auth/sign-out", { method: "POST" })).status).toBe(200);
		expect((await other.fetch(frame)).status).toBe(401);
		// Its passkey removed from another browser: the next load is refused.
		const phone = new Browser();
		const phoneKey = await Authenticator.make();
		expect(await addPasskey(phone, phoneKey, { username: "art-cy", recovery: cy.registered.recoveryCodes[0]! })).toBe(200);
		expect((await phone.fetch(frame)).status).toBe(200);
		const { passkeys } = (await cy.browser.json("/auth/passkeys")).body as { passkeys: { id: string }[] };
		const mine = (await phone.json("/auth/session")).body.passkey as string;
		expect(passkeys.map((passkey) => passkey.id)).toContain(mine);
		expect((await cy.browser.fetch(`/auth/passkeys/${encodeURIComponent(mine)}`, { method: "DELETE" })).status).toBe(200);
		expect((await phone.fetch(frame)).status).toBe(401);
		expect((await cy.browser.fetch(frame)).status).toBe(200);
		// Suspended.
		await admin("/api/admin/accounts/art-cy/suspend", { method: "POST", json: { reason: "test" } });
		expect((await cy.browser.fetch(frame)).status).toBe(403);
		await admin("/api/admin/accounts/art-cy/unsuspend", { method: "POST" });
		expect((await cy.browser.fetch(frame)).status).toBe(200);
		// In the export, every version.
		const exported = JSON.parse(await (await cy.browser.fetch("/api/account/export")).text());
		expect(exported.pim.artifacts).toEqual([expect.objectContaining({ id, versions: [expect.objectContaining({ version: 1, content: "<p>Cy's page</p>" })] })]);
		// A deleted artifact leaves its id behind, not in the export; erasing the account takes that too.
		const gone = await makeArtifact(cy.browser, "<p>Cy's other page</p>");
		expect((await cy.browser.json(`/api/artifacts/${gone}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await holdings(cy.ownerId)).remaining).toContain("deleted artifact ids");
		expect(JSON.stringify(JSON.parse(await (await cy.browser.fetch("/api/account/export")).text()).pim.artifacts)).not.toContain(gone);
		// Deleted: gone, and the space holds nothing.
		const before = new Map(cy.browser.cookies);
		expect((await cy.browser.json("/api/account", { method: "DELETE", json: { confirm: "art-cy" } })).body).toEqual({ deleted: true });
		// As another device still holding the session would.
		cy.browser.cookies = before;
		for (const path of [frame, `/api/artifacts/${id}/versions/1/download`, `/api/artifacts/${id}`]) {
			expect((await cy.browser.fetch(path)).status).toBe(410);
		}
		expect(await holdings(cy.ownerId)).toMatchObject({ remaining: [] });
	});
});

describe("the admin", () => {
	it("is the one who claimed the Pim, signed in with a passkey", async () => {
		const ron = await person("ron");
		expect((await new Browser().json("/api/admin/stats")).status).toBe(401);
		expect((await ron.browser.json("/api/admin/stats")).status).toBe(403);
		expect((await ron.browser.json("/api/admin/accounts/ron/suspend", { method: "POST", json: {} })).status).toBe(403);
		const token = (await operator.browser.json("/auth/tokens", { method: "POST", json: { name: "CLI" } })).body.token as string;
		expect((await new Browser().json("/api/admin/stats", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
		const stats = await admin("/api/admin/stats");
		expect(stats.status).toBe(200);
		expect(stats.body.accounts.active).toBeGreaterThan(1);
		const listed = (await admin("/api/admin/accounts?limit=500")).body.accounts as { username: string; role: string }[];
		expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ username: "boss", role: "admin" }), expect.objectContaining({ username: "ron", role: "member" })]));
		// The admin can't suspend or delete themself from here.
		expect((await admin("/api/admin/accounts/boss/suspend", { method: "POST", json: {} })).status).toBe(409);
		expect((await admin("/api/admin/accounts/boss", { method: "DELETE" })).status).toBe(409);
	});

	it("suspends an account at once, and restores it", async () => {
		const pat = await person("pat");
		expect((await admin("/api/admin/accounts/pat/suspend", { method: "POST", json: { reason: "spam" } })).body.account).toMatchObject({
			status: "suspended",
			statusReason: "spam",
		});
		expect((await pat.browser.json("/api/sessions")).status).toBe(403);
		// The space refuses too, whatever a Worker has cached.
		const agent = await runInDurableObject(env.Pim.getByName(pat.ownerId), (instance: Pim) => instance.status());
		expect(agent).toBe("suspended");
		await admin("/api/admin/accounts/pat/unsuspend", { method: "POST" });
		expect((await pat.browser.json("/api/sessions")).status).toBe(200);
	});

	it("sets one person's limits over everyone's", async () => {
		const quinn = await person("quinn");
		expect((await quinn.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: null, sessions: null });
		await admin("/api/admin/accounts/quinn/limits", { method: "PUT", json: { limits: { dailyRuns: 0 } } });
		expect((await quinn.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: 0, sessions: null });
		const refused = await quinn.browser.json(`/api/sessions/${await rootOf(quinn.browser)}/messages`, { method: "POST", json: { content: "Hello" } });
		expect(refused.status).toBe(429);
		expect((await admin("/api/admin/accounts/quinn/limits", { method: "PUT", json: { limits: { dailyRuns: "lots" } } })).status).toBe(400);
		await admin("/api/admin/accounts/quinn/limits", { method: "PUT", json: { limits: null } });
		expect((await quinn.browser.json("/api/usage")).body.limits).toMatchObject({ dailyRuns: null });
	});

	it("adds apps everyone can connect, which each person signs in to once for all their agents", async () => {
		const uma = await person("app-uma");
		const crm = { name: "Acme CRM", description: "Customers and deals.", url: "https://crm.example.test/mcp" };
		expect((await uma.browser.json("/api/admin/apps", { method: "POST", json: crm })).status).toBe(403);
		expect((await admin("/api/admin/apps", { method: "POST", json: { ...crm, url: "http://crm.example.test/mcp" } })).status).toBe(400);
		// Its icon is its site's: the page its home redirects to links a PNG and an SVG, relative to itself, and the SVG is kept.
		const realSiteFetch = globalThis.fetch;
		const site = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new Request(input, init).url;
			if (url === "https://crm.example.test/") {
				const page = new Response(
					`<head><link rel="icon" href="/favicon.png" sizes="32x32"><link href="static/logo.svg?v=2&amp;x=1" rel="icon" type="image/svg+xml"></head>`,
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				);
				// Followed a redirect to here.
				Object.defineProperty(page, "url", { value: "https://www.acme.example.test/crm/" });
				return page;
			}
			if (url === "https://www.acme.example.test/crm/static/logo.svg?v=2&x=1") return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
			if (url === "https://www.acme.example.test/favicon.png") return new Response("png", { headers: { "content-type": "image/png" } });
			if (url.includes("example.test")) return new Response("Not found", { status: 404 });
			return realSiteFetch(input, init);
		});
		try {
			expect((await admin("/api/admin/apps", { method: "POST", json: { ...crm, category: "crm" } })).status).toBe(400);
			expect(await admin("/api/admin/apps", { method: "POST", json: { ...crm, category: "customers" } })).toMatchObject({ status: 201, body: { app: { id: "acme-crm" } } });
		} finally {
			site.mockRestore();
		}
		expect((await admin("/api/admin/apps", { method: "POST", json: { ...crm, name: "Other" } })).status).toBe(400);
		expect((await uma.browser.json("/api/app-directory")).body.apps).toContainEqual({
			ref: "custom/acme-crm",
			...crm,
			custom: true,
			icon: "https://www.acme.example.test/crm/static/logo.svg?v=2&x=1",
			category: "customers",
		});
		// The admin can give it another; only an https one.
		const logo = "https://cdn.acme.example.test/logo.png";
		expect((await uma.browser.json("/api/admin/apps/acme-crm", { method: "PUT", json: { icon: logo } })).status).toBe(403);
		expect((await admin("/api/admin/apps/acme-crm", { method: "PUT", json: { icon: "javascript:alert(1)" } })).status).toBe(400);
		expect((await admin("/api/admin/apps/acme-crm", { method: "PUT", json: { icon: logo } })).body).toMatchObject({ app: { icon: logo } });
		expect((await admin("/api/admin/apps/nope", { method: "PUT", json: { icon: logo } })).status).toBe(404);
		expect((await uma.browser.json("/api/app-directory")).body.apps).toContainEqual(expect.objectContaining({ ref: "custom/acme-crm", icon: logo }));

		// Two of Uma's agents list it; connecting it once serves both.
		const sales = (await uma.browser.json("/api/agents", { method: "POST", json: { name: "Sales", apps: ["custom/acme-crm"] } })).body;
		await uma.browser.json("/api/agents", { method: "POST", json: { name: "Support", apps: ["custom/acme-crm"] } });
		const realFetch = globalThis.fetch;
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith(crm.url)) return realFetch(input, init);
			const server = () => {
				const mcp = new McpServer({ name: "crm", version: "1.0.0" });
				mcp.registerTool("deals", { description: "Open deals.", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "None." }] }));
				return mcp;
			};
			return createMcpHandler(server)(request, {}, createExecutionContext());
		});
		try {
			expect((await uma.browser.json("/api/mcp", { method: "POST", json: { app: "custom/acme-crm" } })).body).toMatchObject({ state: "ready" });
		} finally {
			spy.mockRestore();
		}
		expect((await uma.browser.json("/api/mcp")).body.servers).toEqual([expect.objectContaining({ url: crm.url, agents: ["Sales", "Support"] })]);
		// Nothing but the directory's apps connects.
		expect((await uma.browser.json("/api/mcp", { method: "POST", json: { name: "Evil", url: "https://evil.example.test/mcp" } })).status).toBe(400);

		// Taken out, nobody can add it again; Uma's connection stays until she removes it.
		expect((await admin("/api/admin/apps/acme-crm", { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await uma.browser.json("/api/app-directory")).body.apps.some((app: { ref: string }) => app.ref === "custom/acme-crm")).toBe(false);
		expect((await uma.browser.json(`/api/agents/${sales.id}`, { method: "PUT", json: { apps: ["custom/acme-crm"] } })).status).toBe(400);
		expect((await uma.browser.json("/api/mcp")).body.servers).toHaveLength(1);
	});
});

/**
 * What erasing a space must stop, case by case: everything that could
 * still write to it, or act for its owner, once the Directory says it's gone.
 */
describe("erasure boundaries", () => {
	/**
	 * A gate a test holds work on inside a space, and a flag that the work
	 * reached it. Only plain flags cross between the test and the space, each
	 * polled with its own timers: a promise made in the test and awaited in an
	 * agent that then ends would hang the test runner itself.
	 */
	function gate() {
		const state = { reached: false, open: false };
		return {
			/** Called by the held work, in the space. */
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

	/** Deletes the account from `browser`, which keeps its session cookie, as another of the person's devices would. */
	const deleteAccount = async (browser: Browser, username: string) => {
		const before = new Map(browser.cookies);
		const { body } = await browser.json("/api/account", { method: "DELETE", json: { confirm: username } });
		browser.cookies = before;
		return body;
	};

	it("closes a socket that was open across the deletion, and takes nothing from it", async () => {
		const ana = await person("eb-socket");
		const upgrade = await ana.browser.fetch("/api/ws", { headers: { Upgrade: "websocket", origin: ORIGIN } });
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

	it("refuses the write of a request that was already inside the space when the deletion began", async () => {
		const ben = await person("eb-inflight");
		const root = await rootOf(ben.browser);
		const held = gate();
		const prototype = Pim.prototype as Pim;
		const original = prototype.submitTo;
		prototype.submitTo = async function (this: Pim, ...args: Parameters<Pim["submitTo"]>) {
			await held.hold();
			return original.apply(this, args);
		};
		try {
			// Past the Worker and the space's own check, waiting just before it writes.
			const late = ben.browser.json(`/api/sessions/${root}/messages`, { method: "POST", json: { content: "Written after deletion" } });
			await held.reached();
			expect(await deleteAccount(ben.browser, "eb-inflight")).toEqual({ deleted: true });
			held.release();
			// The instance it was in ended: it gets "try again", and trying again gets "gone".
			expect(await late).toMatchObject({ status: 503 });
			const retry = await ben.browser.json(`/api/sessions/${root}/messages`, { method: "POST", json: { content: "Written after deletion" } });
			expect(retry.status).toBe(410);
		} finally {
			prototype.submitTo = original;
		}
		await expectErased(ben.ownerId);
	});

	/**
	 * Holds the first `POST /memory/log` inside the space's request handler,
	 * past the Worker and the space's `fetch`, and records how it ended. The
	 * SDK binds `onRequest` when a space is made, so this goes in before the
	 * person registers. `duringErasure` lets the request go on from inside
	 * the erasure itself, between its start and the wipe.
	 */
	function holdMemoryWrite(held: ReturnType<typeof gate>, options: { duringErasure: boolean; path?: RegExp }) {
		const prototype = Pim.prototype as Pim;
		const original = prototype.onRequest;
		const seen = { outcome: "never resumed" };
		let taken = false;
		const path = options.path ?? /^\/memory\/log$/;
		prototype.onRequest = async function (this: Pim, request: Request) {
			if (taken || request.method !== "POST" || !path.test(new URL(request.url).pathname)) return original.call(this, request);
			taken = true;
			if (options.duringErasure) {
				const storage = this.ctx.storage as { deleteAll: DurableObjectStorage["deleteAll"] };
				const wipe = storage.deleteAll.bind(this.ctx.storage);
				storage.deleteAll = async (...args) => {
					held.release();
					// Long enough for the held request to go on before the wipe.
					await new Promise((resolve) => setTimeout(resolve, 100));
					return wipe(...args);
				};
			}
			await held.hold();
			try {
				const response = await original.call(this, request);
				seen.outcome = `answered ${response.status}`;
				return response;
			} catch (error) {
				seen.outcome = `threw ${error instanceof Error ? error.message : String(error)}`;
				throw error;
			}
		};
		return { seen, restore: () => (prototype.onRequest = original) };
	}

	it("refuses a write in the space's handler that goes on while the erasure runs", async () => {
		const held = gate();
		const hook = holdMemoryWrite(held, { duringErasure: true });
		try {
			const gil = await person("eb-handler-during");
			const late = gil.browser.json("/api/memory/log", { method: "POST", json: { text: "Written during erasure" } });
			await held.reached();
			expect(await deleteAccount(gil.browser, "eb-handler-during")).toEqual({ deleted: true });
			// It went on before the wipe, and the space, already erasing, refused it.
			expect(hook.seen.outcome).toBe("answered 410");
			expect((await late).status).toBe(410);
			await expectErased(gil.ownerId);
		} finally {
			hook.restore();
		}
	});

	it("refuses an artifact restore in the space's handler that goes on while the erasure runs", async () => {
		const held = gate();
		const hook = holdMemoryWrite(held, { duringErasure: true, path: /^\/artifacts\/[^/]+\/restore$/ });
		try {
			const jo = await person("eb-artifact-handler");
			const id = await makeArtifact(jo.browser, "<p>Jo's page</p>");
			const late = jo.browser.json(`/api/artifacts/${id}/restore`, { method: "POST", json: { version: 1, baseVersion: 1 } });
			await held.reached();
			expect(await deleteAccount(jo.browser, "eb-artifact-handler")).toEqual({ deleted: true });
			expect(hook.seen.outcome).toBe("answered 410");
			expect((await late).status).toBe(410);
			await expectErased(jo.ownerId);
		} finally {
			hook.restore();
		}
	});

	it("drops a write held in the space's handler until the instance has ended", async () => {
		const held = gate();
		const hook = holdMemoryWrite(held, { duringErasure: false });
		try {
			const hal = await person("eb-handler-after");
			const late = hal.browser.json("/api/memory/log", { method: "POST", json: { text: "Written after deletion" } });
			await held.reached();
			expect(await deleteAccount(hal.browser, "eb-handler-after")).toEqual({ deleted: true });
			held.release();
			// The instance it was in ended with the erasure: the request gets "try again", and its handler never goes on.
			expect((await late).status).toBe(503);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(hook.seen.outcome).toBe("never resumed");
			await expectErased(hal.ownerId);
		} finally {
			hook.restore();
		}
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
		expect((await cy.browser.json(`/api/sessions/${await rootOf(cy.browser)}/messages`, { method: "POST", json: { content: "Think slowly" } })).status).toBe(202);
		await held.reached();
		expect(await deleteAccount(cy.browser, "eb-model")).toEqual({ deleted: true });
		held.release();
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expectErased(cy.ownerId);
	});

	it("keeps an artifact the model asks for during the erasure from being written", async () => {
		const di = await person("eb-artifact");
		const held = gate();
		faux.setResponses([
			async () => {
				await held.hold();
				return toolUse("artifact_create", { title: "Late", kind: "html", content: "<p>Made during erasure</p>" });
			},
		]);
		await withAgentMethod(
			"deleteEverything",
			(original) =>
				async function (this: Pim) {
					const storage = this.ctx.storage as { deleteAll: DurableObjectStorage["deleteAll"] };
					const wipe = storage.deleteAll.bind(this.ctx.storage);
					storage.deleteAll = async (...args) => {
						// The model asks for the artifact once the erasure has begun, before the wipe.
						held.release();
						await new Promise((resolve) => setTimeout(resolve, 100));
						return wipe(...args);
					};
					return original.call(this);
				},
			async () => {
				expect((await di.browser.json(`/api/sessions/${await rootOf(di.browser)}/messages`, { method: "POST", json: { content: "Make a page" } })).status).toBe(202);
				await held.reached();
				expect(await deleteAccount(di.browser, "eb-artifact")).toEqual({ deleted: true });
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expectErased(di.ownerId);
		const rows = await runInDurableObject(env.Pim.getByName(di.ownerId), (_instance: Pim, state) =>
			state.storage.sql.exec("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'pim_artifact_versions'").one().count === 0
				? 0
				: state.storage.sql.exec("SELECT COUNT(*) AS count FROM pim_artifact_versions").one().count,
		);
		expect(rows).toBe(0);
	});

	it("keeps a model answer that arrives during the erasure from being written", async () => {
		const ivy = await person("eb-model-during");
		const held = gate();
		const answered = { during: false };
		faux.setResponses([
			async () => {
				await held.hold();
				answered.during = true;
				return fauxAssistantMessage("Written during erasure");
			},
		]);
		// Let the answer arrive from inside the erasure: after it has begun, before the wipe.
		await withAgentMethod(
			"deleteEverything",
			(original) =>
				async function (this: Pim) {
					const storage = this.ctx.storage as { deleteAll: DurableObjectStorage["deleteAll"] };
					const wipe = storage.deleteAll.bind(this.ctx.storage);
					storage.deleteAll = async (...args) => {
						held.release();
						await new Promise((resolve) => setTimeout(resolve, 100));
						return wipe(...args);
					};
					return original.call(this);
				},
			async () => {
				expect((await ivy.browser.json(`/api/sessions/${await rootOf(ivy.browser)}/messages`, { method: "POST", json: { content: "Think slowly" } })).status).toBe(202);
				await held.reached();
				const started = Date.now();
				expect(await deleteAccount(ivy.browser, "eb-model-during")).toEqual({ deleted: true });
				// A run that ignores its abort can't hold the deletion past the courtesy wait.
				expect(Date.now() - started).toBeLessThan(10_000);
				// The model did answer, mid-erasure; the answer was not kept.
				expect(answered.during).toBe(true);
			},
		);
		await expectErased(ivy.ownerId);
	});

	it("never runs an action whose approval timer outlives the space", async () => {
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
			await dot.browser.json(`/api/sessions/${await rootOf(dot.browser)}/messages`, { method: "POST", json: { content: "Send it" } });
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
		const stale = fay.ownerId;
		const write = new Request(`${ORIGIN}/api/memory/log`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "Written by a stale gateway" }),
		});
		expect((await toAgent(write, env, stale, "/memory/log")).status).toBe(410);
		const socket = new Request(`${ORIGIN}/api/ws`, { headers: { Upgrade: "websocket" } });
		expect((await toAgent(socket, env, stale, "/ws")).status).toBe(410);
		const callback = new Request(`${ORIGIN}/mcp/events/watch-1`, { method: "POST", body: "{}" });
		expect((await toAgent(callback, env, stale, "/mcp/events/watch-1")).status).toBe(410);
		const writes: ((instance: Pim) => Promise<unknown>)[] = [
			(instance) => instance.provision({ ownerId: fay.ownerId, username: "eb-stale" }),
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

describe("circles and visits", () => {
	const created: { title: string; day: string }[] = [];
	const calendar = () => {
		const server = new McpServer({ name: "calendar", version: "1.0.0" });
		server.registerTool(
			"find_events",
			{ description: "Find events on a day.", inputSchema: { day: z.string() }, annotations: { readOnlyHint: true } },
			async ({ day }) => ({ content: [{ type: "text", text: `Events on ${day}: dentist at 9.` }] }),
		);
		server.registerTool(
			"create_event",
			{ description: "Create an event.", inputSchema: { title: z.string(), day: z.string() } },
			async ({ title, day }) => {
				created.push({ title, day });
				return { content: [{ type: "text", text: `Created "${title}" on ${day}.` }] };
			},
		);
		return server;
	};
	const withCalendar = () => {
		const realFetch = globalThis.fetch;
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith("https://calendar.example.test/mcp")) return realFetch(input, init);
			return createMcpHandler(calendar)(request, {}, createExecutionContext());
		});
	};
	const say = async (browser: Browser, session: string, content: string) =>
		browser.json(`/api/sessions/${session}/messages`, { method: "POST", json: { content, wait: true } });
	const transcript = async (browser: Browser, session: string) =>
		JSON.stringify((await browser.json(`/api/sessions/${session}/messages`)).body.messages);
	const setPermission = (browser: Browser, circle: string, app: string | null, tool: string, permission: string | null) =>
		browser.json("/api/permissions", { method: "PUT", json: { circle, app, tool, permission } });

	it("lets someone in a circle message the owner's space from their own, with only what the circle was given", async () => {
		const spy = withCalendar();
		try {
			const ana = await person("ana");
			const ben = await person("ben");
			const cyd = await person("cyd");
			expect((await ana.browser.json("/api/mcp", { method: "POST", json: { app: "test.ledger/calendar" } })).status).toBe(201);
			await ana.browser.json("/api/memory/log", { method: "POST", json: { text: "Ana's favourite restaurant is Tasca do Chico." } });

			// Ana puts Ben in a circle; Ben's space hears of it.
			const family = (await ana.browser.json("/api/circles", { method: "POST", json: { name: "Family" } })).body;
			expect((await ana.browser.json(`/api/circles/${family.id}/members`, { method: "POST", json: { username: "nobody-here" } })).status).toBe(404);
			expect((await ana.browser.json(`/api/circles/${family.id}/members`, { method: "POST", json: { username: "ana" } })).status).toBe(400);
			expect((await ana.browser.json(`/api/circles/${family.id}/members`, { method: "POST", json: { username: "@Ben" } })).status).toBe(201);
			expect((await ben.browser.json("/api/visits")).body.visits).toEqual([
				{ ownerId: ana.ownerId, username: "ana", sharedAt: expect.any(Number), available: true, session: null },
			]);
			expect((await ben.browser.json("/api/notifications")).body.notifications[0]).toMatchObject({ title: "ana shared their space with you" });

			// A circle starts with nothing: every tool off, memory off.
			const circleTools = (await ana.browser.json(`/api/permissions?circle=${family.id}`)).body.tools;
			expect(circleTools.map((info: { name: string; permission: string }) => [info.name, info.permission])).toEqual([
				["memory", "off"],
				["calendar_find_events", "off"],
				["calendar_create_event", "off"],
			]);
			expect((await setPermission(ana.browser, family.id, null, "memory", "ask")).status).toBe(400);
			expect((await setPermission(ana.browser, family.id, null, "memory", "on")).body).toMatchObject({ permission: "on" });
			await setPermission(ana.browser, family.id, "calendar", "find_events", "on");
			await setPermission(ana.browser, family.id, "calendar", "create_event", "ask");

			// Ben's visit runs in Ben's space, on Ben's usage, with Ana's tools and memory and nothing of Ben's own.
			const session = (await ben.browser.json("/api/visits/ana", { method: "POST" })).body.session as string;
			let system = "";
			let offered: string[] = [];
			faux.setResponses([
				(context) => {
					system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
					offered = context.messages.flatMap((message) =>
						message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
					);
					return toolUse("calendar_find_events", { day: "monday" });
				},
				toolUse("send_to_user", { message: "Ana sees the dentist at 9 on Monday." }),
			]);
			expect((await say(ben.browser, session, "Is Ana free Monday morning?")).body).toMatchObject({ status: "done" });
			expect(system).toContain("You are ana's personal AI agent");
			expect(system).toContain("Tasca do Chico");
			// The circle's tools, and the visitor's own way to be answered.
			expect(offered.sort()).toEqual(["calendar_create_event", "calendar_find_events", "current_time", "recall", "send_to_user"]);
			expect(await transcript(ben.browser, session)).toContain("Events on monday: dentist at 9.");
			const usage = async (browser: Browser) => (await browser.json("/api/usage")).body.today;
			expect(await usage(ben.browser)).toMatchObject({ runs: 1, modelRequests: 2 });
			expect(await usage(ana.browser)).toMatchObject({ runs: 0, modelRequests: 0 });
			// Ben's own chats don't get Ana's tools, or her instructions.
			expect(((await ben.browser.json("/api/")).body.tools as { name: string }[]).map((tool) => tool.name)).not.toContain("calendar_find_events");
			let own = "";
			let ownTools: string[] = [];
			faux.setResponses([
				(context) => {
					own = JSON.stringify(context.messages.filter((message) => message.role === "system"));
					ownTools = context.messages.flatMap((message) =>
						message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
					);
					return toolUse("send_to_user", { message: "Hi Ben." });
				},
			]);
			await say(ben.browser, await rootOf(ben.browser), "Hi");
			expect(ownTools).toContain("note");
			expect(ownTools).not.toContain("calendar_find_events");
			expect(own).not.toContain("ana's space");
			expect((await ben.browser.json("/api/sessions")).body.sessions.find((info: { id: string }) => info.id === session)).toMatchObject({
				visit: { username: "ana", available: true },
			});

			// A tool that asks: Ana gets the request, with who asked; her answer continues Ben's visit.
			faux.setResponses([toolUse("calendar_create_event", { title: "Lunch with Ben", day: "friday" }), toolUse("send_to_user", { message: "I've asked Ana." })]);
			expect((await say(ben.browser, session, "Put lunch with me on Ana's calendar Friday.")).body).toMatchObject({ status: "done" });
			expect(created).toEqual([]);
			const [asked] = (await ana.browser.json("/api/approvals?status=pending")).body.approvals;
			expect(asked).toMatchObject({
				summary: 'Calendar: create_event {"title":"Lunch with Ben","day":"friday"}',
				requestedBy: { ownerId: ben.ownerId, username: "ben", circle: family.id, circleName: "Family" },
				onTimeout: "deny",
			});
			expect((await ana.browser.json("/api/notifications")).body.notifications[0]).toMatchObject({ title: "ben asked your agent" });
			faux.setResponses([toolUse("send_to_user", { message: "Ana said yes: lunch is on her calendar." })]);
			expect((await ana.browser.json(`/api/approvals/${asked.id}/approve`, { method: "POST", json: {} })).body).toMatchObject({ status: "approved" });
			expect(created).toEqual([{ title: "Lunch with Ben", day: "friday" }]);
			await vi.waitFor(async () => expect(await transcript(ben.browser, session)).toContain("Ana said yes: lunch is on her calendar."));
			expect(await transcript(ben.browser, session)).toContain("[ana's answer to approval");
			expect(await usage(ana.browser)).toMatchObject({ runs: 0, modelRequests: 0 });
			expect((await ana.browser.json("/api/circles/activity")).body.activity.map((entry: { tool: string; outcome: string }) => [entry.tool, entry.outcome])).toEqual([
				["calendar_create_event", "asked"],
				["calendar_find_events", "ran"],
			]);

			// The boundary is in Ana's space, at each call: a tool turned off is refused even to a space that was told of it, and nobody outside the circle gets anything.
			await setPermission(ana.browser, family.id, "calendar", "find_events", "off");
			const call = (guest: { ownerId: string; username: string }) =>
				runInDurableObject(env.Pim.getByName(ana.ownerId), (instance: Pim) =>
					instance.guestCall(guest, { tool: "calendar_find_events", args: { day: "tuesday" }, session, callId: "c1" }),
				);
			expect(await call({ ownerId: ben.ownerId, username: "ben" })).toEqual({ text: "ana doesn't let you use calendar_find_events.", isError: true });
			expect(await call({ ownerId: cyd.ownerId, username: "cyd" })).toEqual({ text: "ana doesn't share their space with you.", isError: true });
			await ana.browser.json(`/api/circles/${family.id}`, { method: "PUT", json: { enabled: false } });
			expect((await say(ben.browser, session, "Still there?")).status).toBe(403);

			// Taken out of the circle, Ben's space knows, and the visit can't go on.
			await ana.browser.json(`/api/circles/${family.id}`, { method: "PUT", json: { enabled: true } });
			expect((await ana.browser.json(`/api/circles/${family.id}/members/${ben.ownerId}`, { method: "DELETE" })).status).toBe(200);
			expect((await ben.browser.json("/api/visits")).body.visits[0]).toMatchObject({ available: false, session });
			expect((await say(ben.browser, session, "Hello?")).status).toBe(403);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("profiles and published agents", () => {
	it("lets people publish an agent, others find it and make it their own, and takes it all down with the account", async () => {
		const dee = await person("dee");
		const eli = await person("eli");

		expect((await dee.browser.json("/api/profile", { method: "PUT", json: { displayName: "x".repeat(51) } })).status).toBe(400);
		expect((await dee.browser.json("/api/profile", { method: "PUT", json: { displayName: "Dee Rivers", bio: "Runs, cooks." } })).body).toEqual({
			username: "dee",
			displayName: "Dee Rivers",
			bio: "Runs, cooks.",
		});

		const coach = (
			await dee.browser.json("/api/agents", {
				method: "POST",
				json: {
					name: "Marathon coach",
					description: "Plans training weeks.",
					instructions: "Plan one week at a time.",
					apps: ["test.ledger/strava"],
					team: [{ name: "Physio", instructions: "Check every plan for injury risk." }],
					symbol: "🏃",
					color: "teal",
				},
			})
		).body;
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);
		await dee.browser.fetch(`/api/agents/${coach.id}/icon`, { method: "PUT", headers: { "content-type": "image/png" }, body: png });
		const published = await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "POST" });
		expect(published).toMatchObject({
			status: 201,
			body: { author: "dee", authorName: "Dee Rivers", name: "Marathon coach", symbol: "🏃", color: "teal", icon: expect.any(Number), uses: 0 },
		});
		const templateId = published.body.id as string;
		expect((await dee.browser.json(`/api/agents/${coach.id}`)).body.published).toBe(templateId);
		// Publishing again replaces it, under the same id.
		await dee.browser.json(`/api/agents/${coach.id}`, { method: "PUT", json: { instructions: "Plan two weeks at a time." } });
		expect((await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "POST" })).body).toMatchObject({ id: templateId });

		// Eli finds it, by search or on Dee's page, and reads it in full: a copy of the agent, never Dee's data.
		const found = (await eli.browser.json("/api/templates?q=marathon")).body.templates;
		expect(found).toEqual([expect.objectContaining({ id: templateId, author: "dee", name: "Marathon coach" })]);
		expect(found[0]).not.toHaveProperty("instructions");
		expect(found[0]).toMatchObject({ symbol: "🏃", color: "teal", icon: expect.any(Number) });
		const shown = await eli.browser.fetch(`/api/templates/${templateId}/icon`);
		expect(shown.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await shown.arrayBuffer())).toEqual(png);
		expect((await eli.browser.json("/api/templates?q=nothing-like-it")).body.templates).toEqual([]);
		expect((await eli.browser.json("/api/people/dee")).body).toMatchObject({
			username: "dee",
			displayName: "Dee Rivers",
			bio: "Runs, cooks.",
			templates: [expect.objectContaining({ id: templateId })],
		});
		expect((await eli.browser.json(`/api/templates/${templateId}`)).body).toMatchObject({ instructions: "Plan two weeks at a time." });

		// Made his own: a copy in Eli's agents, his to change; Dee's is untouched, and counts the use.
		const mine = await eli.browser.json(`/api/templates/${templateId}/use`, { method: "POST" });
		expect(mine).toMatchObject({
			status: 201,
			body: {
				name: "Marathon coach",
				instructions: "Plan two weeks at a time.",
				apps: ["test.ledger/strava"],
				team: [{ name: "Physio", instructions: "Check every plan for injury risk.", tools: null }],
				symbol: "🏃",
				color: "teal",
				icon: expect.any(Number),
				source: { template: templateId, author: "dee" },
				published: null,
			},
		});
		// The copy has its own icon: the picture, kept when the template's changes.
		const copied = await eli.browser.fetch(`/api/agents/${mine.body.id}/icon`);
		expect(new Uint8Array(await copied.arrayBuffer())).toEqual(png);
		await eli.browser.json(`/api/agents/${mine.body.id}`, { method: "PUT", json: { instructions: "Plan my week around work." } });
		expect((await dee.browser.json(`/api/agents/${coach.id}`)).body.instructions).toBe("Plan two weeks at a time.");
		expect((await eli.browser.json(`/api/templates/${templateId}`)).body.uses).toBe(1);
		// Published again without its picture, the template has none; Eli's copy keeps it.
		await dee.browser.fetch(`/api/agents/${coach.id}/icon`, { method: "DELETE" });
		await dee.browser.json(`/api/agents/${coach.id}`, { method: "PUT", json: { symbol: "rocket", color: null } });
		expect((await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "POST" })).body).toMatchObject({ symbol: "rocket", color: null, icon: null });
		expect((await eli.browser.fetch(`/api/templates/${templateId}/icon`)).status).toBe(404);
		expect((await eli.browser.fetch(`/api/agents/${mine.body.id}/icon`)).status).toBe(200);

		// Unpublished, it's gone from the gallery; Eli keeps his copy.
		expect((await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "DELETE" })).status).toBe(200);
		expect((await eli.browser.json(`/api/templates/${templateId}`)).status).toBe(404);
		expect((await eli.browser.json("/api/agents")).body.agents.map((agent: { name: string }) => agent.name)).toEqual(["Majordomo", "Marathon coach"]);

		// Deleting a published agent unpublishes it; deleting the account takes the profile and everything published.
		const again = (await dee.browser.json(`/api/agents/${coach.id}/publish`, { method: "POST" })).body.id;
		await dee.browser.json(`/api/agents/${coach.id}`, { method: "DELETE" });
		expect((await eli.browser.json(`/api/templates/${again}`)).status).toBe(404);
		const other = (await dee.browser.json("/api/agents", { method: "POST", json: { name: "Cook", instructions: "Suggest dinners." } })).body;
		await dee.browser.json(`/api/agents/${other.id}/publish`, { method: "POST" });
		expect((await eli.browser.json("/api/templates?q=cook")).body.templates).toHaveLength(1);
		expect((await dee.browser.json("/api/account", { method: "DELETE", json: { confirm: "dee" } })).status).toBe(200);
		expect((await eli.browser.json("/api/templates?q=cook")).body.templates).toEqual([]);
		expect(await env.Gallery!.getByName("gallery").holds(dee.ownerId)).toBe(false);
		expect((await eli.browser.json("/api/people/dee")).status).toBe(404);
	});

	it("gives everyone who joins a copy of the agent the admin chose, theirs to change", async () => {
		const before = await person("nell");
		const helper = (
			await admin("/api/agents", {
				method: "POST",
				json: {
					name: "Household helper",
					description: "Keeps the house running.",
					instructions: "Check the family calendar first.",
					symbol: "house",
					color: "amber",
				},
			})
		).body;
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9]);
		await operator.browser.fetch(`/api/agents/${helper.id}/icon`, { method: "PUT", headers: { "content-type": "image/png" }, body: png });
		expect((await before.browser.json("/api/admin/default-agent", { method: "PUT", json: { agent: helper.id } })).status).toBe(403);
		expect((await admin("/api/admin/default-agent", { method: "PUT", json: { agent: "p_nope" } })).status).toBe(404);
		expect((await admin("/api/admin/default-agent", { method: "PUT", json: { agent: helper.id } })).body.agent).toMatchObject({
			author: "boss",
			agentId: helper.id,
			name: "Household helper",
			symbol: "house",
			color: "amber",
			icon: true,
		});

		// A newcomer gets a copy besides the majordomo they are yet to name; whoever joined before doesn't.
		const otto = await person("otto");
		expect((await otto.browser.json("/api/majordomo")).body).toMatchObject({ agent: { name: "Majordomo", majordomo: true }, introduced: false });
		const [, copy] = (await otto.browser.json("/api/agents")).body.agents;
		expect(copy).toMatchObject({
			name: "Household helper",
			description: "Keeps the house running.",
			instructions: "Check the family calendar first.",
			symbol: "house",
			color: "amber",
			icon: expect.any(Number),
			majordomo: false,
			source: { template: "default", author: "boss" },
		});
		expect(new Uint8Array(await (await otto.browser.fetch(`/api/agents/${copy.id}/icon`)).arrayBuffer())).toEqual(png);
		expect((await before.browser.json("/api/agents")).body.agents).toEqual([expect.objectContaining({ name: "Majordomo", majordomo: true })]);

		// The copy is Otto's: the admin's later edits don't reach it, and his don't reach theirs.
		await admin(`/api/agents/${helper.id}`, { method: "PUT", json: { instructions: "Ask before buying anything." } });
		await otto.browser.json(`/api/agents/${copy.id}`, { method: "PUT", json: { name: "Otto's helper" } });
		expect((await otto.browser.json("/api/agents")).body.agents[1]).toMatchObject({
			name: "Otto's helper",
			instructions: "Check the family calendar first.",
		});
		expect((await admin(`/api/agents/${helper.id}`)).body.name).toBe("Household helper");

		// Taken back, people join with only their majordomo again.
		expect((await admin("/api/admin/default-agent", { method: "DELETE" })).body).toEqual({ agent: null });
		expect((await (await person("pia")).browser.json("/api/agents")).body.agents).toEqual([
			expect.objectContaining({ name: "Majordomo", instructions: "", symbol: null, color: null, icon: null, majordomo: true }),
		]);
	});

	it("lets the operator take a template down", async () => {
		const fin = await person("fin");
		const agent = (await fin.browser.json("/api/agents", { method: "POST", json: { name: "Spam", instructions: "Buy now." } })).body;
		const template = (await fin.browser.json(`/api/agents/${agent.id}/publish`, { method: "POST" })).body.id;
		expect((await admin(`/api/admin/templates/${template}`, { method: "DELETE" })).status).toBe(200);
		expect((await fin.browser.json(`/api/templates/${template}`)).status).toBe(404);
	});
});
