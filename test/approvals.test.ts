import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../src/store";
import type { Message } from "@earendil-works/pi-ai";
import { api, OWNER, pendingApproval, post, ROOT, say, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

const toolResult = (messages: readonly Message[]) =>
	JSON.stringify(messages.findLast((message) => message.role === "toolResult")?.content);

function mockHook(response = "order 42 created") {
	const realFetch = globalThis.fetch;
	// Bodies must be read in the Durable Object that made the request.
	const hook = vi.fn(async (_call: { method: string; body: string }) => new Response(response, { status: 201 }));
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		if (!request.url.startsWith("https://hooks.example.test/")) return realFetch(input, init);
		return hook({ method: request.method, body: await request.text() });
	});
	return hook;
}

const policy = (approvalPolicy: string | null) => api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy }) });

describe("approvals", () => {
	it("holds the call for the decision, suspended, and returns the decision and result as the call's own", async () => {
		const hook = mockHook();
		let result = "";
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/order", body: '{"pizza":1}' }),
			(context) => {
				result = toolResult(context.messages);
				return toolUse("send_to_user", { message: "Your pizza is ordered." });
			},
		]);
		// The run waits for the decision.
		const said = say("Order me a pizza.");
		const approval = await pendingApproval();
		expect(approval.summary).toBe("POST https://hooks.example.test/order with a 11-character body");
		// Clients show the request in place of the tool call that filed it.
		expect(approval.callId).toMatch(/^tool:/);
		expect(approval.expiresAt! - approval.createdAt).toBe(1_500);
		expect(hook).not.toHaveBeenCalled();
		// The person's devices hear of it.
		const notifications = (await api("/notifications")).body.notifications;
		expect(notifications).toContainEqual(expect.objectContaining({ title: "Pim needs your approval", body: approval.summary }));
		// The call is suspended meanwhile: nothing of it runs or waits in memory, and the turn waits on it.
		const tasks = await runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) =>
			(await (await pim.harness.pi()).inspect(BACKGROUND_CONTEXT)).tasks.map(({ record, state }) => `${record.kind} ${state.kind}`),
		);
		expect(tasks.sort()).toEqual(["pi.generation waiting", "pi.tool suspended"]);

		const decided = await post<Approval>(`/approvals/${approval.id}/approve`, { note: "extra cheese" });
		expect(decided.body).toMatchObject({ status: "approved", result: "HTTP 201 Created\norder 42 created" });
		expect(hook).toHaveBeenCalledOnce();
		expect(hook.mock.calls[0]![0]).toEqual({ method: "POST", body: '{"pizza":1}' });
		expect(await said).toMatchObject({ status: "done", replies: ["Your pizza is ordered."] });
		expect(result).toContain(`[Approval ${approval.id}] The user approved: POST https://hooks.example.test/order`);
		expect(result).toContain("The user's note: extra cheese");
		expect(result).toContain("order 42 created");

		// A decision is final: no second run of the action, and the timeout that passes later changes nothing.
		expect((await post(`/approvals/${approval.id}/approve`)).status).toBe(409);
		await new Promise((resolve) => setTimeout(resolve, 1_600));
		expect((await api<Approval>(`/approvals/${approval.id}`)).body).toMatchObject({ status: "approved", decidedBy: "user" });
		expect(hook).toHaveBeenCalledOnce();
	});

	it("runs a tool the user always approves within the turn, until they take it back", async () => {
		const hook = mockHook();
		let seen = "";
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/first" }),
			toolUse("send_to_user", { message: "Sent." }),
		]);
		const first = say("Send the first.");
		const asked = await pendingApproval();
		expect(asked.tool).toBe("http_request");
		const decided = await post<Approval>(`/approvals/${asked.id}/approve`, { always: true });
		expect(decided.body).toMatchObject({ status: "approved", result: "HTTP 201 Created\norder 42 created" });
		expect(await first).toMatchObject({ status: "done", replies: ["Sent."] });
		const permissions = (await api("/permissions")).body.tools;
		expect(permissions.find((info: { tool: string }) => info.tool === "http_request")).toMatchObject({
			app: null,
			permission: "on",
			chosen: "on",
			default: "ask",
		});

		// The next call runs at once, and its result is the call's own.
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/second" }),
			(context) => {
				seen = toolResult(context.messages);
				return toolUse("send_to_user", { message: "Sent again." });
			},
		]);
		expect(await say("Send the second.")).toMatchObject({ status: "done", text: "Sent again." });
		expect(hook).toHaveBeenCalledTimes(2);
		expect(seen).toContain("The user always approves http_request, so it was approved automatically");
		expect(seen).toContain("order 42 created");
		const [second] = (await api<{ approvals: Approval[] }>("/approvals")).body.approvals;
		expect(second).toMatchObject({ summary: "POST https://hooks.example.test/second", status: "approved" });

		// Taken back, the tool asks again.
		const reset = await api("/permissions", {
			method: "PUT",
			body: JSON.stringify({ app: null, tool: "http_request", permission: null }),
		});
		expect(reset.body).toMatchObject({ tool: "http_request", permission: "ask", chosen: null });
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/third" }),
			toolUse("send_to_user", { message: "Okay, not sent." }),
		]);
		const third = say("Send the third.");
		const again = await pendingApproval();
		await post(`/approvals/${again.id}/deny`);
		expect(await third).toMatchObject({ status: "done", replies: ["Okay, not sent."] });
		expect(hook).toHaveBeenCalledTimes(2);
	});

	it("approves on its own when the user does not answer in time", async () => {
		const hook = mockHook();
		let result = "";
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/auto" }),
			(context) => {
				result = toolResult(context.messages);
				return toolUse("send_to_user", { message: "Done." });
			},
		]);
		const said = say("Go.");
		const approval = await pendingApproval();
		expect(hook).not.toHaveBeenCalled();
		expect(await said).toMatchObject({ status: "done", replies: ["Done."] });
		expect(hook).toHaveBeenCalledOnce();
		expect(result).toContain("did not respond within 1.5 seconds, so it was approved automatically");
		expect((await api<Approval>(`/approvals/${approval.id}`)).body).toMatchObject({ status: "approved", decidedBy: "timeout" });
	});

	it("waits for the user however long under the explicit policy, and a no stops it", async () => {
		const hook = mockHook();
		expect((await policy("explicit")).body).toMatchObject({ approvalPolicy: "explicit", approvalTimeoutSeconds: null });
		try {
			// The model is told how an unanswered request ends before it makes one.
			const tools = (await api<{ tools: { name: string; description: string }[] }>("/")).body.tools;
			expect(tools.find((tool) => tool.name === "http_request")?.description).toContain("waits for their answer, however long");

			let result = "";
			faux.setResponses([
				toolUse("http_request", { method: "POST", url: "https://hooks.example.test/explicit" }),
				(context) => {
					result = toolResult(context.messages);
					return toolUse("send_to_user", { message: "Okay, I didn't send it." });
				},
			]);
			const said = say("Go.");
			const approval = await pendingApproval();
			expect(approval).toMatchObject({ expiresAt: null });
			// Past the auto policy's timeout, it still waits.
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			expect((await api<Approval>(`/approvals/${approval.id}`)).body.status).toBe("pending");

			const denied = await post<Approval>(`/approvals/${approval.id}/deny`);
			expect(denied.body).toMatchObject({ status: "denied", decidedBy: "user", result: null });
			expect(await said).toMatchObject({ status: "done", replies: ["Okay, I didn't send it."] });
			expect(result).toContain("The user denied: POST https://hooks.example.test/explicit");
			expect(result).toContain("Do not perform this action.");
			expect(hook).not.toHaveBeenCalled();
		} finally {
			// Back to the deployment's policy for the tests after this one.
			expect((await policy(null)).body).toMatchObject({ approvalPolicy: "auto" });
		}
	});

	it("withdraws a request whose chat was stopped: deciding it later runs nothing", async () => {
		const hook = mockHook();
		await policy("explicit");
		try {
			faux.setResponses([toolUse("http_request", { method: "POST", url: "https://hooks.example.test/stopped" })]);
			const said = say("Go.");
			const approval = await pendingApproval();
			expect((await post(`/sessions/${ROOT}/abort`)).status).toBe(200);
			expect((await said).status).toBe("unanswered");
			const decided = await post<Approval>(`/approvals/${approval.id}/approve`);
			expect(decided.body).toMatchObject({ status: "denied", note: "Its chat stopped before the decision, so nothing ran." });
			expect(hook).not.toHaveBeenCalled();
		} finally {
			await policy(null);
		}
	});
});
