import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../src/store";
import { api, lastUserText, post, say, toolUse } from "./helpers";
import { faux } from "./worker";

describe("approvals", () => {
	it("holds a side-effecting request until the user approves, then reports the result", async () => {
		const realFetch = globalThis.fetch;
		// Records what was sent; bodies must be read in the Durable Object that made the request.
		const hook = vi.fn(async (_call: { method: string; body: string }) => new Response("order 42 created", { status: 201 }));
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith("https://hooks.example.test/")) return realFetch(input, init);
			return hook({ method: request.method, body: await request.text() });
		});

		faux.setResponses([
			toolUse("http_request", { method: "POST", url: "https://hooks.example.test/order", body: '{"pizza":1}' }),
			fauxAssistantMessage("I've asked for your approval."),
		]);
		await say("Order me a pizza.");
		expect(hook).not.toHaveBeenCalled();

		const { body } = await api<{ approvals: Approval[] }>("/approvals?status=pending");
		expect(body.approvals).toHaveLength(1);
		const [approval] = body.approvals;
		expect(approval!.summary).toBe("POST https://hooks.example.test/order with a 11-character body");

		let reported = "";
		faux.setResponses([
			(context) => {
				reported = lastUserText(context.messages);
				return fauxAssistantMessage("Your pizza is ordered.");
			},
		]);
		const decided = await post<Approval>(`/approvals/${approval!.id}/approve`, { note: "extra cheese" });
		expect(decided.status).toBe(200);
		expect(decided.body).toMatchObject({ status: "approved", result: "HTTP 201 Created\norder 42 created" });
		expect(hook).toHaveBeenCalledOnce();
		expect(hook.mock.calls[0]![0]).toEqual({ method: "POST", body: '{"pizza":1}' });

		const settled = await api(`/sessions/1/operations/approval:${approval!.id}`);
		expect(settled.body).toMatchObject({ status: "done", text: "Your pizza is ordered." });
		expect(reported).toContain(`[Approval ${approval!.id}] The user approved: POST https://hooks.example.test/order`);
		expect(reported).toContain("The user's note: extra cheese");
		expect(reported).toContain("order 42 created");

		// A decision is final: no second run of the action.
		expect((await post(`/approvals/${approval!.id}/approve`)).status).toBe(409);
		expect(hook).toHaveBeenCalledOnce();
	});

	it("tells the agent when the user denies", async () => {
		faux.setResponses([
			toolUse("http_request", { method: "DELETE", url: "https://api.example.test/account" }),
			fauxAssistantMessage("Waiting for approval."),
		]);
		await say("Delete my account.");
		const [approval] = (await api<{ approvals: Approval[] }>("/approvals?status=pending")).body.approvals;

		let reported = "";
		faux.setResponses([
			(context) => {
				reported = lastUserText(context.messages);
				return fauxAssistantMessage("Okay, I won't.");
			},
		]);
		const denied = await post<Approval>(`/approvals/${approval!.id}/deny`);
		expect(denied.body).toMatchObject({ status: "denied", result: null });
		await api(`/sessions/1/operations/approval:${approval!.id}`);
		expect(reported).toContain("The user denied: DELETE https://api.example.test/account");
	});
});
