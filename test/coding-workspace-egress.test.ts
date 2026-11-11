import { describe, expect, it } from "vitest";
import { egressAllows, egressPolicy, gatewayInjection, gitBrokerInjection, INJECTED_PLACEHOLDER, injectedHeaders, normalizePath, placeSecret } from "../src/coding/workspace/egress";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import type { WorkspaceSpec } from "../src/coding/workspace/types";

const ORIGIN = "https://pim.example.test";

describe("the egress policy", () => {
	it("maps a plain allowlist onto a policy with nothing injected", () => {
		expect(egressPolicy({ allow: ["Registry.npmjs.org", "pypi.org", "registry.npmjs.org", "*.ampcode.com"] })).toEqual({ allow: ["registry.npmjs.org", "pypi.org", "*.ampcode.com"], inject: [] });
		expect(egressPolicy({ allow: [] })).toEqual({ allow: [], inject: [] });
	});

	it("allows a host that has an injection rule, and keeps rules for one host's paths apart", () => {
		const policy = egressPolicy({
			allow: ["pypi.org"],
			inject: [gitBrokerInjection(ORIGIN, "/api/coding/git", "git-token"), gatewayInjection(ORIGIN, "/api/coding/gateway", "openai", "gateway-token"), { host: "pim.example.test", pathPrefix: "/api/coding/git", headers: { "x-extra": "1" } }],
		});
		expect(policy.allow).toEqual(["pypi.org", "pim.example.test"]);
		expect(policy.inject).toEqual([
			{ host: "pim.example.test", pathPrefix: "/api/coding/git", headers: { authorization: "Bearer git-token", "x-extra": "1" } },
			{ host: "pim.example.test", pathPrefix: "/api/coding/gateway", headers: { authorization: "Bearer gateway-token" } },
		]);
		expect(injectedHeaders(policy, "pim.example.test", "/api/coding/git/acme/demo.git/info/refs")).toEqual({ authorization: "Bearer git-token", "x-extra": "1" });
		expect(injectedHeaders(policy, "PIM.example.test", "/api/coding/gateway/openai/v1/responses")).toEqual({ authorization: "Bearer gateway-token" });
		expect(injectedHeaders(policy, "pim.example.test", "/other")).toEqual({});
		expect(injectedHeaders(policy, "pypi.org", "/api/coding/git")).toEqual({});
	});

	it("gives the model gateway token as the family's clients send it", () => {
		expect(gatewayInjection(ORIGIN, "/g", "anthropic", "t").headers).toEqual({ "x-api-key": "t" });
		expect(gatewayInjection(ORIGIN, "/g", "openai", "t").headers).toEqual({ authorization: "Bearer t" });
	});

	it("matches wildcard hosts to subdomains only", () => {
		const policy = { allow: ["*.example.test"], inject: [{ host: "*.example.test", headers: { "x-key": "k" } }] };
		expect(egressAllows(policy, "api.example.test")).toBe(true);
		expect(egressAllows(policy, "example.test")).toBe(false);
		expect(egressAllows(policy, "badexample.test")).toBe(false);
		expect(injectedHeaders(policy, "api.example.test")).toEqual({ "x-key": "k" });
		expect(injectedHeaders(policy, "example.test")).toEqual({});
	});

	it("puts a secret in the workspace's environment only on a provider that can't inject it", () => {
		const rule = gitBrokerInjection(ORIGIN, "/g", "secret");
		expect(placeSecret({ capabilities: { egressInjection: true } as never }, rule, "secret")).toEqual({ env: INJECTED_PLACEHOLDER, rule });
		expect(placeSecret({ capabilities: { egressInjection: false } as never }, rule, "secret")).toEqual({ env: "secret" });
	});
});

describe("the fake provider's sessions", () => {
	const spec: WorkspaceSpec = { sessionId: "s", image: "default", repo: { url: "https://example.test/r.git", ref: "main", branch: "work" }, limits: { cpu: 1, memMiB: 64, diskMiB: 8, pids: 8, wallClockMin: null }, egress: { allow: [] }, gitAuth: { mode: "none" } };

	it("stops a workspace at its session cap, and a resume begins a new session", async () => {
		let now = 1_000;
		const provider = new FakeWorkspaceProvider({ sessionMaxMin: 1, now: () => now });
		const ref = await provider.create(spec);
		const workspace = (await provider.get(ref))!;
		await workspace.writeFile("kept.txt", new TextEncoder().encode("kept"));
		now += 59_999;
		expect((await workspace.status()).state).toBe("running");
		now += 1;
		await expect(workspace.readFile("kept.txt")).rejects.toThrow(/maximum duration/);
		expect((await workspace.status()).state).toBe("stopped");
		expect(await provider.resumeOrCreate(ref, spec)).toEqual({ ref, resumed: true });
		expect(new TextDecoder().decode(await workspace.readFile("kept.txt"))).toBe("kept");
		now += 59_000;
		expect((await workspace.status()).state).toBe("running");
	});
});

