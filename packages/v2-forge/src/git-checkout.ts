// Makes the sandbox's checkout through the git broker: the workspace holds a bounded `pimgit_` grant and a credential helper that trades it for fresh ones, never a git host credential.
import { WORKSPACE_GIT_AUTH_DIR, workspaceCredentialHelper } from "@pim/coding/git-broker/workspace-credential";
import { type ComputeProvider, type ComputeHandle } from "./compute";
import { repoName } from "./authz";
import { ForgeError } from "./errors";
import { type ThreadRow } from "./store";
import { type Credentials } from "./tokens";

/** Where the checkout is in a sandbox. */
export const REPO_DIR = "/workspace/repo";

export type CheckoutDeps = { compute: ComputeProvider; credentials: Credentials; /** Pim's public origin, such as https://pim.example.test: what the sandbox's `origin` points at. */ publicUrl: string; ttlMs?: number };

/** Writes the credential helper and a push-scoped grant into the workspace. Idempotent; run again it brings the grant up to date (a thread that was aborted, or sat for longer than a grant lasts, holds a dead one). */
export async function refreshGitCredentials(d: CheckoutDeps, thread: ThreadRow, handle: ComputeHandle): Promise<string> {
	const name = repoName(thread.repo);
	if (!name || !d.compute.workspace) throw new ForgeError("invalid", `Not a repository: ${thread.repo}`);
	const ws = await d.compute.workspace(handle);
	const url = `${d.publicUrl.replace(/\/$/, "")}/api/coding/git/${name}.git`;
	const token = d.credentials.gitToken(thread, { repo: name, scope: "push", ttlMs: d.ttlMs });
	const enc = (s: string) => new TextEncoder().encode(s);
	await ws.writeFile(`${WORKSPACE_GIT_AUTH_DIR}/helper.mjs`, enc(workspaceCredentialHelper), 0o700);
	await ws.writeFile(`${WORKSPACE_GIT_AUTH_DIR}/credential.json`, enc(JSON.stringify({ url, token })), 0o600);
	return url;
}

/** Writes the credential helper and a push-scoped grant, clones the repository through the broker at the thread's ref, and checks out its own branch. Idempotent: an existing checkout is left alone. */
/** `restore` is the thread's last autosave bundle (a sandbox given back when idle): the work the clone doesn't have is brought back from it. */
export async function prepareCheckout(d: CheckoutDeps, thread: ThreadRow, handle: ComputeHandle, restore?: { bundle: Uint8Array; head: string } | null): Promise<void> {
	const url = await refreshGitCredentials(d, thread, handle);
	const ws = await d.compute.workspace!(handle);
	const run = async (cmd: string[]) => {
		const r = await d.compute.exec(handle, cmd, { cwd: "/workspace", timeoutMs: 10 * 60_000 });
		if (r.code !== 0) throw new ForgeError("conflict", `${cmd.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).replace(/pimgit_[\w.-]+/g, "[redacted]").slice(-300)}`);
		return r;
	};
	if ((await d.compute.exec(handle, ["test", "-d", `${REPO_DIR}/.git`], { cwd: "/workspace" })).code === 0) return;
	await run(["git", "config", "--global", `credential.${url}.helper`, `!node ${WORKSPACE_GIT_AUTH_DIR}/helper.mjs`]);
	// Without this git doesn't tell the helper which repository it is asked for, and the helper then hands out nothing.
	await run(["git", "config", "--global", `credential.${url}.useHttpPath`, "true"]);
	await run(["git", "clone", "--quiet", url, REPO_DIR]);
	if (thread.ref) await run(["git", "-C", REPO_DIR, "checkout", "--quiet", thread.ref]);
	if (thread.branch) await run(["git", "-C", REPO_DIR, "checkout", "--quiet", "-B", thread.branch]);
	if (restore) {
		await ws.writeFile("/workspace/.pim-restore.bundle", restore.bundle, 0o600);
		await run(["git", "-C", REPO_DIR, "fetch", "--quiet", "/workspace/.pim-restore.bundle", "HEAD"]);
		await run(["git", "-C", REPO_DIR, "checkout", "--quiet", "-B", thread.branch ?? "restored", restore.head]);
		await d.compute.exec(handle, ["rm", "-f", "/workspace/.pim-restore.bundle"], { cwd: "/workspace" }).catch(() => {});
	}
}
