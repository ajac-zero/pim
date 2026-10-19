import type { Message } from "@earendil-works/pi-ai";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval } from "../src/store";
import { api, apiUrl, pendingApproval, post, say, TOKEN, toolUse } from "./helpers";
import { faux } from "./worker";

/** A page with a form whose button changes the page, so a click shows in what's read after. */
const FORM = `data:text/html;charset=utf-8,${encodeURIComponent(`<title>Orders</title>
<h1>Order soup</h1>
<p>Tomato, <b>4 €</b>.</p>
<label>Name <input id="name"></label>
<a href="#menu">Menu</a>
<button onclick="document.querySelector('h1').textContent = 'Ordered for ' + document.querySelector('#name').value">Order</button>
<label><input type="checkbox" style="opacity:0">Extra bread</label>
<button style="display:none">Hidden</button>`)}`;

function lastToolResult(messages: readonly Message[]): string {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function callTool(name: string, args: Record<string, unknown>) {
	let result = "";
	faux.setResponses([
		toolUse(name, args as never),
		(context) => {
			result = lastToolResult(context.messages);
			return toolUse("send_to_user", { message: "Done." });
		},
	]);
	await say(`Please use ${name}`);
	return result;
}

/** The number the page gives an element, as `[12 button “Order”]`. */
function refOf(page: string, role: string, name: string): number {
	const found = page.match(new RegExp(`\\[(\\d+) ${role} “${name}”`));
	if (!found) throw new Error(`No ${role} “${name}” in:\n${page}`);
	return Number(found[1]);
}

const setPermission = (tool: string, permission: string | null) =>
	api("/permissions", { method: "PUT", body: JSON.stringify({ app: null, tool, permission }) });

afterEach(async () => {
	await api("/browser", { method: "DELETE" });
	await setPermission("browser_click", null);
	await setPermission("browser_type", null);
});

describe("the browser", () => {
	it("reads pages, and clicks and types only once the person approves what the page shows", async () => {
		const page = await callTool("browser_open", { url: FORM });
		expect(page).toContain("Page: Orders");
		expect(page).toContain("# Order soup");
		expect(page).toContain("Tomato, 4 €.");
		expect(page).not.toContain("Hidden");
		// A checkbox drawn by its label is there to click, through the label.
		expect(page).toMatch(/\[\d+ checkbox “Extra bread”\]/);
		const name = refOf(page, "textbox", "Name");
		const order = refOf(page, "button", "Order");

		// Typing asks, naming the field as the page labels it.
		faux.setResponses([toolUse("browser_type", { ref: name, text: "Ada" }), toolUse("send_to_user", { message: "Typed." })]);
		const naming = say("Put my name in.");
		const typing = await pendingApproval();
		expect(typing.summary).toBe("On a page the agent wrote, type “Ada” into the text box “Name”");
		await post<Approval>(`/approvals/${typing.id}/approve`);
		expect(await naming).toMatchObject({ status: "done", replies: ["Typed."] });

		// So does clicking; the page as it is after comes back with the decision, as the call's result.
		faux.setResponses([toolUse("browser_click", { ref: order }), toolUse("send_to_user", { message: "Ordered." })]);
		const ordering = say("Order it.");
		const clicking = await pendingApproval();
		expect(clicking.summary).toBe("On a page the agent wrote, click the button “Order”");
		const decided = await post<Approval>(`/approvals/${clicking.id}/approve`);
		expect(decided.body.result).toContain("# Ordered for Ada");
		expect(await ordering).toMatchObject({ status: "done", replies: ["Ordered."] });

		// The person can see where it is.
		expect((await api("/browser")).body).toEqual({ available: true, page: { url: FORM, title: "Orders" } });
	});

	it("refuses an element that isn't on the page, and never reuses a number for another", async () => {
		const first = await callTool("browser_open", { url: FORM });
		const order = refOf(first, "button", "Order");
		const again = await callTool("browser_open", { url: FORM });
		// The same page loaded anew numbers its elements past the ones before.
		expect(refOf(again, "button", "Order")).toBeGreaterThan(order);
		const stale = await callTool("browser_click", { ref: order });
		expect(stale).toContain(`There is no [${order}] on the page now`);
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);
	});

	it("clicks at once when the person lets it", async () => {
		await setPermission("browser_click", "on");
		const page = await callTool("browser_open", { url: FORM });
		const clicked = await callTool("browser_click", { ref: refOf(page, "button", "Order") });
		expect(clicked).toContain("approved automatically");
		expect(clicked).toContain("# Ordered for");
	});

	it("saves screenshots to the person's files, and shows them one", async () => {
		expect((await api("/browser")).body).toEqual({ available: true, page: null });
		expect((await callTool("browser_screenshot", {})).toLowerCase()).toContain("closed");
		await callTool("browser_open", { url: FORM });
		const saved = await callTool("browser_screenshot", { path: "/workspace/soup.png" });
		expect(saved).toBe("Saved to /workspace/soup.png.");
		const file = await exports.default.fetch(new Request(apiUrl("/files/content?path=/workspace/soup.png"), { headers: { Authorization: `Bearer ${TOKEN}` } }));
		expect([...new Uint8Array(await file.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

		const shown = await exports.default.fetch(new Request(apiUrl("/browser/screenshot"), { headers: { Authorization: `Bearer ${TOKEN}` } }));
		expect(shown.headers.get("content-type")).toBe("image/png");
		await shown.body?.cancel();
		// A local Chrome has no Live View to take it over with.
		expect((await post("/browser/live")).status).toBe(501);

		// Closing it ends the session: nothing is shown after.
		await callTool("browser_close", {});
		expect((await api("/browser")).body.page).toBeNull();
		expect((await api("/browser/screenshot")).status).toBe(404);
	});
});
