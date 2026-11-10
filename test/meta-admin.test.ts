import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { adminAsMajordomo } from "../src/accounts";
import { readDeployment } from "../src/deployment";
import type { Pim } from "../src/pim";
import { api, OWNER, pendingApproval, post, ROOT, say, toolUse, url } from "./helpers";
import { faux } from "./worker";

type Result = { content: { text: string }[]; isError?: boolean };

let helperChat = "";
let majordomoId = "";

/** Runs one of the extension's tools in the admin's space, as the conversation `chat` (the majordomo's root unless given). */
async function run(tool: string, args: Record<string, unknown>, chat = ROOT) {
	return runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) => {
		const session = pim.store.sessionOf(chat)!;
		const tools = pim.abilities.get("meta-admin")!.tools!;
		const result = (await tools.find((candidate) => candidate.name === tool)!.execute(args as never, { conversationId: session } as never, {} as never)) as Result;
		return { error: result.isError === true, body: JSON.parse(result.content[0]!.text) as any };
	});
}

beforeAll(async () => {
	helperChat = (await post("/sessions", { agent: (await post("/agents", { name: "Admin helper", instructions: "Helps." })).body.id })).body.id;
	majordomoId = ((await api("/agents")).body.agents as { id: string; majordomo: boolean }[]).find((agent) => agent.majordomo)!.id;
});