describe("matching what a request really reaches", () => {
	const policy = { allow: [], inject: [gitBrokerInjection(ORIGIN, "/api/coding/git", "git-token")] };
	const headers = (path: string, host = "pim.example.test") => injectedHeaders(policy, host, path);
	const GIT = { authorization: "Bearer git-token" };

	it("matches whole path segments of the normalized path", () => {
		expect(headers("/api/coding/git")).toEqual(GIT);
		expect(headers("/api/coding/git/")).toEqual(GIT);
		expect(headers("/api/coding/git/acme/demo.git?service=x")).toEqual(GIT);
		expect(headers("/api/coding//git/./acme")).toEqual(GIT);
		expect(headers("/api/coding/gitx")).toEqual({});
		expect(headers("/api/coding/gitx/acme")).toEqual({});
		expect(headers("/api/coding")).toEqual({});
	});

	it("resolves dot segments and percent-encoding before matching, and refuses paths it can't read", () => {
		expect(headers("/api/coding/git/../other")).toEqual({});
		expect(headers("/api/coding/git/%2e%2e/other")).toEqual({});
		expect(headers("/api/coding/git/%2E%2E/gitx")).toEqual({});
		expect(headers("/x/../api/coding/git/a")).toEqual(GIT);
		expect(headers("/api/coding/%67it/a")).toEqual(GIT);
		expect(headers("/api/coding%2fgit/a")).toEqual({});
		expect(headers("/api/coding/git%5ca")).toEqual({});
		expect(headers("/api/coding/git/%zz")).toEqual({});
		expect(normalizePath("/a/%2e%2e/%2e%2e/b")).toBe("/b");
	});

	it("fails closed for a host that differs in any way", () => {
		expect(headers("/api/coding/git", "pim.example.test.")).toEqual({});
		expect(headers("/api/coding/git", "pim.example.test@evil.test")).toEqual({});
		expect(egressAllows(policy, "pim.example.test.")).toBe(false);
	});
});

describe("the fake provider's egress", () => {
	const spec: WorkspaceSpec = { sessionId: "e", image: "default", repo: { url: "https://example.test/r.git", ref: "main", branch: "work" }, limits: { cpu: 1, memMiB: 64, diskMiB: 8, pids: 8, wallClockMin: null }, egress: { allow: [], inject: [gitBrokerInjection(ORIGIN, "/api/coding/git", "git-token")] }, gitAuth: { mode: "none" } };

	/** curl in a workspace of an injecting provider: its exit code, and what the proxy then held of the request. */
	async function curl(...args: string[]) {
		const provider = new FakeWorkspaceProvider({ egressInjection: true });
		const workspace = (await provider.get(await provider.create(spec)))!;
		let code: number | null = null;
		for await (const event of workspace.exec(["curl", ...args], { timeoutMs: 5_000 })) if (event.type === "exit") code = event.code;
		return { code, request: provider.requests[0] };
	}

	const GIT = { authorization: "Bearer git-token" };

	it("injects for the target host and the path as written, on whole segments", async () => {
		expect(await curl(`${ORIGIN}/api/coding/git/acme/demo.git`)).toMatchObject({ code: 0, request: { host: "pim.example.test", injected: GIT } });
		expect((await curl(`${ORIGIN}/api/coding/gitx/acme`)).request!.injected).toEqual({});
		expect((await curl(`${ORIGIN}/api/coding/git/../other`)).request!.injected).toEqual({});
		expect((await curl(`${ORIGIN}/api/coding/git/%2e%2e/other`)).request!.injected).toEqual({});
		expect((await curl(`${ORIGIN}/api/coding/git%2fa`)).request!.injected).toEqual({});
	});

	it("takes the host from the target, not a Host header or userinfo", async () => {
		expect((await curl("-H", "Host: pim.example.test", "https://evil.test/api/coding/git/a")).code).toBe(7);
		expect((await curl("https://pim.example.test@evil.test/api/coding/git/a")).code).toBe(7);
		// The right target with another name in its Host header still gets what the target gets.
		expect(await curl("-H", "Host: evil.test", `${ORIGIN}/api/coding/git/a`)).toMatchObject({ code: 0, request: { host: "pim.example.test", injected: GIT } });
	});

	it("fails closed for a trailing-dot host", async () => {
		expect((await curl("https://pim.example.test./api/coding/git/a")).code).toBe(7);
	});
});
