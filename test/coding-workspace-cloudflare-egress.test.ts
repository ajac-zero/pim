import { describe, expect, it, vi } from "vitest";
import { handleEgress } from "../cloudflare-egress";
import type { EgressPolicy } from "../src/coding/workspace/types";

const policy: EgressPolicy = { allow: ["allowed.example", "*.packages.example"], inject: [{ host: "api.example", pathPrefix: "/api/git", headers: { authorization: "Bearer test-secret" } }] };
describe("Cloudflare container egress", () => {
	it("injects outside the workspace, replaces supplied headers and never follows redirects", async () => {
		let sent: Request | undefined;
		const response = await handleEgress(
			new Request("https://api.example/api/git/repo", { headers: { authorization: "untrusted", host: "other.example" } }),
			policy,
			"api.example",
			async (input, init) => {
				sent = input as Request;
				expect(init?.redirect).toBe("manual");
				return new Response(null, { status: 302, headers: { location: "https://other.example" } });
			},
		);
		expect(sent?.headers.get("authorization")).toBe("Bearer test-secret");
		expect(sent?.headers.has("host")).toBe(false);
		expect(sent?.redirect).toBe("manual");
		expect(response.status).toBe(302);
	});
	it("injects an exact subdomain's credentials through a wildcard intercept", async () => {
		const scoped = { allow: ["*.packages.example"], inject: [{ host: "private.packages.example", headers: { authorization: "exact-token" } }] };
		for (const [host, expected] of [
			["private.packages.example", "exact-token"],
			["public.packages.example", null],
		] as const) {
			const response = await handleEgress(new Request("https://" + host + "/package"), scoped, "*.packages.example", async (request) => {
				expect((request as Request).headers.get("authorization")).toBe(expected);
				return new Response("ok");
			});
			expect(response.status).toBe(200);
		}
	});
	it("denies a Host/SNI mismatch, trailing dots, unlisted names and nonstandard ports", async () => {
		for (const [url, target] of [
			["https://api.example/api/git", "allowed.example"],
			["https://api.example./api/git", "api.example"],
			["https://denied.example/", "denied.example"],
			["https://packages.example/", "*.packages.example"],
			["https://api.example:8443/api/git", "api.example"],
		])
			expect(
				(
					await handleEgress(new Request(url!), policy, target!, async () => {
						throw new Error("must not forward");
					})
				).status,
			).toBe(403);
	});
	it("with the catch-all target allows only what the policy lists, and still denies trailing dots and ports", async () => {
		const forward = async () => new Response("ok");
		expect((await handleEgress(new Request("https://api.example/api/git"), policy, "*", forward)).status).toBe(200);
		for (const url of ["https://denied.example/", "https://api.example./api/git", "https://api.example:8443/api/git"])
			expect((await handleEgress(new Request(url), policy, "*", async () => { throw new Error("must not forward"); })).status).toBe(403);
	});
	it("does not inject on HTTP or outside the normalized path prefix", async () => {
		for (const url of ["http://api.example/api/git", "https://api.example/api/gitx", "https://api.example/api/git/%2e%2e/other", "https://api.example/api/git/%2fother"]) {
			await handleEgress(new Request(url), policy, "api.example", async (request) => {
				expect((request as Request).headers.has("authorization")).toBe(false);
				return new Response("ok");
			});
		}
	});
	it("uses fresh policies so revoked credentials cannot remain in an old intercept", async () => {
		const revoked = { allow: [] };
		expect((await handleEgress(new Request("https://api.example/api/git"), revoked, "api.example")).status).toBe(403);
	});
	it("forwards an allowed GET and an allowed WebSocket upgrade, returning the 101 untouched", async () => {
		const amp = { allow: ["ampcode.com", "*.ampcode.com"] };
		const get = await handleEgress(new Request("https://ampcode.com/"), amp, "*", async () => new Response("ok"));
		expect(get.status).toBe(200);
		const upgrade = new Request("https://ampcode.com/", { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "k", "sec-websocket-extensions": "permessage-deflate" } });
		let sent: Request | undefined;
		const switching = { status: 101, webSocket: {}, headers: new Headers() } as unknown as Response;
		const response = await handleEgress(upgrade, amp, "*", async (input) => {
			sent = input as Request;
			return switching;
		});
		expect(response).toBe(switching);
		expect(sent?.headers.get("upgrade")).toBe("websocket");
		expect(sent?.headers.get("sec-websocket-key")).toBe("k");
		expect(sent?.headers.has("sec-websocket-extensions")).toBe(false);
	});
	it("logs a denied host with its protocol, method and Upgrade header, and marks the 403 as Pim's", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = await handleEgress(new Request("https://evil.example/", { method: "GET", headers: { upgrade: "websocket" } }), { allow: ["ampcode.com"] }, "*", async () => {
			throw new Error("must not forward");
		});
		expect(response.status).toBe(403);
		expect(response.headers.get("x-pim-egress")).toBe("denied");
		expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ event: "pim.coding.egress_denied", host: "evil.example", protocol: "https:", method: "GET", upgrade: "websocket", reason: "host not in allowlist" });
		warn.mockRestore();
	});
});
