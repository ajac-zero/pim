import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareCheckout } from "../src/git-checkout";
import type { ComputeProvider } from "../src/compute";
import { ada, startReq, stack } from "./stack";

describe("the sandbox's checkout through the broker", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
	});
	afterAll(async () => s.close());

	it("writes a push grant and the helper into the sandbox, clones through the broker's URL, never puts the grant in a command, and leaves an existing checkout alone", async () => {
		const files = new Map<string, string>();
		const cmds: string[][] = [];
		let cloned = false;
		const compute = {
			id: "x",
			find: async () => null,
			create: async () => ({ id: "x", provider: "x", tag: "x" }),
			destroy: async () => {},
			workspace: async () => ({ writeFile: async (p: string, d: Uint8Array) => void files.set(p, new TextDecoder().decode(d)) }),
			exec: async (_h: unknown, cmd: readonly string[]) => {
				cmds.push([...cmd]);
				if (cmd[0] === "test") return { code: cloned ? 0 : 1, stdout: "", stderr: "" };
				if (cmd[1] === "clone") cloned = true;
				return { code: 0, stdout: "", stderr: "" };
			},
		} as unknown as ComputeProvider;
		const { threadId } = await s.forge.start(ada, startReq("co-1", { harness: "claude-code", ref: "release" }));
		const t = (await s.store.get(threadId))!;
		const deps = { compute, credentials: s.credentials, publicUrl: "https://pim.example.test/" };
		await prepareCheckout(deps, t, { id: "x", provider: "x", tag: "x" });
		const cred = JSON.parse(files.get("/workspace/.config/pim/git/credential.json")!);
		expect(cred.url).toBe("https://pim.example.test/api/coding/git/acme/app.git");
		await expect(s.credentials.verifyGit(cred.token, { repo: "acme/app", op: "push", branch: t.branch!, defaultBranch: "main" })).resolves.toBeTruthy();
		expect(files.get("/workspace/.config/pim/git/helper.mjs")).toContain("credential");
		const flat = cmds.map((c) => c.join(" "));
		expect(flat.some((c) => c.startsWith("git clone --quiet https://pim.example.test/api/coding/git/acme/app.git /workspace/repo"))).toBe(true);
		// Git only names the repository to the credential helper with useHttpPath, and the helper only answers for its own repository.
		expect(flat).toContain("git config --global credential.https://pim.example.test/api/coding/git/acme/app.git.useHttpPath true");
		expect(flat.some((c) => c.includes("checkout --quiet release"))).toBe(true);
		expect(flat.some((c) => c.includes(`checkout --quiet -B ${t.branch}`))).toBe(true);
		expect(flat.some((c) => c.includes("pimgit_"))).toBe(false);
		const before = cmds.length;
		await prepareCheckout(deps, t, { id: "x", provider: "x", tag: "x" });
		expect(cmds.slice(before).some((c) => c[1] === "clone")).toBe(false);
	});

	it("tries a clone again while the host is rate limiting or briefly down, pausing between tries, and fails at once on anything else", async () => {
		const run = async (failures: string[], delays: number[]) => {
			const cmds: string[][] = [];
			let tries = 0;
			let cloned = false;
			const compute = {
				id: "x",
				workspace: async () => ({ writeFile: async () => {} }),
				exec: async (_h: unknown, cmd: readonly string[]) => {
					cmds.push([...cmd]);
					if (cmd[0] === "test") return { code: cloned ? 0 : 1, stdout: "", stderr: "" };
					if (cmd[1] === "clone") {
						const said = failures[tries++];
						if (said === undefined) cloned = true;
						else return { code: 128, stdout: "", stderr: said };
					}
					return { code: 0, stdout: "", stderr: "" };
				},
			} as unknown as ComputeProvider;
			const { threadId } = await s.forge.start(ada, startReq(`co-retry-${Math.random()}`, { harness: "claude-code" }));
			const t = (await s.store.get(threadId))!;
			const outcome = await prepareCheckout({ compute, credentials: s.credentials, publicUrl: "https://pim.example.test", retryDelaysMs: delays }, t, { id: "x", provider: "x", tag: "x" }).then(() => "cloned", (e: Error) => e.message);
			return { outcome, clones: cmds.filter((c) => c[1] === "clone").length };
		};
		expect(await run(["fatal: unable to access: The requested URL returned error: 429", "error: RPC failed; HTTP 503 curl 22"], [0, 0, 0])).toEqual({ outcome: "cloned", clones: 3 });
		// Three retries, then the last error, with what git said.
		const gave = await run(Array(10).fill("error: RPC failed; HTTP 503 curl 22"), [0, 0, 0]);
		expect(gave.clones).toBe(4);
		expect(gave.outcome).toContain("RPC failed; HTTP 503");
		// A repository that isn't there is not retried.
		expect(await run(["fatal: repository 'x' not found"], [0, 0, 0])).toMatchObject({ clones: 1, outcome: expect.stringContaining("not found") });
	});
});
