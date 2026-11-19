// A thread's environment, as v1's coding thread readied it (docs/coding-environment.md): the repository's files say which toolchains and dependencies it needs and what it checks itself with,
// the steps run in the sandbox, the setup script runs last, and where the host keeps environment snapshots the result is kept by key for the person's next thread of the repository, which
// starts from it. A step that fails is recorded and the thread goes on; no snapshot is kept then, so the next thread tries again.
import { WORKSPACE_GIT_AUTH_DIR } from "@pim/coding/git-broker/workspace-credential";
import { environmentError, environmentKey, lockfileHashes, cacheKeyHashes, NO_ENVIRONMENT, repositorySetupScript, runSetup, SETUP_ENV, snapshotWorthKeeping, type CodingEnvironment } from "@pim/coding/environment-cache";
import { type ChosenSetup, chooseSetup, readEnvConfig } from "@pim/coding/env-config";
import { detectConfiguredSetup, detectRepository, type ProvisionStep, pendingItems, provisionPlan, runProvisionStep, stepOf, unpinnedKeyParts, workspaceFiles } from "@pim/coding/repo-environment";
import { redact } from "@pim/shared/redact";
import { type ComputeHandle, type ComputeProvider } from "./compute";
import { repoName } from "./authz";
import { type ThreadRow } from "./store";

/** How long a finding that a snapshot isn't worth keeping holds; after it, the next build takes one and decides again. */
export const SNAPSHOT_SKIP_TTL_MS = 30 * 24 * 60 * 60_000;
export const STEP_OUTPUT_CHARS = 2048;

/** What the log keeps of one step: flat, so it is an event's data. The output is cleaned of control characters, redacted and cut to its last 2 KiB. */
export function stepRecord(input: { step: "restore" | "provision" | "setup"; command: string; outcome: "ok" | "failed" | "skipped"; exitCode: number | null; ms: number; output: string; outputChars?: number }) {
	const clean = redact(input.output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\r/g, "")).trim();
	const total = Math.max(input.outputChars ?? 0, clean.length);
	return { step: input.step, command: redact(input.command).slice(0, 240), outcome: input.outcome, exitCode: input.exitCode, ms: Math.max(0, Math.round(input.ms)), output: clean.slice(-STEP_OUTPUT_CHARS), outputChars: total, truncated: total > STEP_OUTPUT_CHARS };
}

/** Whose the thread's snapshots are: the person, and the repository as `owner/name` in lowercase. */
export const environmentOwner = (t: Pick<ThreadRow, "ownerId" | "repo">) => ({ userId: t.ownerId, repo: (repoName(t.repo) ?? t.repo).toLowerCase() });

export type EnvironmentIo = {
	compute: ComputeProvider;
	repoDir: string;
	clock: () => number;
	/** The person's saved setup script for this repository; null without one. */
	setting: string | null;
	/** The thread's pool: part of an environment's key, as a snapshot made on one pool is not another's. */
	pool: string;
	image?: string | undefined;
	/** Appends an event to the thread's log. */
	event(kind: string, data: Record<string, unknown>): Promise<void>;
	/** Keeps the environment as it is now, so the page follows it. */
	save(env: CodingEnvironment): Promise<void>;
	/** Whether a snapshot of this key was found not worth keeping lately, and recording that it is or is not. */
	skipped(key: string): Promise<boolean>;
	setSkipped(key: string, skipped: boolean): Promise<void>;
	/** The thread's sandbox now: it changes when `restore` replaces it. */
	handle(): ComputeHandle;
	/** Puts the thread in a sandbox restored from the snapshot `key`, checked out again, and says whether it worked (otherwise it is a plain checkout, to be built in); the sandbox the caller holds is gone either way. */
	restore(key: string): Promise<boolean>;
	/** Writes the thread's git grant into its sandbox again. */
	refreshGit?: () => Promise<void>;
	signal?: AbortSignal | undefined;
};

export class EnvironmentStopped extends Error {}

/**
 * Readies the thread's environment in its sandbox, as a new thread (`rebuild` false: a snapshot with the right key replaces the sandbox, else it is built and kept) or as the person asked
 * again (`rebuild` true: set up again in this sandbox). Returns the environment to keep; throws only `EnvironmentStopped`.
 */
