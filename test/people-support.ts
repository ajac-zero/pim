import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it } from "vitest";
import { Auth } from "../src/auth";
import type { Directory, RegistrationPolicy } from "../src/directory";
import { faux, Pim } from "./worker";
import { Authenticator } from "./webauthn";

/**
 * Several people on one Pim: registering, keeping each person's things
 * their own, adding devices, recovery, accounts, the admin, erasure, and
 * what people share with each other.
 */

export const ORIGIN = "https://pim.test";

afterEach(() => {
	// Every scripted model response was used.
	expect(faux.getPendingResponseCount()).toBe(0);
});

let browsers = 0;

/** One browser, from its own address: keeps the cookies the Worker sets, sends them back. */
export class Browser {
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

export type Registered = { username: string; role: string; setup: string; recoveryCodes: string[] };

let addresses = 0;
/** Registers from a fresh address, so the per-address limit is only met where a test means to. */
export async function register(username: string, extra: Record<string, unknown> = {}) {
	const browser = new Browser(`198.51.100.${++addresses}`);
	return browser.json<Registered & { error?: string }>("/auth/register", { method: "POST", json: { username, ...extra } });
}

export async function addPasskey(browser: Browser, authenticator: Authenticator, allowedBy: Record<string, string> = {}) {
	const options = await browser.json("/auth/passkeys/options", { method: "POST", json: allowedBy });
	if (options.status !== 200) return options.status;
	return (await browser.fetch("/auth/passkeys", { method: "POST", json: await authenticator.register(options.body) })).status;
}

export async function signIn(browser: Browser, authenticator: Authenticator) {
	const options = await browser.json("/auth/sign-in/options", { method: "POST" });
	return (await browser.fetch("/auth/sign-in", { method: "POST", json: await authenticator.sign(options.body) })).status;
}

/** A registered, set-up person, and a browser signed in as them. */
export async function person(username: string, extra: Record<string, unknown> = {}) {
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
export async function rootOf(browser: Browser): Promise<string> {
	return (await browser.json("/api/")).body.rootSession;
}

export const directory = () => env.Directory.getByName("directory");
export const OPEN: RegistrationPolicy = { mode: "open", maxAccounts: null, perAddressPerDay: 100 };
/** A Directory of its own, with only its admin, for tests that need an otherwise empty one. */
export async function freshDirectory() {
	const stub = env.Directory.getByName(`fresh-${crypto.randomUUID()}`);
	const admin = await stub.register({ username: "keeper", ip: "0", claim: { window: true }, policy: OPEN });
	if (!admin.ok) throw new Error(admin.error);
	await stub.activate(admin.account.ownerId);
	return stub;
}

/** The person running this Pim: they claimed it with the link from the logs before anyone else registered. */
export let operator: Awaited<ReturnType<typeof person>>;

beforeAll(async () => {
	const { code } = await directory().claimCode();
	operator = await person("boss", { claim: code });
	expect(operator.registered.role).toBe("admin");
});

/** The admin's API, as the admin's signed-in browser calls it. */
export const admin = (path: string, init: RequestInit & { json?: unknown } = {}) => operator.browser.json(path, init);

/** Everything that holds the person's data, so a test can tell it was kept or erased. */
export async function holdings(ownerId: string) {
	const agent = await runInDurableObject(env.Pim.getByName(ownerId), async (instance: Pim) => ({
		remaining: await instance.remainingData(),
		memories: instance.memory.store.count(),
		credentials: instance.store.credentialProviders(),
	}));
	const auth = env.Auth.getByName(ownerId);
	return { ...agent, passkeys: (await auth.passkeys()).length, tokens: (await auth.tokens()).length };
}

/** Makes the Directory's queued cleanup for `ownerId` due now, as if its wait had passed. */
export async function makeDue(stub: DurableObjectStub<Directory>, ownerId: string) {
	await runInDurableObject(stub, (_instance: Directory, state) => {
		state.storage.sql.exec("UPDATE cleanups SET next_attempt_at = ? WHERE owner_id = ?", Date.now() - 1, ownerId);
	});
}

/** Swaps a method of the test space for the length of `run`. */
export async function withAgentMethod<K extends "deleteEverything">(name: K, replacement: (original: Pim[K]) => Pim[K], run: () => Promise<void>) {
	const prototype = Pim.prototype as Pim;
	const original = prototype[name];
	prototype[name] = replacement(original);
	try {
		await run();
	} finally {
		prototype[name] = original;
	}
}

export const toolUse = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });

/** Has the person's space make an HTML artifact, as its model would, and returns its id. */
export async function makeArtifact(browser: Browser, content: string) {
	faux.setResponses([toolUse("app_create", { title: "Page", kind: "html", content }), toolUse("send_to_user", { message: "Made it." })]);
	expect((await browser.json(`/api/sessions/${await rootOf(browser)}/messages`, { method: "POST", json: { content: "Make a page", wait: true } })).status).toBe(200);
	const { artifacts } = (await browser.json("/api/artifacts")).body as { artifacts: { id: string; title: string }[] };
	return artifacts[0]!.id;
}

