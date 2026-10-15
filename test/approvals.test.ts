import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../src/store";
import type { Message } from "@earendil-works/pi-ai";
import { api, decisionRun, lastUserText, pendingApproval, post, say, toolUse } from "./helpers";
import { faux } from "./worker";

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
	it("asks without holding the turn, and brings the decision and result back as a message", async () => {
		const hook = mockHook();
		let asked = "";
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/order", body: '{"pizza":1}' }),
			(context) => {
				asked = toolResult(context.messages);
				return toolUse("send_to_user", { message: "Approve the order and I'll place it." });
			},
		]);
		// The turn ends while the request waits.
		expect(await say("Order me a pizza.")).toMatchObject({ status: "done", replies: ["Approve the order and I'll place it."] });
		const approval = await pendingApproval();
		expect(asked).toContain(`Asked the user: POST https://hooks.example.test/order with a 11-character body`);
		expect(approval.summary).toBe("POST https://hooks.example.test/order with a 11-character body");
		// Clients show the request in place of the tool call that filed it.
		expect(approval.callId).toMatch(/^tool:/);
		expect(approval.expiresAt! - approval.createdAt).toBe(1_500);
		expect(hook).not.toHaveBeenCalled();
		// The person's devices hear of it.
		const notifications = (await api("/notifications")).body.notifications;
		expect(notifications).toContainEqual(expect.objectContaining({ title: "Pim needs your approval", body: approval.summary }));

		let decision = "";
		faux.setResponses([
			(context) => {
				decision = lastUserText(context.messages);
				return toolUse("send_to_user", { message: "Your pizza is ordered." });
			},
		]);
		const decided = await post<Approval>(`/approvals/${approval.id}/approve`, { note: "extra cheese" });
		expect(decided.body).toMatchObject({ status: "approved", result: "HTTP 201 Created\norder 42 created" });
		expect(hook).toHaveBeenCalledOnce();
		expect(hook.mock.calls[0]![0]).toEqual({ method: "POST", body: '{"pizza":1}' });
		expect(await decisionRun(approval)).toMatchObject({ status: "done", replies: ["Your pizza is ordered."] });
		expect(decision).toContain(`[Approval ${approval.id}] The user approved: POST https://hooks.example.test/order`);
		expect(decision).toContain("The user's note: extra cheese");
		expect(decision).toContain("order 42 created");

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
			toolUse("send_to_user", { message: "Asked." }),
		]);
		await say("Send the first.");
		const asked = await pendingApproval();
		expect(asked.tool).toBe("http_request");
		faux.setResponses([toolUse("send_to_user", { message: "Sent." })]);
		const decided = await post<Approval>(`/approvals/${asked.id}/approve`, { always: true });
		expect(decided.body).toMatchObject({ status: "approved", result: "HTTP 201 Created\norder 42 created" });
		expect(await decisionRun(asked)).toMatchObject({ status: "done" });
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
			toolUse("send_to_user", { message: "Asked." }),
		]);
		await say("Send the third.");
		const again = await pendingApproval();
		faux.setResponses([toolUse("send_to_user", { message: "Okay, not sent." })]);
		await post(`/approvals/${again.id}/deny`);
		expect(await decisionRun(again)).toMatchObject({ status: "done" });
		expect(hook).toHaveBeenCalledTimes(2);
	});

	it("approves on its own when the user does not answer in time", async () => {
		const hook = mockHook();
		let decision = "";
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/auto" }),
			toolUse("send_to_user", { message: "Asked." }),
			(context) => {
				decision = lastUserText(context.messages);
				return fauxAssistantMessage("Done.");
			},
		]);
		await say("Go.");
		const approval = await pendingApproval();
		expect(hook).not.toHaveBeenCalled();
		await vi.waitFor(async () => expect((await decisionRun(approval)).status).toBe("done"), { timeout: 5_000 });
		expect(hook).toHaveBeenCalledOnce();
		expect(decision).toContain("did not respond within 1.5 seconds, so it was approved automatically");
		expect((await api<Approval>(`/approvals/${approval.id}`)).body).toMatchObject({ status: "approved", decidedBy: "timeout" });
	});

	it("waits for the user however long under the explicit policy, and a no stops it", async () => {
		const hook = mockHook();
		expect((await policy("explicit")).body).toMatchObject({ approvalPolicy: "explicit", approvalTimeoutSeconds: null });
		try {
			// The model is told how an unanswered request ends before it makes one.
			const tools = (await api<{ tools: { name: string; description: string }[] }>("/")).body.tools;
			expect(tools.find((tool) => tool.name === "http_request")?.description).toContain("waits for their answer, however long");

			faux.setResponses([
				toolUse("http_request", { method: "POST", url: "https://hooks.example.test/explicit" }),
				toolUse("send_to_user", { message: "Asked." }),
			]);
			await say("Go.");
			const approval = await pendingApproval();
			expect(approval).toMatchObject({ expiresAt: null });
			// Past the auto policy's timeout, it still waits.
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			expect((await api<Approval>(`/approvals/${approval.id}`)).body.status).toBe("pending");

			let decision = "";
			faux.setResponses([
				(context) => {
					decision = lastUserText(context.messages);
					return toolUse("send_to_user", { message: "Okay, I didn't send it." });
				},
			]);
			const denied = await post<Approval>(`/approvals/${approval.id}/deny`);
			expect(denied.body).toMatchObject({ status: "denied", decidedBy: "user", result: null });
			expect(await decisionRun(approval)).toMatchObject({ status: "done", replies: ["Okay, I didn't send it."] });
			expect(decision).toContain("The user denied: POST https://hooks.example.test/explicit");
			expect(decision).toContain("Do not perform this action.");
			expect(hook).not.toHaveBeenCalled();
		} finally {
			// Back to the deployment's policy for the tests after this one.
			expect((await policy(null)).body).toMatchObject({ approvalPolicy: "auto" });
		}
	});
});