describe("the admin area for the majordomo", () => {
	it("refuses other agents of the admin, and every agent of someone who isn't the admin", async () => {
		for (const [tool, args] of [["admin_read", { path: "/admin/stats" }], ["admin_write", { method: "POST", path: "/admin/invites" }], ["admin_audit", {}]] as const) {
			const refused = await run(tool, args, helperChat);
			expect(refused, tool).toMatchObject({ error: true, body: { status: 403 } });
		}
		const directory = env.Directory.getByName("directory");
		const registered = await directory.register({ username: "plain", ip: "192.0.2.7", policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
		if (!registered.ok) throw new Error(registered.error);
		await directory.activate(registered.account.ownerId);
		const plain = registered.account.ownerId;
		await (await getAgentByName(env.Pim, plain)).provision({ ownerId: plain, username: "plain" });
		const abilities = await runInDurableObject(env.Pim.getByName(plain), async (pim: Pim) => ({
			offered: pim.abilities.get("meta-admin")!.offeredTo!({ id: "x", majordomo: true }),
		}));
		expect(abilities.offered).toBe(false);
		// The server checks too: not the admin's majordomo, and not even the admin's space for a member.
		const request = () => new Request(url("/api/admin/stats"));
		expect((await adminAsMajordomo(env, OWNER, "not-the-majordomo", request())).status).toBe(403);
		expect((await adminAsMajordomo(env, plain, majordomoId, request())).status).toBe(403);
		expect((await adminAsMajordomo(env, OWNER, majordomoId, request())).status).toBe(200);
		// A token still can't run the instance.
		expect((await api("/admin/stats")).status).toBe(403);
	});

	it("reads the deployment as the app does", async () => {
		const read = await run("admin_read", { path: "/admin/deployment" });
		expect(read.error).toBe(false);
		expect(read.body).toEqual({ status: 200, body: JSON.parse(JSON.stringify(readDeployment(env))) });
		expect((await run("admin_read", { path: "/admin/accounts", query: { limit: "5" } })).body.body.accounts.length).toBeGreaterThan(0);
		expect((await run("admin_read", { path: "/admin/../x" })).body.status).toBe(400);
	});

	it("runs ordinary writes at once, keeps only the keys of their bodies, and leaves out invite secrets", async () => {
		const made = await run("admin_write", { method: "POST", path: "/admin/invites", body: { count: 2, note: "for the team" } });
		expect(made.error).toBe(false);
		expect(made.body.status).toBe(201);
		expect(JSON.stringify(made.body)).not.toContain("#invite=");
		expect(made.body.body.codes).toBe("[redacted]");
		const { body } = await run("admin_audit", {});
		expect(body.writes[0]).toMatchObject({ method: "POST", path: "/admin/invites", status: 201, bodyKeys: ["count", "note"], approved: false });
		expect(JSON.stringify(body)).not.toContain("for the team");
	});

	it("refuses destructive and credential writes to admin_write, and asks the person with the exact request for admin_write_approved", async () => {
		for (const [method, path] of [["DELETE", "/admin/default-agent"], ["POST", "/admin/computer-host"], ["PUT", "/admin/providers/x"], ["POST", "/admin/accounts/ada/setup-link"]]) {
			const refused = await run("admin_write", { method, path, body: {} });
			expect(refused, `${method} ${path}`).toMatchObject({ error: true, body: { status: 403 } });
		}

		let told = "";
		const note = (context: { messages: { role: string; content?: unknown }[] }) => {
			const result = context.messages.findLast((message) => message.role === "toolResult") as { content: { text: string }[] } | undefined;
			told = result?.content[0]?.text ?? "";
			return toolUse("send_to_user", { message: "ok" });
		};
		const args = { method: "POST", path: "/admin/computer-host" };
		faux.setResponses([toolUse("admin_write_approved", args), note as never]);
		const turn = say("Pair the computer host", ROOT);
		const approval = await pendingApproval();
		expect(approval).toMatchObject({ action: "admin_write_approved", tool: null, summary: "POST /admin/computer-host", onTimeout: "deny" });
		expect(await run("admin_read", { path: "/admin/computer-host" })).toMatchObject({ body: { body: { paired: false } } });
		expect((await post(`/approvals/${approval.id}/approve`)).status).toBe(200);
		await turn;
		const answer = JSON.parse(told.slice(told.indexOf("Result:\n") + 8));
		expect(answer.status).toBe(201);
		expect(answer.body.token).toBe("[redacted]");
		expect(told).not.toMatch(/pim_host_|"token":"[^[]/);
		expect(await run("admin_read", { path: "/admin/computer-host" })).toMatchObject({ body: { body: { paired: true } } });
		expect((await run("admin_audit", {})).body.writes[0]).toMatchObject({ method: "POST", path: "/admin/computer-host", status: 201, approved: true });

		// Forgetting it is gated too, and a tool that needs no approval is sent to admin_write.
		faux.setResponses([toolUse("admin_write_approved", { method: "DELETE", path: "/admin/computer-host" }), note as never]);
		const forgetting = say("Forget it", ROOT);
		expect(await pendingApproval()).toMatchObject({ summary: "DELETE /admin/computer-host" });
		expect((await post(`/approvals/${(await pendingApproval()).id}/approve`)).status).toBe(200);
		await forgetting;
		expect(JSON.parse(told.slice(told.indexOf("Result:\n") + 8)).status).toBe(200);
		faux.setResponses([toolUse("admin_write_approved", { method: "PUT", path: "/admin/default-agent", body: {} }), note as never]);
		await say("Do it", ROOT);
		expect(JSON.parse(told)).toMatchObject({ status: 400 });
	});

	it("leaves out a provider's key", async () => {
		let told = "";
		faux.setResponses([
			toolUse("admin_write_approved", { method: "POST", path: "/admin/providers", body: { builtin: "openai", key: "sk-secret-123", models: ["gpt-5"] } }),
			(context: { messages: { role: string }[] }) => {
				told = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"));
				return toolUse("send_to_user", { message: "ok" });
			},
		] as never);
		const turn = say("Add openai", ROOT);
		const approval = await pendingApproval();
		expect(approval.summary).toContain("POST /admin/providers");
		expect((await post(`/approvals/${approval.id}/approve`)).status).toBe(200);
		await turn;
		const row = (await run("admin_audit", {})).body.writes[0];
		expect(row).toMatchObject({ path: "/admin/providers", bodyKeys: ["builtin", "key", "models"], approved: true });
		expect(row.status).toBeLessThan(300);
		expect(told).toContain("provider");
		expect(told).not.toContain("sk-secret-123");
		expect(JSON.stringify(row)).not.toContain("sk-secret-123");
	});
});
