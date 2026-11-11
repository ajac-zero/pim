import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Auth } from "../src/auth";
import type { Directory, RegistrationPolicy } from "../src/directory";
import { z } from "zod";
import { faux, Pim } from "./worker";
import { Authenticator } from "./webauthn";
import { ORIGIN, Browser, register, addPasskey, signIn, person, rootOf, directory, OPEN, freshDirectory, operator, admin, holdings, makeDue, withAgentMethod, toolUse, makeArtifact, type Registered } from "./people-support";

/** Several people on one Pim: registering, keeping each person's things their own, adding devices, recovery, accounts and artifacts. The rest is in people-admin.test.ts: two files so no single test file runs long enough in one workerd to stall (see vitest.config.ts). */

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
		// Triggers are on from the start, before the space ever starts again.
		expect((await browser.json("/api/triggers?limit=1")).body).toEqual({ triggers: [], nextCursor: null });
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

		const watering = { label: "Plants", instruction: "Water the plants", source: { kind: "time", schedule: "once", at: Date.now() + 60 * 60_000 }, enabled: true };
		expect((await gus.browser.json("/api/triggers", { method: "POST", json: watering })).status).toBe(201);
		expect((await gus.browser.json("/api/schedules")).body.schedules).toMatchObject([{ instruction: "Water the plants" }]);
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

	it("slows down guessing from one address", { timeout: 60_000 }, async () => {
		await person("lars");
		// AUTH_LIMITER counts in windows aligned to the wall clock, and the Worker's clock can't be faked,
		// so start early in a window: 31 requests on a slow runner must not cross into the next one.
		const windowMs = 60_000;
		const left = windowMs - (Date.now() % windowMs);
		if (left < 20_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
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
		await rita.browser.json("/api/triggers", { method: "POST", json: { label: "Bank", instruction: "Call the bank", source: { kind: "time", schedule: "once", at: Date.now() + 60 * 60_000 }, enabled: true } });
		await runInDurableObject(env.Pim.getByName(rita.ownerId), async (instance: Pim) => {
			instance.store.putCredential("openai", JSON.stringify({ type: "oauth", access: "rita-access", refresh: "rita-refresh" }));
			// A coding harness's sealed login: a one-byte archive and the seal's 29 bytes.
			await instance.codingVaultWrite("codex", new Uint8Array(30), 1, 0);
			// Images, and files kept before files moved to people's computers, are in R2, outside the space's storage.
			await instance.images.keep("1", [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
			await env.BLOBS.put(`${rita.ownerId}/files/scan`, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0]));
		});
		expect((await holdings(rita.ownerId)).remaining).toEqual(
			expect.arrayContaining(["credentials", "coding harness logins", "memories", "triggers", "owner profile", "images"]),
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

	it("with a backend are opened at their own address by the people of the circles they're shared with, when their access says so, and only while they still are", async () => {
		const ann = await person("hst-ann");
		const ben = await person("hst-ben");
		const cy = await person("hst-cy");
		const id = crypto.randomUUID();
		const label = `${ann.ownerId.slice(2)}${id.replaceAll("-", "")}`;
		const space = () => env.Pim.getByName(ann.ownerId);
		const setAccess = (access: string) =>
			runInDurableObject(space(), async (instance: Pim, state) => {
				if (!instance.artifacts.get(id)) {
					await instance.artifacts.create({ id, title: "Club", kind: "hosted", content: JSON.stringify({ backend: { command: "x" } }), session: null });
				}
				state.storage.sql.exec("INSERT OR REPLACE INTO pim_hosted_apps (artifact, port, version, access) VALUES (?, 18000, 1, ?)", id, access);
			});
		const enter = (who: { browser: Browser }) => who.browser.fetch(`/hosted/enter?app=${label}&next=%2Fhome&go=1`, { redirect: "manual" });
		/** The app's own address, with what the person traded their token for. */
		const open = async (who: { browser: Browser }) => {
			const entered = await enter(who);
			if (entered.status !== 302) return { entered };
			const traded = await exports.default.fetch(new Request(entered.headers.get("location")!, { redirect: "manual" }));
			const cookie = traded.headers.get("set-cookie")!.split(";")[0]!;
			return { entered, cookie, page: () => exports.default.fetch(new Request(`https://${label}.apps.pim.test/home`, { redirect: "manual", headers: { cookie } })) };
		};

		await setAccess("owner");
		const club = (await ann.browser.json("/api/circles", { method: "POST", json: { name: "Club" } })).body;
		await ann.browser.json(`/api/circles/${club.id}/members`, { method: "POST", json: { username: "hst-ben" } });
		expect((await ann.browser.json(`/api/artifacts/${id}/circles`, { method: "PUT", json: { circles: [club.id] } })).status).toBe(200);

		// Shared, but the app's access is its owner's alone: only they get in.
		expect((await enter(ben)).status).toBe(403);
		expect((await enter(ann)).status).toBe(302);

		await setAccess("circles");
		const entered = await open(ben);
		expect(entered.entered.status).toBe(302);
		expect(new URL(entered.entered.headers.get("location")!).searchParams.get("next")).toBe("/home");
		// Someone outside the circle, and someone who isn't signed in, don't.
		const outside = await enter(cy);
		expect(outside.status).toBe(403);
		expect(await outside.text()).toContain("hasn't shared this app with you");
		expect((await new Browser().fetch(`/hosted/enter?app=${label}&go=1`, { redirect: "manual" })).status).toBe(401);
		// What their cookie opens is the owner's backend, which has no computer to answer here.
		const ok = await entered.page!();
		expect(ok.status).toBe(404);
		expect(await ok.text()).toContain("No computer");

		// Each of these ends it at once, for a cookie already held: the app is no longer shared with them, or its access is the owner's again, or their circle is off, or they are out of it.
		const away = async () => (await entered.page!()).status;
		await ann.browser.json(`/api/artifacts/${id}/circles`, { method: "PUT", json: { circles: [] } });
		expect(await away()).toBe(302);
		await ann.browser.json(`/api/artifacts/${id}/circles`, { method: "PUT", json: { circles: [club.id] } });
		expect(await away()).toBe(404);
		await setAccess("owner");
		expect(await away()).toBe(302);
		await setAccess("circles");
		await ann.browser.json(`/api/circles/${club.id}`, { method: "PUT", json: { enabled: false } });
		expect(await away()).toBe(302);
		await ann.browser.json(`/api/circles/${club.id}`, { method: "PUT", json: { enabled: true } });
		expect(await away()).toBe(404);
		await ann.browser.fetch(`/api/circles/${club.id}/members/${ben.ownerId}`, { method: "DELETE" });
		expect(await away()).toBe(302);
		expect((await enter(ben)).status).toBe(403);
	});

	it("are shown to the people of the circles they're shared with, from their own Pim, latest version only, with their own data apart", async () => {
		const dee = await person("art-dee");
		const eli = await person("art-eli");
		const fay = await person("art-fay");
		const id = await makeArtifact(dee.browser, "<p>Shopping list</p>");
		const family = (await dee.browser.json("/api/circles", { method: "POST", json: { name: "Family" } })).body;
		await dee.browser.json(`/api/circles/${family.id}/members`, { method: "POST", json: { username: "art-eli" } });
		const theirs = (version: number) => `/api/shared-artifacts/art-dee/${id}/versions/${version}`;

		// In the circle, but nothing is shared with it yet.
		expect((await eli.browser.json("/api/shared-artifacts")).body.artifacts).toEqual([]);
		expect((await eli.browser.fetch(`${theirs(1)}/frame`)).status).toBe(404);
		expect((await dee.browser.json(`/api/artifacts/${id}/circles`, { method: "PUT", json: { circles: ["nope"] } })).status).toBe(404);
		expect((await dee.browser.json(`/api/artifacts/${id}/circles`, { method: "PUT", json: { circles: [family.id] } })).body.circles).toEqual([family.id]);

		const listed = (await eli.browser.json("/api/shared-artifacts")).body.artifacts;
		expect(listed).toEqual([expect.objectContaining({ id, host: "art-dee", title: "Page", version: 1 })]);
		expect(listed[0]).not.toHaveProperty("session");
		const frame = await eli.browser.fetch(`${theirs(1)}/frame`);
		expect(frame.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
		expect(await frame.text()).toContain("Shopping list");
		// Someone not in the circle sees nothing of it.
		expect((await fay.browser.json("/api/shared-artifacts")).body.artifacts).toEqual([]);
		expect((await fay.browser.fetch(`${theirs(1)}/frame`)).status).toBe(404);

		// What everyone sees is the owner's; what each keeps is their own.
		const bridge = (browser: Browser, base: string, op: string, args: unknown) => browser.json(`${base}/bridge`, { method: "POST", json: { op, args } });
		const mine = `/api/artifacts/${id}/versions/1`;
		await bridge(dee.browser, mine, "shared.set", { key: "milk", value: "2" });
		await bridge(dee.browser, mine, "storage.set", { key: "note", value: "Dee's" });
		expect((await bridge(eli.browser, theirs(1), "shared.get", { key: "milk" })).body).toEqual({ value: "2" });
		await bridge(eli.browser, theirs(1), "shared.set", { key: "eggs", value: "6" });
		expect((await bridge(dee.browser, mine, "shared.list", {})).body).toEqual({ value: ["eggs", "milk"] });
		expect((await bridge(eli.browser, theirs(1), "storage.get", { key: "note" })).body).toEqual({ value: null });
		await bridge(eli.browser, theirs(1), "storage.set", { key: "note", value: "Eli's" });
		expect((await bridge(dee.browser, mine, "storage.get", { key: "note" })).body).toEqual({ value: "Dee's" });
		// The model is the visitor's own, asked of them.
		expect((await bridge(eli.browser, theirs(1), "model.ask", { prompt: "Hi" })).body).toEqual({ needs: { capability: "model", label: "model" } });

		// A new version replaces the shared one.
		faux.setResponses([toolUse("app_update", { id, base_version: 1, content: "<p>List 2</p>" }), toolUse("send_to_user", { message: "Done." })]);
		await dee.browser.json(`/api/sessions/${await rootOf(dee.browser)}/messages`, { method: "POST", json: { content: "Change it", wait: true } });
		expect((await eli.browser.fetch(`${theirs(1)}/frame`)).status).toBe(404);
		expect(await (await eli.browser.fetch(`${theirs(2)}/frame`)).text()).toContain("List 2");

		// Taken out of the circle: nothing more, and what they kept for it stays theirs.
		expect((await dee.browser.fetch(`/api/circles/${family.id}/members/${eli.ownerId}`, { method: "DELETE" })).status).toBe(200);
		expect((await eli.browser.fetch(`${theirs(2)}/frame`)).status).toBe(404);
		expect((await eli.browser.json("/api/shared-artifacts")).body.artifacts).toEqual([]);
		expect((await eli.browser.json("/api/export")).body.othersArtifactData).toEqual([{ artifact: `${dee.ownerId}/${id}`, data: { note: "Eli's" } }]);
	});

	it("are published to everyone as a copy of one version, used with each viewer's own data, made their own, and taken down", async () => {
		const gus = await person("art-gus");
		const hal = await person("art-hal");
		const id = await makeArtifact(gus.browser, "<p>Tip calculator</p>");
		expect((await gus.browser.fetch(`/api/artifacts/${id}/publish`)).status).toBe(404);
		expect((await hal.browser.json(`/api/artifacts/${id}/publish`, { method: "POST" })).status).toBe(404);
		const published = (await gus.browser.json(`/api/artifacts/${id}/publish`, { method: "POST" })).body;
		expect(published).toMatchObject({ author: "art-gus", artifactId: id, version: 1, kind: "html", uses: 0 });
		expect((await gus.browser.json(`/api/artifacts/${id}/publish`)).body.id).toBe(published.id);
		const root = `/api/published-artifacts/${published.id}`;

		// Everyone finds it; the list and the summary carry no content.
		const listed = (await hal.browser.json("/api/published-artifacts")).body.artifacts;
		expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: published.id, author: "art-gus" })]));
		expect(JSON.stringify(listed)).not.toContain("Tip calculator");
		expect((await hal.browser.json("/api/published-artifacts?q=nothing-like-it")).body.artifacts).toEqual([]);
		const frame = await hal.browser.fetch(`${root}/versions/1/frame`);
		expect(frame.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
		expect(await frame.text()).toContain("Tip calculator");
		expect((await new Browser().fetch(`${root}/versions/1/frame`)).status).toBe(401);
		expect((await hal.browser.fetch(`${root}/versions/1/frame?token=x`)).status).toBe(400);

		// What it keeps is each viewer's own; it keeps nothing for everyone; the model asks the viewer.
		const bridge = (browser: Browser, op: string, args: unknown) => browser.json(`${root}/versions/1/bridge`, { method: "POST", json: { op, args } });
		await bridge(hal.browser, "storage.set", { key: "tip", value: "18" });
		expect((await bridge(hal.browser, "storage.get", { key: "tip" })).body).toEqual({ value: "18" });
		expect((await bridge(gus.browser, "storage.get", { key: "tip" })).body).toEqual({ value: null });
		expect((await bridge(hal.browser, "shared.set", { key: "x", value: "1" })).status).toBe(400);
		expect((await bridge(hal.browser, "model.ask", { prompt: "Hi" })).body).toEqual({ needs: { capability: "model", label: "model" } });
		expect((await hal.browser.json(`${root}/versions/1/grants`, { method: "POST", json: { capability: "model" } })).status).toBe(201);

		// The author's next version isn't published until they publish again, which a new grant needs.
		faux.setResponses([toolUse("app_update", { id, base_version: 1, content: "<p>Tip calculator 2</p>" }), toolUse("send_to_user", { message: "Done." })]);
		await gus.browser.json(`/api/sessions/${await rootOf(gus.browser)}/messages`, { method: "POST", json: { content: "Change it", wait: true } });
		expect(await (await hal.browser.fetch(`${root}/versions/1/frame`)).text()).not.toContain("Tip calculator 2");
		expect((await gus.browser.json(`/api/artifacts/${id}/publish`, { method: "POST" })).body).toMatchObject({ id: published.id, version: 2 });
		expect((await hal.browser.fetch(`${root}/versions/1/frame`)).status).toBe(404);
		expect((await bridge(hal.browser, "storage.get", { key: "tip" })).status).toBe(404);
		const v2 = (path: string, init?: RequestInit & { json?: unknown }) => hal.browser.json(`${root}/versions/2${path}`, init);
		expect((await v2("/bridge", { method: "POST", json: { op: "model.ask", args: { prompt: "Hi" } } })).body).toEqual({ needs: { capability: "model", label: "model" } });
		expect((await v2("/bridge", { method: "POST", json: { op: "storage.get", args: { key: "tip" } } })).body).toEqual({ value: "18" });

		// Anyone with the link, once the author says so: on the content origin, which serves nothing else, and with no bridge.
		expect((await gus.browser.json(`/api/artifacts/${id}/publish`)).body).toMatchObject({ public: false, linkable: true, link: null });
		const link = (await gus.browser.json(`/api/artifacts/${id}/publish`, { method: "POST", json: { public: true } })).body.link as string;
		expect(link).toBe(`https://content.pim.test/p/${published.id}`);
		const anonymous = (url: string, init?: RequestInit) => exports.default.fetch(new Request(url, init));
		const page = await anonymous(link);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
		expect(page.headers.get("content-security-policy")).toContain("connect-src 'none'");
		const html = await page.text();
		expect(html).toContain("Tip calculator 2");
		expect(html).toContain("Pim isn't here");
		for (const path of ["/", "/api/artifacts", "/api/published-artifacts", `/api/published-artifacts/${published.id}/versions/2/frame`, "/auth/session", "/p/pa_0000000000000000"]) {
			expect((await anonymous(`https://content.pim.test${path}`, { headers: { cookie: [...hal.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } })).status).toBe(404);
		}
		expect((await anonymous(link, { method: "POST" })).status).toBe(404);
		// Republished, it keeps its link; taken back, the link is gone.
		expect((await gus.browser.json(`/api/artifacts/${id}/publish`, { method: "POST" })).body.link).toBe(link);
		expect((await gus.browser.json(`/api/artifacts/${id}/publish`, { method: "POST", json: { public: false } })).body.link).toBeNull();
		expect((await anonymous(link)).status).toBe(404);
		faux.setResponses([toolUse("note_create", { title: "Notes", content: "# Notes" }), toolUse("send_to_user", { message: "Made it." })]);
		await gus.browser.json(`/api/sessions/${await rootOf(gus.browser)}/messages`, { method: "POST", json: { content: "Make notes", wait: true } });
		const notes = (await gus.browser.json("/api/artifacts")).body.artifacts[0].id;
		expect((await gus.browser.json(`/api/artifacts/${notes}/publish`, { method: "POST", json: { public: true } })).status).toBe(400);

		// Made their own: a new artifact of theirs, counted once others do.
		const copy = (await hal.browser.json(`${root}/use`, { method: "POST" })).body;
		expect(copy).toMatchObject({ title: "Page", kind: "html", version: 1 });
		expect((await hal.browser.json(`/api/artifacts/${copy.id}/versions/1`)).body.content).toBe("<p>Tip calculator 2</p>");
		expect((await gus.browser.json(`/api/artifacts/${id}/publish`)).body.uses).toBe(1);

		// Taken down by the admin, or deleted by the author: gone for everyone, the copy and what was kept stay.
		expect((await hal.browser.json(`/api/admin/published-artifacts/${published.id}`, { method: "DELETE" })).status).toBe(403);
		expect((await admin(`/api/admin/published-artifacts/${published.id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await hal.browser.fetch(`${root}/versions/2/frame`)).status).toBe(404);
		const again = (await gus.browser.json(`/api/artifacts/${id}/publish`, { method: "POST" })).body;
		expect((await gus.browser.json(`/api/artifacts/${id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await hal.browser.fetch(`/api/published-artifacts/${again.id}`)).status).toBe(404);
		expect((await hal.browser.json(`/api/artifacts/${copy.id}`)).status).toBe(200);
		expect((await hal.browser.json("/api/export")).body.othersArtifactData).toEqual([{ artifact: `gallery/${published.id}`, data: { tip: "18" } }]);
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
		const [file] = exported.pim.artifacts[0].versions[0].files;
		expect(exported.pim.artifacts).toEqual([expect.objectContaining({ id, versions: [expect.objectContaining({ version: 1 })] })]);
		expect(exported.pim.artifactFiles).toEqual([expect.objectContaining({ sha256: file.sha256, encoding: "utf8", content: "<p>Cy's page</p>" })]);
		// A deleted artifact leaves its id behind, not in the export; erasing the account takes that too.
		const gone = await makeArtifact(cy.browser, "<p>Cy's other page</p>");
		expect((await cy.browser.json(`/api/artifacts/${gone}`, { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await holdings(cy.ownerId)).remaining).toContain("deleted app ids");
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

