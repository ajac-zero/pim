import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import S3rver from "s3rver";
import { startProcess, type Process } from "../../src/main.ts";
import type { Hooks } from "../../src/roles.ts";
import { freePort, type Nats, type Stack } from "./stack.ts";

export type S3 = { endpoint: string; stop(): Promise<void> };

/** An S3-protocol server (s3rver) with the bucket the processes use. */
export async function startS3(): Promise<S3> {
	const dir = mkdtempSync(join(tmpdir(), "pim-srv-s3-"));
	const port = await freePort();
	const server = new S3rver({ port, address: "127.0.0.1", silent: true, directory: dir, configureBuckets: [{ name: "pim", configs: [] }] });
	await server.run();
	return { endpoint: `http://127.0.0.1:${port}`, async stop() { await server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export type Deployment = { stack: Stack; nats: Nats; s3: S3; gatePort: number; ingressSecret: string };

/** The environment one process of a role gets, as `deploy/compose` gives it: its own database login, and the shared NATS, S3 and public address. */
export function envFor(d: Deployment, role: "gate" | "live" | "runner" | "forge" | "maintenance" | "all-in-one", extra: Record<string, string> = {}): Record<string, string> {
	const login = role === "runner" ? "runtime" : role === "all-in-one" ? "super" : role;
	return {
		PIM_PUBLIC_URL: `http://127.0.0.1:${d.gatePort}`,
		PIM_DATABASE_URL: d.stack.url(login),
		PIM_NATS_URL: d.nats.url,
		PIM_S3_ENDPOINT: d.s3.endpoint,
		PIM_S3_BUCKET: "pim",
		PIM_S3_ACCESS_KEY: "S3RVER",
		PIM_S3_SECRET_KEY: "S3RVER",
		PIM_INGRESS_SECRET: d.ingressSecret,
		PIM_HTTP_PORT: role === "gate" ? String(d.gatePort) : "0",
		PIM_METRICS_PORT: "0",
		PIM_DRAIN_WINDOW_SECONDS: "1",
		// One test person polls the Gate far faster than a person does; the API rate limit has its own test (limits-providers.test.ts).
		PIM_RATE_API: "1000000",
		// A deployment's default is that the person's majordomo answers approvals; these tests answer them by hand, and the ones about the majordomo's review choose that policy themselves.
		PIM_APPROVAL_POLICY: "explicit",
		// The memory nap and the memory tree's summaries ask the model in the background, which would take the scripted answers meant for a test's turns; memory-nap.test.ts turns them on.
		PIM_MEMORY_NAP: "off",
		...extra,
	};
}

export const start = (d: Deployment, role: Parameters<typeof envFor>[1], hooks: Hooks = {}, extra: Record<string, string> = {}): Promise<Process> => startProcess(role, envFor(d, role, extra), hooks);

export const base = (p: Process) => `http://127.0.0.1:${p.host.port}`;
