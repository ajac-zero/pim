#!/usr/bin/env node
// The integrated benchmark on the real v2 stack (packages/v2-server/test/integrated-bench.test.ts): real Gate, Live, Runner and Projector over real PostgreSQL 17 and nats-server.
//   node scripts/v2-bench/integrated.mjs --profile 5 --profile 50 --profile 500 --profile 1000 [--out packages/v2-server/bench-results/<name>.json]
// It starts its own PostgreSQL from the embedded-postgres binaries with durability ON (fsync, full_page_writes, synchronous_commit; the test default cluster has fsync off), a
// trust-authenticated cluster the test's per-role logins connect to, sized for the load (max_connections 1000, shared_buffers 256 MB, I/O timing on), and finds nats-server (PIM_NATS_BIN or
// scripts/v2-bench/install-nats.sh). One profile per run, so each starts from a fresh database.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { profile: { type: "string", multiple: true, default: ["5", "50"] }, out: { type: "string" }, idle: { type: "string", default: "3" } } });
const root = new URL("../../", import.meta.url).pathname;

const pgBin = (() => {
	const store = join(root, "node_modules/.pnpm");
	const dir = readdirSync(store).find((d) => d.startsWith("@embedded-postgres+linux-x64@17"));
	if (!dir) throw new Error("no embedded PostgreSQL 17 (run pnpm install)");
	return join(store, dir, "node_modules/@embedded-postgres/linux-x64/native/bin");
})();
const natsDir = process.env.PIM_NATS_BIN ? null : join(process.env.HOME, ".cache/pim-bench");
const natsBin = process.env.PIM_NATS_BIN ?? join(natsDir, readdirSync(natsDir).find((d) => d.startsWith("nats-server-v")), "nats-server");
if (!existsSync(natsBin)) throw new Error("no nats-server: run scripts/v2-bench/install-nats.sh");
const shim = mkdtempSync(join(tmpdir(), "pim-bench-bin-"));
execFileSync("ln", ["-s", natsBin, join(shim, "nats-server")]);

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let code = 0;
for (const profile of values.profile) {
	const dir = mkdtempSync(join(tmpdir(), "pim-bench-pg-"));
	const port = await freePort();
	execFileSync(join(pgBin, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], { stdio: "ignore" });
	const started = spawnSync(join(pgBin, "pg_ctl"), ["-D", join(dir, "data"), "-w", "-l", join(dir, "log"), "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=on -c full_page_writes=on -c synchronous_commit=on -c max_connections=1000 -c shared_buffers=256MB -c track_io_timing=on -c track_wal_io_timing=on -c wal_buffers=16MB -c max_wal_size=2GB -c checkpoint_timeout=15min -c unix_socket_directories=${dir}`, "start"], { encoding: "utf8" });
	if (started.status !== 0) throw new Error(`pg_ctl start failed: ${started.stdout}${started.stderr}`);
	const out = values.out && values.profile.length === 1 ? values.out : values.out?.replace(/\.json$/, `-${profile}.json`);
	console.log(`--- integrated profile ${profile}`);
	const run = spawnSync("pnpm", ["--filter", "@pim/v2-server", "exec", "vitest", "run", "test/integrated-bench.test.ts"], {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, PIM_V2_PG_URL: `postgres://postgres@127.0.0.1:${port}/postgres`, PIM_BENCH_PROFILES: profile, PIM_BENCH_ROUNDS: Number(profile) <= 50 ? "8" : "1", PIM_BENCH_IDLE_CHATS: values.idle, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PIM_BENCH_") && !["PIM_BENCH_PROFILES", "PIM_BENCH_OUT"].includes(k))), ...(out ? { PIM_BENCH_OUT: out } : {}), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim() },
	});
	if (run.status !== 0) code = 1;
	spawnSync(join(pgBin, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
	rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
