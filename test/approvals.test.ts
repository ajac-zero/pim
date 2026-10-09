import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../src/store";
import type { Message } from "@earendil-works/pi-ai";
import { api, pendingApproval, post, say, toolUse } from "./helpers";
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

describe("approvals", () => {
	it("holds the turn until the user approves, then continues it with the result", async () => {
		const hook = mockHook();
		let seen = "";
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/order", body: '{"pizza":1}' }),
			(context) => {
				seen = toolResult(context.messages);
				return fauxAssistantMessage("Your pizza is ordered.");
			},
		]);
		const turn = say("Order me a pizza.");
		const approval = await pendingApproval();
		expect(approval.summary).toBe("POST https://hooks.example.test/order with a 11-character body");
		// Clients show the wait as a countdown on the tool call that filed it.
		expect(approval.callId).toMatch(/^tool:/);
		expect(approval.expiresAt! - approval.createdAt).toBe(1_500);
		expect(hook).not.toHaveBeenCalled();

		const decided = await post<Approval>(`/approvals/${approval.id}/approve`, { note: "extra cheese" });
		expect(decided.body).toMatchObject({ status: "approved", result: "HTTP 201 Created\norder 42 created" });
		expect(await turn).toMatchObject({ status: "done", text: "Your pizza is ordered." });
		expect(hook).toHaveBeenCalledOnce();
		expect(hook.mock.calls[0]![0]).toEqual({ method: "POST", body: '{"pizza":1}' });
		expect(seen).toContain("The user approved: POST https://hooks.example.test/order");
		expect(seen).toContain("The user's note: extra cheese");
		expect(seen).toContain("order 42 created");

		// A decision is final: no second run of the action.
		expect((await post(`/approvals/${approval.id}/approve`)).status).toBe(409);
		expect(hook).toHaveBeenCalledOnce();
	});

	it("tells the agent when the user denies, within the same turn", async () => {
		const hook = mockHook();
		let seen = "";
		faux.setResponses([
			toolUse("http_request", { method: "DELETE", url: "https://api.example.test/account" }),
			(context) => {
				seen = toolResult(context.messages);
				return fauxAssistantMessage("Okay, I won't.");
			},
		]);
		const turn = say("Delete my account.");
		const approval = await pendingApproval();
		const denied = await post<Approval>(`/approvals/${approval.id}/deny`);
		expect(denied.body).toMatchObject({ status: "denied", result: null });
		expect(await turn).toMatchObject({ status: "done", text: "Okay, I won't." });
		expect(seen).toContain("The user denied: DELETE https://api.example.test/account");
		expect(hook).not.toHaveBeenCalled();
	});

	it("stops asking about a tool the user always approves, until they take it back", async () => {
		const hook = mockHook();
		let seen = "";
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/first" }),
			fauxAssistantMessage("Sent."),
		]);
		const first = say("Send the first.");
		const asked = await pendingApproval();
		expect(asked.tool).toBe("http_request");
		const decided = await post<Approval>(`/approvals/${asked.id}/approve`, { always: true });
		expect(decided.body).toMatchObject({ status: "approved", result: "HTTP 201 Created\norder 42 created" });
		expect(await first).toMatchObject({ status: "done" });
		expect((await api("/always-approved")).body.tools).toEqual([
			{ tool: "http_request", createdAt: expect.any(Number) },
		]);

		// The next call runs at once, not after the timeout.
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/second" }),
			(context) => {
				seen = toolResult(context.messages);
				return fauxAssistantMessage("Sent again.");
			},
		]);
		expect(await say("Send the second.")).toMatchObject({ status: "done", text: "Sent again." });
		expect(hook).toHaveBeenCalledTimes(2);
		expect(seen).toContain("The user always approves http_request, so it was approved automatically");
		const [second] = (await api<{ approvals: Approval[] }>("/approvals")).body.approvals;
		expect(second).toMatchObject({ summary: "POST https://hooks.example.test/second", status: "approved" });

		// Taken back, the tool asks again.
		expect((await api("/always-approved/http_request", { method: "DELETE" })).body).toEqual({ deleted: true });
		expect((await api("/always-approved/http_request", { method: "DELETE" })).status).toBe(404);
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/third" }),
			fauxAssistantMessage("Okay."),
		]);
		const third = say("Send the third.");
		const again = await pendingApproval();
		await post(`/approvals/${again.id}/deny`);
		expect(await third).toMatchObject({ status: "done" });
		expect(hook).toHaveBeenCalledTimes(2);
	});

	it("approves on its own when the user does not answer in time", async () => {
		const hook = mockHook();
		let seen = "";
		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/auto" }),
			(context) => {
				seen = toolResult(context.messages);
				return fauxAssistantMessage("Done.");
			},
		]);
		const turn = say("Go.");
		const approval = await pendingApproval();
		expect(hook).not.toHaveBeenCalled();
		expect(await turn).toMatchObject({ status: "done", text: "Done." });
		expect(hook).toHaveBeenCalledOnce();
		expect(seen).toContain("did not respond within 1.5 seconds, so it was approved automatically");
		expect((await api<Approval>(`/approvals/${approval.id}`)).body.status).toBe("approved");
	});
});
