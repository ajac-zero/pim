import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, OWNER, post, ROOT, say, toolUse, url } from "./helpers";
import { faux, type Pim } from "./worker";

/**
 * Apps an extension implements (the test extension's Bank): their sign-in
 * through the one callback address, their tools with the person's
 * credential, and the widgets their results show. bank.example.test is an
 * OAuth service the tests answer, checking what a real one would.
 */

const BASIC = `Basic ${btoa("bank-client:bank-secret")}`;
const grants: Record<string, string>[] = [];
const tokensUsed: string[] = [];
let challenge = "";

const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

beforeEach(() => {
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const { origin, pathname } = new URL(request.url);
		if (origin !== "https://bank.example.test") return realFetch(input, init);
		if (pathname === "/token") {
			if (request.headers.get("authorization") !== BASIC) return Response.json({ error: "invalid_client" }, { status: 401 });
			const form = Object.fromEntries(new URLSearchParams(await request.text()));
			grants.push(form);
			if (form.grant_type === "authorization_code") {
				// The verifier must be the one the challenge was made from (S256), and the redirect the one the sign-in used.
				const hashed = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.code_verifier)));
				if (form.code !== "good" || hashed !== challenge || form.redirect_uri !== "https://pim.test/mcp/callback/apps") {
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				}
				return Response.json({ access_token: "token-1", refresh_token: "refresh-1", expires_in: 3600 });
			}
			if (form.grant_type === "refresh_token" && form.refresh_token === "refresh-1") return Response.json({ access_token: "token-2", expires_in: 3600 });
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		if (pathname === "/balances") {
			tokensUsed.push(request.headers.get("authorization") ?? "");
			return Response.json([
				{ name: "Checking", balance: 120 },
				{ name: "Savings", balance: 900 },
			]);
		}
		return new Response("not found", { status: 404 });
	});
});

const lastToolResult = (messages: readonly Message[]) => {
	const last = messages.findLast((message) => message.role === "toolResult");
	return last?.role === "toolResult" ? last.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
};

