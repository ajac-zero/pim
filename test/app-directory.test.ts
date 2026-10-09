import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { type RegistryEntry, rankCandidates } from "../src/extensions/app-directory";
import { say, toolUse } from "./helpers";
import { faux } from "./worker";

const active = { "io.modelcontextprotocol.registry/official": { status: "active" } };

type Server = NonNullable<RegistryEntry["server"]>;

const entry = (name: string, remotes: Server["remotes"], extra: Partial<Server> = {}, meta = active): RegistryEntry => ({
	server: { name, description: `${name} server`, remotes, ...extra },
	_meta: meta,
});

/** What the registry answers for "linear", in its order: a gateway before the real thing. */
const LINEAR: RegistryEntry[] = [
	entry("io.github.pipeworx-io/linear", [{ type: "streamable-http", url: "https://gateway.pipeworx.io/linear/mcp" }]),
	entry("ai.smithery/smithery-linear", [{ type: "streamable-http", url: "https://server.smithery.ai/@smithery/linear/mcp" }]),
	entry("io.usefulapi/linear", [{ type: "streamable-http", url: "https://linear.usefulapi.io/mcp" }]),
	entry(
		"app.linear/linear",
		[
			{ type: "sse", url: "https://mcp.linear.app/sse" },
			{ type: "streamable-http", url: "https://mcp.linear.app/mcp" },
		],
		{ title: "Linear" },
	),
	// Unusable: retired, a URL template, a required API key, SSE only, plain HTTP.
	entry("app.linear/linear-old", [{ type: "streamable-http", url: "https://old.linear.app/mcp" }], {}, {
		"io.modelcontextprotocol.registry/official": { status: "deleted" },
	}),
	entry("eu.nordicmcp/linear", [{ type: "streamable-http", url: "https://nordicmcp.eu/mcp/linear/{token}" }]),
	entry("com.keyed/linear", [
		{ type: "streamable-http", url: "https://mcp.keyed.com/linear", headers: [{ name: "X-Api-Key", isRequired: true }] },
	]),
	entry("com.legacy/linear", [{ type: "sse", url: "https://legacy.com/sse" }]),
	entry("com.plain/linear", [{ type: "streamable-http", url: "http://plain.com/mcp" }]),
];

describe("rankCandidates", () => {
	it("puts the app's own server first, then servers on their publisher's domain, then the rest", () => {
		const ranked = rankCandidates(LINEAR, "Linear");
		expect(ranked.map((candidate) => candidate.url)).toEqual([
			"https://mcp.linear.app/mcp",
			// On its own domain, but smithery.ai and usefulapi.io are not Linear.
			"https://server.smithery.ai/@smithery/linear/mcp",
			"https://linear.usefulapi.io/mcp",
			"https://gateway.pipeworx.io/linear/mcp",
		]);
		expect(ranked[0]).toMatchObject({
			title: "Linear",
			publisher: { kind: "domain", domain: "linear.app" },
			ownDomain: true,
			matchesApp: true,
		});
		expect(ranked[3]!.publisher).toEqual({ kind: "github", user: "pipeworx-io" });
	});

	it("matches subdomain publishers, and does not take a look-alike host for the domain", () => {
		const ranked = rankCandidates(
			[
				entry("com.evil-cloudflare/mcp", [{ type: "streamable-http", url: "https://mcp.evil-cloudflare.com/mcp" }]),
				entry("com.cloudflare.mcp/mcp", [
					{ type: "streamable-http", url: "https://builds.mcp.cloudflare.com/mcp" },
					{ type: "streamable-http", url: "https://notmcp.cloudflare.com.evil.io/mcp" },
					// Ends with "mcp.cloudflare.com" as text, but is not a subdomain of it.
					{ type: "streamable-http", url: "https://evilmcp.cloudflare.com/mcp" },
				]),
			],
			"cloudflare",
		);
		expect(ranked.map((candidate) => [candidate.url, candidate.ownDomain, candidate.matchesApp])).toEqual([
			["https://builds.mcp.cloudflare.com/mcp", true, true],
			// evil-cloudflare.com runs on its own domain, but its name is not "cloudflare".
			["https://mcp.evil-cloudflare.com/mcp", true, false],
			["https://notmcp.cloudflare.com.evil.io/mcp", false, true],
			["https://evilmcp.cloudflare.com/mcp", false, true],
		]);
	});
});

describe("find_app", () => {
	it("gives the model the registry's servers, the app's own first and labeled", async () => {
		const realFetch = globalThis.fetch;
		let searched: URL | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!request.url.startsWith("https://registry.modelcontextprotocol.io/")) return realFetch(input, init);
			searched = new URL(request.url);
			return Response.json({ servers: LINEAR, metadata: { count: LINEAR.length } });
		});

		let result = "";
		faux.setResponses([
			toolUse("find_app", { app: "Linear" }),
			(context) => {
				const last = context.messages.findLast((message: Message) => message.role === "toolResult");
				result = last?.role === "toolResult" ? last.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
				return fauxAssistantMessage("Linear's own server is https://mcp.linear.app/mcp.");
			},
		]);
		await say("Connect my Linear.");

		expect(searched?.pathname).toBe("/v0/servers");
		expect(Object.fromEntries(searched!.searchParams)).toMatchObject({ search: "Linear", version: "latest" });
		const lines = result.split("\n");
		expect(lines[1]).toBe(
			"1. Linear: https://mcp.linear.app/mcp (published by linear.app; the app's own server). app.linear/linear server",
		);
		expect(lines[4]).toContain("published by GitHub user pipeworx-io; third party");
		expect(result).not.toContain("{token}");
	});
});