export async function prepareEnvironment(io: EnvironmentIo, thread: ThreadRow, o: { rebuild: boolean; current: CodingEnvironment | null }): Promise<CodingEnvironment> {
	const stop = () => {
		if (io.signal?.aborted) throw new EnvironmentStopped("Readying the environment was stopped: the thread was aborted");
	};
	const owner = environmentOwner(thread);
	const environments = io.compute.environments;
	const now = io.clock;
	let env: CodingEnvironment = { ...NO_ENVIRONMENT, ...(o.current ?? {}), pool: io.pool, rebuildRequested: false };
	const keep = async (change: Partial<CodingEnvironment>) => void (await io.save((env = { ...env, ...change })));
	const failed = async (key: string | null, error: string) => {
		await keep({ state: "failed", key, error, rebuildRequested: false, preparedAt: now() });
		await io.event("environment.failed", { key, error });
		return env;
	};
	const workspace = await io.compute.workspace!(io.handle());
	let setup: ChosenSetup | null;
	let plan: ProvisionStep[];
	let key: string;
	try {
		const profile = await detectRepository(workspaceFiles(workspace, io.repoDir));
		stop();
		plan = provisionPlan(profile);
		const envConfig = await readEnvConfig(workspace, io.repoDir);
		const config = envConfig.config;
		const notes = [...profile.notes, ...envConfig.notes];
		const cacheKeys = await cacheKeyHashes(workspace, io.repoDir, config?.cacheKeys ?? []);
		for (const pattern of cacheKeys.missing) notes.push(`.pim/env.json: the cache key ${JSON.stringify(pattern)} matches no file and is left out`);
		if (config === null && envConfig.error === undefined && (profile.toolchains.length > 0 || profile.dependencies.length > 0)) {
			const toolchains = profile.toolchains.map((each) => (each.version === null ? each.tool : `${each.tool} ${each.version}`)).join(", ") || "no toolchains";
			const installs = profile.dependencies.map((each) => each.command).join(", ");
			notes.push(`detected: ${toolchains}${installs ? `, installing with ${installs}` : ""}`);
			await io.event("environment.detected", { toolchains: profile.toolchains.map((each) => each.tool).join(","), dependencies: profile.dependencies.map((each) => each.tool).join(",") });
		}
		const check = config?.check ?? [];
		await keep({ ...pendingItems(profile), testCommands: check.length > 0 ? check.map((command) => ({ command, source: "pim" as const, from: ".pim/env.json" })) : profile.testCommands, services: config?.services ?? [], cachePaths: config?.cachePaths ?? [], notes });
		setup = await chooseSetup({ setting: io.setting, config, repository: () => repositorySetupScript(workspace, io.repoDir), configured: () => detectConfiguredSetup(workspaceFiles(workspace, io.repoDir)) });
		if (setup === null && plan.length === 0) {
			await keep({ state: "none", key: null, source: null, rebuildRequested: false, preparedAt: now(), error: undefined as never });
			return env;
		}
		key = await environmentKey({ ...owner, provision: plan.map((step) => step.script), setupScript: setup?.content ?? null, setupSource: setup?.source ?? null, unpinned: await unpinnedKeyParts(workspace, profile.toolchains, now(), io.repoDir), lockfiles: { ...(await lockfileHashes(workspace, io.repoDir)), ...cacheKeys.hashes }, image: io.image ?? "", pool: io.pool });
	} catch (error) {
		stop();
		return failed(null, environmentError("The environment's setup script couldn't be read", String(error instanceof Error ? error.message : error)));
	}
	const source = setup?.source ?? null;
	// A rebuild must not find the snapshot it asks to replace.
	if (o.rebuild && environments) await environments.delete(owner.userId, key).catch(() => false);
	await io.event("environment.started", { pool: io.pool, provider: io.compute.id, key, source, snapshots: environments !== undefined });
	let ws = workspace;
	// A new thread starts from the person's snapshot of this environment when they have one: its sandbox is replaced by one restored from it.
	if (!o.rebuild && environments) {
		const snapshot = await environments.list(owner).then((all) => all.find((each) => each.key === key), () => undefined);
		if (snapshot) {
			const started = now();
			if (await io.restore(snapshot.key)) {
				const cached = <T extends { status: string }>(item: T): T => (item.status === "pending" ? { ...item, status: "cached" } : item);
				await keep({ state: "cached", key, source, readyFrom: "snapshot", restoredFromKey: key, builtAt: snapshot.createdAt, restoreMs: now() - started, snapshotBytes: snapshot.size ?? null, preparedAt: now(), error: undefined as never, toolchains: env.toolchains.map(cached), dependencies: env.dependencies.map(cached) });
				await io.event("environment.step", stepRecord({ step: "restore", command: `restore the environment snapshot ${key.slice(0, 12)}`, outcome: "ok", exitCode: null, ms: now() - started, output: "" }));
				await io.event("environment.restored", { key });
				return env;
			}
			await io.event("environment.restore_failed", { key, error: "The snapshot couldn't be restored" });
			ws = await io.compute.workspace!(io.handle());
		}
	}
	// Built here: in this sandbox, which is then kept as the person's snapshot where the host keeps them and it is worth it.
	await keep({ state: "building", key, source, error: undefined as never });
	const started = now();
	const provisionFailures = await provision(io, ws, plan, env, keep, stop);
	const result = setup ? await runSetup(ws, setup.script, { cwd: io.repoDir, ...(io.signal ? { signal: io.signal } : {}) }) : null;
	if (setup && result && result.outcome !== "stopped") await io.event("environment.step", stepRecord({ step: "setup", command: setup.script.trim(), outcome: result.outcome, exitCode: result.exitCode, ms: result.ms, output: result.output, outputChars: result.outputChars }));
	const setupMs = now() - started;
	if (result?.outcome === "stopped") throw new EnvironmentStopped("Readying the environment was stopped: the thread was aborted");
	if (result?.outcome === "failed") {
		await keep({ setupMs });
		return failed(key, result.error);
	}
	const ready = { state: "cached", pool: io.pool, key, setupMs, readyFrom: "setup", rebuildRequested: false, error: undefined as never } as const;
	if (!environments || provisionFailures > 0 || (!o.rebuild && (await io.skipped(key)))) {
		await keep({ ...ready, builtAt: null, snapshotMs: null, snapshotBytes: null, snapshotKept: false, preparedAt: now() });
		await io.event("environment.built", { key, setupMs, snapshotKept: false, ...(provisionFailures > 0 ? { provisionFailures } : {}) });
		return env;
	}
	const snapshotStarted = now();
	try {
		// A snapshot must not hold the thread's git grant: it is taken without it, and the grant is written again.
		await (await io.compute.workspace!(io.handle())).remove(WORKSPACE_GIT_AUTH_DIR).catch(() => {});
		const snapshot = await environments.snapshot(io.handle(), { ...owner, key }).finally(() => io.refreshGit?.().catch(() => {}));
		const snapshotMs = now() - snapshotStarted;
		const worth = snapshotWorthKeeping(setupMs, snapshot.size ?? null, environments.restoreMBps);
		let kept = worth;
		if (!worth) {
			// The person's other snapshots of the repository are older environments of it, which don't pay either.
			const others = await environments.list(owner).then((all) => all.map((each) => each.key).filter((each) => each !== key), () => [] as string[]);
			for (const each of [key, ...others]) {
				const deleted = await environments.delete(owner.userId, each).then(() => true, () => false);
				if (each === key) kept = !deleted;
			}
		}
		await io.setSkipped(key, !worth).catch(() => {});
		await keep({ ...ready, builtAt: kept ? snapshot.createdAt : null, snapshotMs, snapshotBytes: snapshot.size ?? null, snapshotKept: kept, preparedAt: now() });
		await io.event("environment.built", { key, setupMs, snapshotKept: kept });
	} catch (error) {
		await keep({ setupMs });
		await failed(key, environmentError("The environment was set up but couldn't be kept", String(error instanceof Error ? error.message : error)));
	}
	return env;
}