describe("apps extensions implement", () => {
	it("are offered once their secrets are set, and sign in once through the one callback address", async () => {
		const directory = (await api("/app-directory")).body.apps as { ref: string; url: string | null }[];
		expect(directory).toContainEqual({ ref: "test.ledger/bank", name: "Bank", description: "Balances and transfers.", url: null, custom: false, icon: null, category: null });
		// Its secret isn't set: nobody is offered it, or can connect it.
		expect(directory.some((app) => app.ref === "test.ledger/vault")).toBe(false);
		expect((await post("/mcp", { app: "test.ledger/vault" })).status).toBe(400);

		const started = await post("/mcp", { app: "test.ledger/bank" });
		expect(started).toMatchObject({ status: 201, body: { id: "bank", state: "authenticating" } });
		const authUrl = new URL(started.body.authUrl);
		const params = Object.fromEntries(authUrl.searchParams);
		expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://bank.example.test/authorize");
		expect(params).toMatchObject({
			response_type: "code",
			client_id: "bank-client",
			redirect_uri: "https://pim.test/mcp/callback/apps",
			scope: "balances transfers",
			code_challenge_method: "S256",
		});
		expect(params.state!.startsWith(`${OWNER}.`)).toBe(true);
		challenge = params.code_challenge!;
		expect((await api("/mcp")).body.servers).toEqual([
			expect.objectContaining({ id: "bank", app: "test.ledger/bank", state: "authenticating", authUrl: started.body.authUrl, tools: [] }),
		]);

		// A state nobody started finds no sign-in; one naming nobody finds no space.
		expect((await exports.default.fetch(url(`/mcp/callback/apps?state=${OWNER}.forged&code=good`))).status).toBe(400);
		expect((await exports.default.fetch(url("/mcp/callback/apps?state=o_nobody.x&code=good"))).status).toBe(404);

		// The service sends the person back, without Pim's API token.
		const back = await exports.default.fetch(url(`/mcp/callback/apps?state=${params.state}&code=good`));
		expect(back.status).toBe(200);
		expect(await back.text()).toContain("Connected.");
		expect(grants.at(-1)).toMatchObject({ grant_type: "authorization_code", code: "good" });
		const [bank] = (await api("/mcp")).body.servers;
		expect(bank).toMatchObject({ state: "ready", authUrl: null, approval: "writes" });
		expect(bank.tools.map((tool: { name: string }) => tool.name)).toEqual(["bank_balance", "bank_transfer"]);
		// Finished once: the same return can't sign in again.
		expect((await exports.default.fetch(url(`/mcp/callback/apps?state=${params.state}&code=good`))).status).toBe(400);
		expect((await post("/mcp", { app: "test.ledger/bank" })).status).toBe(409);
	});

	it("run their tools with the person's credential, show results as widgets, and leave destructive ones off until switched on", async () => {
		const [agent] = (await api("/agents")).body.agents;
		await api(`/agents/${agent.id}`, { method: "PUT", body: JSON.stringify({ apps: ["test.ledger/bank"] }) });
		let read = "";
		faux.setResponses([
			toolUse("bank_balance", {}),
			(context) => {
				read = lastToolResult(context.messages);
				const ref = /"(tool:[\w]+)"/.exec(read)?.[1] ?? "none";
				return toolUse("send_to_user", { message: "Your balances:", widgets: [ref] });
			},
		]);
		await say("What's in my accounts?");
		expect(tokensUsed.at(-1)).toBe("Bearer token-1");
		expect(read).toContain("Checking: 120\nSavings: 900");
		// The person sees the result as a widget under the message, as it was when sent.
		const transcript = JSON.stringify((await api(`/sessions/${ROOT}/messages`)).body.messages);
		expect(transcript).toContain('\\"title\\":\\"Balances\\"');
		expect(transcript).toContain('{\\"title\\":\\"Savings\\",\\"detail\\":\\"900\\"}');

		// A tool the app flags destructive is off, even when the app otherwise trusts all calls, until the person switches it on.
		await api("/mcp/bank", { method: "PUT", body: JSON.stringify({ approval: "none" }) });
		const transfer = async () =>
			(await api(`/permissions?agent=${agent.id}`)).body.tools.find((tool: { name: string }) => tool.name === "bank_transfer");
		expect(await transfer()).toMatchObject({ permission: "off", destructive: true });
		await api("/permissions", { method: "PUT", body: JSON.stringify({ agent: agent.id, app: "bank", tool: "transfer", permission: "on" }) });
		expect(await transfer()).toMatchObject({ permission: "on", chosen: "on" });
		let moved = "";
		faux.setResponses([
			toolUse("bank_transfer", { amount: 5 }),
			(context) => {
				moved = lastToolResult(context.messages);
				return toolUse("send_to_user", { message: "Moved." });
			},
		]);
		expect(await say("Move 5 to savings")).toMatchObject({ status: "done", replies: ["Moved."] });
		expect(moved).toContain("Moved 5.");
		expect((await api("/approvals")).body.approvals).toEqual([]);
		await api("/mcp/bank", { method: "PUT", body: JSON.stringify({ approval: "writes" }) });
	});

	it("renew a credential about to expire before using it, once", async () => {
		await runInDurableObject(env.Pim.getByName(OWNER), (_instance: Pim, state) => {
			state.storage.sql.exec("UPDATE pim_app_connections SET credential = json_set(credential, '$.expiresAt', 0)");
		});
		faux.setResponses([toolUse("bank_balance", {}), toolUse("bank_balance", {}), toolUse("send_to_user", { message: "ok" })]);
		await say("Balances again, twice");
		expect(grants.filter((grant) => grant.grant_type === "refresh_token")).toEqual([{ grant_type: "refresh_token", refresh_token: "refresh-1" }]);
		expect(tokensUsed.slice(-2)).toEqual(["Bearer token-2", "Bearer token-2"]);
	});
});
