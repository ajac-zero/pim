// The registry adapter and the promotions against a real buildx and a real (local, throwaway) registry, as the `registry` job of CI runs them: `PIM_TEST_REGISTRY=localhost:5000` with a registry
// listening there and a buildx builder on the host network. Nothing here is published anywhere. Without the variable the file is skipped; CI sets it, so a missing registry fails there.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { promoteEdge } from "./edge-promote.mjs";
import { IMAGE_NAMES, RegistryError, registry } from "./registry.mjs";
import { promoteStable } from "./release-promote.mjs";

const host = process.env.PIM_TEST_REGISTRY;
const run = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const unique = `t${Date.now().toString(36)}`;
const owner = `pimtest/${unique}`;
const ref = (name: string, tag: string) => `${host}/${owner}/${name}:${tag}`;

// A two-platform image with labels, built and pushed the way publish.yml does (no RUN steps, so no emulation is needed).
function build(name: string, tag: string, labels: Record<string, string>) {
	const lines = Object.entries(labels).map(([k, v]) => `LABEL ${k}=${v}`).join("\n");
	execFileSync("docker", ["buildx", "build", "--provenance=false", "--platform", "linux/amd64,linux/arm64", "--push", "-t", ref(name, tag), "-f", "-", "."], { input: `FROM scratch\n${lines}\n`, stdio: ["pipe", "pipe", "pipe"] });
}

describe.skipIf(!host)("the registry adapter against a real registry", () => {
	const reg = registry();

	it("reads the digest and a label of a multi-platform image, and an image reused by tagging is the same image", () => {
		build("pim", "built", { "org.opencontainers.image.revision": "abc123", "dev.pim.image-identity": "id1" });
		const digest = reg.digest(ref("pim", "built"));
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		const raw = JSON.parse(run("buildx", "imagetools", "inspect", ref("pim", "built"), "--format", "{{ json .Manifest }}"));
		expect(digest).toBe(raw.digest);
		expect(JSON.parse(run("buildx", "imagetools", "inspect", ref("pim", "built"), "--format", "{{ json .Image }}"))).toHaveProperty(["linux/arm64"]);
		expect(reg.label(ref("pim", "built"), "org.opencontainers.image.revision")).toBe("abc123");
		reg.tag(ref("pim", "built"), ref("pim", "reused"), ref("pim", "alias"));
		expect(reg.digest(ref("pim", "reused"))).toBe(digest);
		expect(reg.label(ref("pim", "reused"), "org.opencontainers.image.revision")).toBe("abc123");
	});

	it("writes and reads a record", () => {
		reg.writeRecord(ref("pim", "rec"), "dev.pim.edge-commit", "c".repeat(40));
		expect(reg.label(ref("pim", "rec"), "dev.pim.edge-commit")).toBe("c".repeat(40));
	});

	it("tells a missing tag or repository from a registry that cannot be reached", () => {
		expect(reg.digest(ref("pim", "nope"))).toBeNull();
		expect(reg.exists(`${host}/${owner}/absent:1`)).toBe(false);
		expect(reg.label(ref("pim", "nope"), "x")).toBeNull();
		expect(() => reg.exists("localhost:1/x/y:z")).toThrow(RegistryError);
	});

	it("moves stable and edge across all three images", () => {
		for (const name of IMAGE_NAMES) {
			build(name, "1.0.0", { "org.opencontainers.image.version": "1.0.0" });
			build(name, "1.1.0", { "org.opencontainers.image.version": "1.1.0" });
			build(name, "sha-aaaaaaaaaaaa", { "org.opencontainers.image.revision": "a" });
		}
		const result = promoteStable({ owner, host, tags: ["v1.0.0", "v1.1.0"], qualified: () => true });
		expect(result, "stable moved").toMatchObject({ action: "set", stable: "1.1.0" });
		for (const name of IMAGE_NAMES) {
			expect(reg.digest(ref(name, "stable"))).toBe(reg.digest(ref(name, "1.1.0")));
			expect(reg.digest(ref(name, "1.1"))).toBe(reg.digest(ref(name, "1.1.0")));
		}
		const sha = "a".repeat(40);
		expect(promoteEdge({ owner, host, sha, decide: () => ({ action: "promote", why: "test" }) }).action).toBe("promoted");
		for (const name of IMAGE_NAMES) expect(reg.digest(ref(name, "edge"))).toBe(reg.digest(ref(name, "sha-aaaaaaaaaaaa")));
		expect(reg.label(ref("pim", "edge-commit"), "dev.pim.edge-commit")).toBe(sha);
		expect(reg.label(ref("pim", "edge-intent"), "dev.pim.edge-intent")).toBe(sha);
	});
});