/** Runs the provisioning steps one after another, recording how each went on the items it installs. A step that fails doesn't stop the others, but the dependencies that need a toolchain it was to install are skipped. Returns how many failed or were skipped. */
async function provision(io: EnvironmentIo, workspace: Awaited<ReturnType<NonNullable<ComputeProvider["workspace"]>>>, plan: readonly ProvisionStep[], start: CodingEnvironment, keep: (change: Partial<CodingEnvironment>) => Promise<void>, stop: () => void): Promise<number> {
	let env = start;
	const set = async (id: string, change: { status: "installed" | "failed" | "skipped"; error?: string }) => {
		const apply = <T extends { tool: string; status: string }>(item: T): T => (stepOf(item as never) === id ? { ...item, ...change } : item);
		env = { ...env, toolchains: env.toolchains.map(apply) as never, dependencies: env.dependencies.map(apply) as never };
		await keep({ toolchains: env.toolchains, dependencies: env.dependencies });
	};
	let failures = 0;
	const missing = new Set<string>();
	for (const step of plan) {
		if (step.needs.some((tool) => missing.has(tool))) {
			failures++;
			await set(step.id, { status: "skipped" });
			await io.event("environment.step", stepRecord({ step: "provision", command: step.script, outcome: "skipped", exitCode: null, ms: 0, output: "" }));
			continue;
		}
		const result = await runProvisionStep(workspace, step, { cwd: io.repoDir, env: SETUP_ENV, ...(io.signal ? { signal: io.signal } : {}) });
		if (result.outcome === "stopped") throw new EnvironmentStopped("Readying the environment was stopped: the thread was aborted");
		stop();
		await io.event("environment.step", stepRecord({ step: "provision", command: step.script, outcome: result.outcome, exitCode: result.exitCode, ms: result.ms, output: result.output, outputChars: result.outputChars }));
		if (result.outcome === "ok") {
			await set(step.id, { status: "installed" });
			continue;
		}
		failures++;
		const error = environmentError(`\`${step.script}\` ${result.how}`, result.output);
		for (const each of env.toolchains) if (stepOf(each as never) === step.id) missing.add(each.tool);
		await set(step.id, { status: "failed", error });
		await io.event("environment.provision_failed", { step: step.id, error });
	}
	return failures;
}
