import { describe, expect, it, vi } from "vitest";
import { handleEgress } from "../cloudflare-egress";
import { egressPolicy, gatewayInjection, gitBrokerInjection } from "../src/coding/workspace/egress";
import type { EgressPolicy } from "../src/coding/workspace/types";

const policy: EgressPolicy = { allow: ["allowed.example", "*.packages.example"], inject: [{ host: "api.example", pathPrefix: "/api/git", headers: { authorization: "Bearer test-secret" } }] };

/** What an Amp thread's workspace gets (`#spec` in src/coding/thread-do.ts): the common hosts, the harness's own, and the credentials its proxy injects. */
const ampThread = (): EgressPolicy =>
	egressPolicy({
		allow: ["registry.npmjs.org", "pypi.org", "pim.example.test", "ampcode.com", "*.ampcode.com"],
		inject: [gitBrokerInjection("https://pim.example.test", "/api/coding/git", "git-token"), gatewayInjection("https://pim.example.test", "/api/coding/gateway", "anthropic", "gateway-token")],
	});

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
	it("forwards an allowed GET and answers an allowed WebSocket upgrade with a relayed 101", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const amp = ampThread();
			const get = await handleEgress(new Request("https://ampcode.com/"), amp, "*", async (request) => {
				// The harness's own host gets none of the credentials, which are for Pim's hosts alone.
				expect((request as Request).headers.has("authorization")).toBe(false);
				expect((request as Request).headers.has("x-api-key")).toBe(false);
				return new Response("ok");
			});
			expect(get.status).toBe(200);
			// Amp's own upgrade URL, whose query carries the thread's revocation token.
			const upgrade = new Request("https://ampcode.com/?rvt-token=hush", { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "k", "sec-websocket-extensions": "permessage-deflate" } });
			let sent: Request | undefined;
			// What the destination answers: a socket with the subprotocol it chose. The 101 Pim answers with
			// is its own, wrapping a socket Pim relays through, so its life can be logged (the next test).
			const destinationPair = new WebSocketPair();
			const upstreamSide = destinationPair[0];
			const handlerSide = destinationPair[1];
			const response = await handleEgress(upgrade, amp, "*", async (input) => {
				sent = input as Request;
				return new Response(null, { status: 101, webSocket: handlerSide, headers: { "sec-websocket-protocol": "amp.v1", "sec-websocket-extensions": "permessage-deflate" } });
			});
			expect(response.status).toBe(101);
			expect(response.webSocket).toBeDefined();
			// The subprotocol is the container's to see; the compression and the accept key are not, since
			// Pim re-frames the socket and the runtime answers the container's own key.
			expect(response.headers.get("sec-websocket-protocol")).toBe("amp.v1");
			expect(response.headers.has("sec-websocket-extensions")).toBe(false);
			expect(sent?.headers.get("upgrade")).toBe("websocket");
			expect(sent?.headers.get("sec-websocket-key")).toBe("k");
			expect(sent?.headers.has("sec-websocket-extensions")).toBe(false);
			// The destination's status is logged for each pass, with nothing of the request that could hold a token.
			const lines = warn.mock.calls.map((call) => JSON.parse(call[0] as string));
			expect(lines).toEqual([
				expect.objectContaining({ event: "pim.coding.egress_allowed", host: "ampcode.com", method: "GET", status: 200, target: "*" }),
				expect.objectContaining({ event: "pim.coding.egress_allowed", host: "ampcode.com", method: "GET", upgrade: "websocket", status: 101, target: "*" }),
				expect.objectContaining({ event: "pim.coding.egress_ws_open", host: "ampcode.com", protocol: "https:", upgrade: "websocket", target: "*" }),
			]);
			for (const line of lines) expect(Object.keys(line)).not.toContain("path");
			expect(JSON.stringify(lines)).not.toContain("rvt-token");
			expect(JSON.stringify(lines)).not.toContain("hush");
			// The sockets of the relay and of the fake destination are the test's to close. The close
			// events land on later turns, so they are waited for here rather than leaking into the
			// next test's log spy.
			upstreamSide.accept();
			response.webSocket!.accept();
			upstreamSide.close();
			response.webSocket!.close();
			await new Promise((resolve) => setTimeout(resolve, 20));
		} finally {
			warn.mockRestore();
		}
	});
	it("relays an upgraded socket both ways, and logs its open and close with codes and counts but nothing it carries", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const amp = ampThread();
			// The fake ampcode.com: one end of a pair drives the destination's side of the socket, the other
			// is the socket the forwarded fetch answers 101 with.
			const destinationPair = new WebSocketPair();
			const ampSide = destinationPair[0];
			const handlerSide = destinationPair[1];
			const upgrade = new Request("https://ampcode.com/actors/gateway/threadActor/websocket/?rvt-token=hush", { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "k" } });
			const response = await handleEgress(upgrade, amp, "*", async () => new Response(null, { status: 101, webSocket: handlerSide }));
			ampSide.accept();
			const container = response.webSocket!;
			container.accept();
			const nextMessage = (socket: WebSocket) => new Promise<string>((resolve) => socket.addEventListener("message", (event) => resolve(event.data as string), { once: true }));
			const fromAmp = nextMessage(container);
			const fromContainer = nextMessage(ampSide);
			container.send("up the hill");
			ampSide.send("down again");
			expect(await fromContainer).toBe("up the hill");
			expect(await fromAmp).toBe("down again");
			container.send("up once more");
			expect(await nextMessage(ampSide)).toBe("up once more");
			// The destination closes with a code of its own; the container is told the same code.
			const closed = new Promise<CloseEvent>((resolve) => container.addEventListener("close", (event) => resolve(event), { once: true }));
			ampSide.close(4408, "server is going away");
			expect((await closed).code).toBe(4408);
			// Give the relay's own close, forwarded from the container's end, a turn to land.
			await new Promise((resolve) => setTimeout(resolve, 20));
			const lines = warn.mock.calls.map((call) => JSON.parse(call[0] as string));
			const open = lines.find((line) => line.event === "pim.coding.egress_ws_open");
			expect(open).toMatchObject({ host: "ampcode.com", protocol: "https:", method: "GET", upgrade: "websocket", target: "*" });
			const close = lines.find((line) => line.event === "pim.coding.egress_ws_close" && line.side === "upstream");
			expect(close).toMatchObject({ host: "ampcode.com", code: 4408, reason: "server is going away", wasClean: true, upstreamToContainer: 1, containerToUpstream: 2, target: "*" });
			expect(typeof close.durationMs).toBe("number");
			// What the socket carried is never logged: not the query's token, not the messages' contents.
			for (const line of lines) expect(Object.keys(line)).not.toContain("path");
			const logged = JSON.stringify(lines);
			expect(logged).not.toContain("rvt-token");
			expect(logged).not.toContain("hush");
			expect(logged).not.toContain("up the hill");
			expect(logged).not.toContain("down again");
		} finally {
			warn.mockRestore();
		}
	});
	it("logs a 101 that carries no WebSocket and passes it through as it came", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// A destination can answer 101 without a socket to speak the protocol on. The runtime cannot
			// re-frame such a response for the container (a Response with a WebSocket must have one), so
			// handleEgress passes it through untouched and says so, rather than failing.
			const switching = { status: 101, headers: new Headers() } as unknown as Response;
			const response = await handleEgress(new Request("https://ampcode.com/?rvt-token=hush", { headers: { upgrade: "websocket", connection: "Upgrade" } }), ampThread(), "*", async () => switching);
			expect(response).toBe(switching);
			const lines = warn.mock.calls.map((call) => JSON.parse(call[0] as string));
			expect(lines.at(-1)).toMatchObject({ event: "pim.coding.egress_ws_error", host: "ampcode.com", protocol: "https:", reason: "101 without a WebSocket", target: "*" });
			expect(lines.some((line) => line.event === "pim.coding.egress_ws_open")).toBe(false);
			expect(JSON.stringify(lines)).not.toContain("rvt-token");
		} finally {
			warn.mockRestore();
		}
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
	it("marks every denial as Pim's, an upgrade's included", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Every reason the proxy can refuse a request for, on a bare GET and on a WebSocket upgrade.
			const cases: [Request, string][] = [
				[new Request("https://denied.example/"), "host not in allowlist"],
				[new Request("https://allowed.example:8443/"), "port"],
				[new Request("ftp://allowed.example/"), "protocol"],
				[new Request("https://user:pass@allowed.example/"), "credentials in URL"],
				[new Request("https://denied.example/", { headers: { upgrade: "websocket", connection: "Upgrade" } }), "host not in allowlist"],
			];
			for (const [request, reason] of cases) {
				const response = await handleEgress(request, { allow: ["allowed.example"] }, "*", async () => {
					throw new Error("must not forward");
				});
				expect(response.status).toBe(403);
				expect(response.headers.get("x-pim-egress")).toBe("denied");
				expect(JSON.parse(warn.mock.calls.at(-1)![0] as string)).toMatchObject({ event: "pim.coding.egress_denied", reason });
			}
		} finally {
			warn.mockRestore();
		}
	});
});
