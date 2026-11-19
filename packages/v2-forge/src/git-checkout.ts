// Makes the sandbox's checkout through the git broker: the workspace holds a bounded `pimgit_` grant and a credential helper that trades it for fresh ones, never a git host credential.
import { WORKSPACE_GIT_AUTH_DIR, workspaceCredentialHelper } from "@pim/coding/git-broker/workspace-credential";
import { type ComputeProvider, type ComputeHandle } from "./compute";
import { repoName } from "./authz";
import { ForgeError } from "./errors";
import { type ThreadRow } from "./store";
import { type Credentials } from "./tokens";

/** Where the checkout is in a sandbox. */
export const REPO_DIR = "/workspace/repo";

export type CheckoutDeps = { compute: ComputeProvider; credentials: Credentials; /** Pim's public origin, such as https://pim.example.test: what the sandbox's `origin` points at. */ publicUrl: string; ttlMs?: number; /** The pauses before the retries of a clone or fetch the git host rate limited or briefly refused, one entry per retry; 5 s, 15 s and 45 s unless given. */ retryDelaysMs?: readonly number[] };

/** The pauses before the retries of a clone or fetch the host rate limited or briefly refused, as v1 paced them. */
export const GIT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

/** Whether what git printed says the host rate limited the request or was briefly down: worth trying again. A missing repository or a refused login is not. */
export const gitRateLimited = (message: string): boolean => /error: (429|502|503|504)\b|HTTP (429|502|503|504)\b|RPC failed|rate limit|Too Many Requests|\b(502|503|504)\b.*(Bad Gateway|Unavailable|Timeout)/i.test(message);

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
export async function prepareCheckout(d: CheckoutDeps, thread: ThreadRow, handle: ComputeHandle, restore?: { bundle: Uint8Array; head: string } | null, o: { /** The sandbox was restored from an environment snapshot, which holds the repository as it was when the snapshot was made: it is brought to the thread's ref and branch. */ restored?: boolean } = {}): Promise<void> {
	const url = await refreshGitCredentials(d, thread, handle);
	const ws = await d.compute.workspace!(handle);
	const delays = d.retryDelaysMs ?? GIT_RETRY_DELAYS_MS;
	const run = async (cmd: string[]) => {
		// A clone or fetch is asked again, after a pause, while the host is rate limiting or briefly down.
		const talks = cmd.includes("clone") || cmd.includes("fetch");
		for (let attempt = 0; ; attempt++) {
			const r = await d.compute.exec(handle, cmd, { cwd: "/workspace", timeoutMs: 10 * 60_000 });
			if (r.code === 0) return r;
			const said = (r.stderr || r.stdout).replace(/pimgit_[\w.-]+/g, "[redacted]");
			if (!talks || attempt >= delays.length || !gitRateLimited(said)) throw new ForgeError("conflict", `${cmd.slice(0, 2).join(" ")} failed: ${said.slice(-300)}`);
			await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
		}
	};
	const present = (await d.compute.exec(handle, ["test", "-d", `${REPO_DIR}/.git`], { cwd: "/workspace" })).code === 0;
	if (present && !o.restored) return;
	await run(["git", "config", "--global", `credential.${url}.helper`, `!node ${WORKSPACE_GIT_AUTH_DIR}/helper.mjs`]);
	// Without this git doesn't tell the helper which repository it is asked for, and the helper then hands out nothing.
	await run(["git", "config", "--global", `credential.${url}.useHttpPath`, "true"]);
	if (present) {
		// The snapshot's checkout is the repository as it was: bring in what is new, and start from the thread's ref.
		await run(["git", "-C", REPO_DIR, "remote", "set-url", "origin", url]);
		await run(["git", "-C", REPO_DIR, "fetch", "--quiet", "--tags", "origin"]);
		const target = thread.ref ?? "origin/HEAD";
		const remote = thread.ref ? await d.compute.exec(handle, ["git", "-C", REPO_DIR, "rev-parse", "--verify", "--quiet", `origin/${thread.ref}`], { cwd: "/workspace" }) : { code: 0 };
		await run(["git", "-C", REPO_DIR, "checkout", "--quiet", "--force", "--detach", remote.code === 0 && thread.ref ? `origin/${thread.ref}` : target]);
	} else {
		await run(["git", "clone", "--quiet", url, REPO_DIR]);
		if (thread.ref) await run(["git", "-C", REPO_DIR, "checkout", "--quiet", thread.ref]);
	}
	if (thread.branch) await run(["git", "-C", REPO_DIR, "checkout", "--quiet", "-B", thread.branch]);
	if (restore) {
		await ws.writeFile("/workspace/.pim-restore.bundle", restore.bundle, 0o600);
		await run(["git", "-C", REPO_DIR, "fetch", "--quiet", "/workspace/.pim-restore.bundle", "HEAD"]);
		await run(["git", "-C", REPO_DIR, "checkout", "--quiet", "-B", thread.branch ?? "restored", restore.head]);
		await d.compute.exec(handle, ["rm", "-f", "/workspace/.pim-restore.bundle"], { cwd: "/workspace" }).catch(() => {});
	}
}
