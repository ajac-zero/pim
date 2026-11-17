// A person's harness sign-in end to end: the CLI's own device-code sign-in runs in a short-lived workspace, its login lands sealed in the person's vault, and the threads that waited for it go on.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWorkspaceProvider } from "@pim/coding/workspace/fake";
import { tx } from "../src/db";
import { HarnessLogins } from "../src/login-flows";
import { ForgeVault, LocalEnvelopeCrypto } from "../src/vault";
import { ada, startReq, stack } from "./stack";

describe("harness sign-in", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let vault: ForgeVault;
	let provider: FakeWorkspaceProvider;
	let logins: HarnessLogins;
	let saves = true;

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		vault = new ForgeVault(s.db, new LocalEnvelopeCrypto({ keyId: "k", key: randomBytes(32) }));
		provider = new FakeWorkspaceProvider();
		// Codex's device-code sign-in: it prints the page and the code, and exits 0 once the person has entered it, having saved its login.
		provider.register("sh", async (ctx) => {
			if (saves) await ctx.workspace.writeFile(`${ctx.env.CODEX_HOME}/auth.json`, new TextEncoder().encode('{"tokens":"opaque"}'), 0o600);
			return { stdout: "1. Open https://auth.openai.com/codex/device\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-12345\n", code: saves ? 0 : 1 };
		});
		logins = new HarnessLogins({ provider, image: "pim-workspace:local", vault: () => vault, onConnected: async (owner, harness) => void (await s.forge.resumeAfterLogin(owner, harness)) });
	});
	afterAll(() => s.close());

	it("keeps the login the CLI saves in the person's vault, resumes the thread that waited for it, and fails a sign-in that saved nothing", async () => {
		const { threadId } = await s.forge.start(ada, startReq("login-1", { harness: "codex" }));
		await tx(s.db, async (q) => s.store.setState(q, threadId, "waiting_input", "login_required", "Connect Codex"));
		expect(await logins.status("ada", "codex")).toMatchObject({ state: "none" });

		const started = await logins.start("ada", "codex");
		expect(started).toMatchObject({ url: "https://auth.openai.com/codex/device", userCode: "ABCD-12345" });
		await expect.poll(async () => (await logins.status("ada", "codex")).state).toBe("connected");
		expect((await vault.status("ada")).find((h) => h.harness === "codex")).toMatchObject({ connected: true });
		expect(new TextDecoder().decode((await vault.load("ada", "codex")).files![0]!.data)).toContain("opaque");
		// Another person's vault holds nothing, and the sign-in's workspace is gone.
		expect((await vault.status("eve")).find((h) => h.harness === "codex")!.connected).toBe(false);
		expect(await provider.list({})).toEqual([]);
		// The thread that stopped for want of the login goes on.
		await expect.poll(async () => (await s.store.get(threadId))!.state).toBe("idle");
		expect((await s.db.query("select kind from pim_forge.forge_inbox where thread_id = $1 and kind = 'continue'", [threadId])).rows).toHaveLength(1);

		// A CLI that exits without a login is a failed sign-in, and keeps nothing.
		saves = false;
		await vault.delete("ada", "codex");
		await logins.start("ada", "codex");
		await expect.poll(async () => (await logins.status("ada", "codex")).state).toBe("failed");
		expect((await vault.status("ada")).find((h) => h.harness === "codex")!.connected).toBe(false);
		await expect(logins.start("ada", "pi")).rejects.toThrow(/No sign-in/);
	});
});
