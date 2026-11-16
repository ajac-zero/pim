// A load pass over the integrated product, not a synthetic writer: real Gate, Live and Runner processes, real PostgreSQL (non-superuser roles), NATS, and a streaming scripted model.
// N people each start one streaming turn at once; the test measures what a person feels (the Gate answering 202, the time until the answer is projected and readable) and what a
// person feels meanwhile (the sidebar snapshot of someone else's chat list), and fails only on a collapse (a turn that never lands, or a foreground read that stalls).
// Numbers vary with the machine; the run prints them, and PIM_BENCH_OUT names a file to write them to. PIM_BENCH_PROFILES lists the sizes (default 5,50).
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type HarnessOptions } from "@earendil-works/pi-durable";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import type { Process } from "../src/main.ts";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const PROFILES = (process.env.PIM_BENCH_PROFILES ?? "5,50").split(",").map(Number);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
const ms = (n: number) => Math.round(n);

real("the integrated Gate, Runner, Projector and Live under concurrent streaming turns", () => {
	let d: Deployment;
	let gate: Process;
	const procs: Process[] = [];
	let app: App;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }], tokensPerSecond: 25, tokenSize: { min: 2, max: 3 } });
	const results: Record<string, unknown>[] = [];
	const ANSWER = "This is a streamed answer of a fair length, so that it commits several partial messages as it is written.";

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		app = new App(connectApp(stack.url("gate"), 8), new MemoryObjectStore());
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = { model: { provider: "faux", modelId: "m" } };
		const hooks = { harnessOptions: (): HarnessOptions => ({ models, registry: createRegistry(), settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1_000 } } as never }), homeRoot: () => ({ agent }), chatAgent: () => agent, pollMs: 40 };
		gate = await start(d, "gate", {}, { PIM_POOL_FOREGROUND_MAX: "20" });
		procs.push(gate, await start(d, "live", { pollMs: 40 }), await start(d, "runner", hooks, { PIM_RUNNER_HOLDER_ID: "bench-1", PIM_POOL_RUNTIME_MAX: "20" }), await start(d, "runner", hooks, { PIM_RUNNER_HOLDER_ID: "bench-2", PIM_POOL_RUNTIME_MAX: "20" }));
	}, 180_000);
	afterAll(async () => {
		if (process.env.PIM_BENCH_OUT) writeFileSync(process.env.PIM_BENCH_OUT, `${JSON.stringify(results, null, 2)}\n`);
		await Promise.allSettled(procs.map((p) => p.close()));
		await app?.db.end();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	const sessions: { token: string; ownerId: string }[] = [];
	async function person(i: number) {
		const existing = sessions[i];
		if (existing) return existing;
		await openRegistration();
		const account = await app.identity.register({ username: `bench${i}` });
		const token = await app.identity.createSession(account.ownerId);
		return (sessions[i] = { token, ownerId: account.ownerId });
	}
	let opened: Promise<void> | undefined;
	const openRegistration = () => (opened ??= bootstrapAdmin().then((a) => app.identity.setRegistrationOpen(a.principal, true)));
	let admin: { principal: never } | undefined;
	async function bootstrapAdmin() {
		if (admin) return admin;
		const account = await app.identity.register({ username: "root", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		const token = await app.identity.createSession(account.ownerId);
		return (admin = { principal: { kind: "user", ownerId: account.ownerId, role: "admin", sessionId: token } as never });
	}
	const call = async (token: string, method: string, path: string, body?: unknown) => {
		const t0 = performance.now();
		const res = await fetch(base(gate) + path, { method, headers: { authorization: `Bearer ${token}`, "x-pim-ingress-secret": d.ingressSecret, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
		const json = (await res.json()) as any;
		return { status: res.status, json, ms: performance.now() - t0 };
	};

	for (const n of PROFILES) {
		it(`${n} people each stream one turn at once`, async () => {
			faux.setResponses(Array.from({ length: n + 5 }, () => fauxAssistantMessage(ANSWER)));
			const people = await Promise.all(Array.from({ length: n }, (_, i) => person(i + 1)));
			const chats = await Promise.all(people.map(async (p) => (await call(p.token, "POST", "/api/sessions", { title: "bench" })).json.id as string));
			// The foreground: someone else's sidebar and session list, read continuously through the load.
			const watcher = people[0]!;
			const reads: number[] = [];
			let loading = true;
			const probes = Array.from({ length: 4 }, (_, k) =>
				(async () => {
					while (loading) {
						reads.push((await call(watcher.token, "GET", k % 2 ? "/api/sessions" : "/api/snapshot/sidebar")).ms);
						await new Promise((r) => setTimeout(r, 40));
					}
				})(),
			);
			const sent = new Map<string, number>();
			const t0 = performance.now();
			const admissions = await Promise.all(
				people.map(async (p, i) => {
					sent.set(chats[i]!, performance.now());
					const r = await call(p.token, "POST", `/api/sessions/${chats[i]}/messages`, { commandId: `bench-${n}-${i}`, text: `hello ${i}` });
					expect(r.status).toBe(202);
					return r.ms;
				}),
			);
			// When each answer is readable: sampled from the projection every 50 ms.
			const landed = new Map<string, number>();
			let maxLag = 0;
			await waitFor(`${n} answers to be projected`, async () => {
				const rows = (await d.stack.admin.query("SELECT DISTINCT chat_id FROM pim_projection.chat_transcript_projection WHERE message->>'role' = 'assistant' AND NOT partial AND chat_id = ANY($1)", [chats])).rows;
				const at = performance.now();
				for (const r of rows) if (!landed.has(r.chat_id)) landed.set(r.chat_id, at);
				const lag = (await d.stack.admin.query("SELECT coalesce(sum(p.next_seq - 1 - w.projected_seq), 0)::int AS lag FROM pim_runtime.partitions p JOIN pim_projection.projection_watermarks w ON w.partition_id = p.partition_id")).rows[0].lag;
				maxLag = Math.max(maxLag, lag);
				return landed.size === n ? true : undefined;
			}, 240_000);
			const total = performance.now() - t0;
			loading = false;
			await Promise.all(probes);
			const e2e = chats.map((c) => landed.get(c)! - sent.get(c)!);
			const commits = Number((await d.stack.admin.query("SELECT count(*) n FROM pim_runtime.commit_receipts")).rows[0].n);
			const row = {
				people: n,
				admission_ms: { p50: ms(pct(admissions, 50)), p95: ms(pct(admissions, 95)), max: ms(Math.max(...admissions)) },
				answer_readable_ms: { p50: ms(pct(e2e, 50)), p95: ms(pct(e2e, 95)), max: ms(Math.max(...e2e)) },
				foreground_read_ms: { reads: reads.length, p50: ms(pct(reads, 50)), p95: ms(pct(reads, 95)), max: ms(Math.max(...reads)) },
				max_projection_lag_commits: maxLag,
				total_s: Math.round(total / 100) / 10,
				runtime_commits_total: commits,
				cpus: (await import("node:os")).cpus().length,
			};
			results.push(row);
			console.log("BENCH", JSON.stringify(row));
			// A collapse, not a target: every turn landed, the Gate kept admitting, and a foreground read never stalled.
			expect(admissions.every((a) => a < 5_000)).toBe(true);
			expect(Math.max(...reads)).toBeLessThan(10_000);
		}, 300_000);
	}
});
