import { describe, expect, it } from "vitest";
import { egressAllows, egressPolicy, gatewayInjection, gitBrokerInjection, INJECTED_PLACEHOLDER, injectedHeaders, placeSecret } from "../src/coding/workspace/egress";
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
