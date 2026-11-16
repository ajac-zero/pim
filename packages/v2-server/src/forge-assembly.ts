/**
 * Forge assembled from the process configuration. The parts that need a place outside Pim (a git host, a sandbox manager, Amp) are
 * wired only when the deployment configures them; without them a coding thread cannot start and says so (`CapabilityUnavailableError`),
 * and everything else, including grants, quotas and reading threads, works.
 */
import { randomBytes } from "node:crypto";
import type { ObjectStore } from "@pim/v2-contracts/platform";
import { Authz } from "@pim/v2-forge/authz";
import type { Db as ForgeDb } from "@pim/v2-forge/db";
import { CapabilityUnavailableError } from "@pim/v2-forge/errors";
import { Forge } from "@pim/v2-forge/forge";
import type { GitHost } from "@pim/v2-forge/ports";
import { ForgeScheduler } from "@pim/v2-forge/scheduler";
import { ForgeStore } from "@pim/v2-forge/store";
import { Credentials } from "@pim/v2-forge/tokens";

const noGitHost = new Proxy({}, { get: (_t, name) => () => Promise.reject(new CapabilityUnavailableError("git host", `no git host is configured (${String(name)})`)) }) as unknown as GitHost;

export type ForgeParts = { forge: Forge; store: ForgeStore; authz: Authz; scheduler: ForgeScheduler; credentials: Credentials; db: ForgeDb };

export function assembleForge(db: ForgeDb, objects: ObjectStore, env: Record<string, string | undefined>): ForgeParts {
	const store = new ForgeStore(db);
	const authz = new Authz(db, { allowedRepos: (env.PIM_CODING_ALLOWED_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean), branchPrefix: env.PIM_CODING_BRANCH_PREFIX ?? "pim/" });
	const scheduler = new ForgeScheduler(db, store, Date.now);
	// Without a configured signing key a process signs with its own, so the broker tokens it issues die with it: fine for a trial, set one in a deployment.
	const credentials = new Credentials(db, env.PIM_CODING_SIGNING_KEY ?? randomBytes(32).toString("base64url"), authz.policy);
	const forge = new Forge({ db, store, authz, scheduler, credentials, git: noGitHost, objects, orbs: () => null, compute: null, ampConfigured: false });
	return { forge, store, authz, scheduler, credentials, db };
}
