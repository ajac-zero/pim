#!/usr/bin/env node
// The integrated load qualification: `node scripts/v2-bench/integrated.mjs [--profiles 5,50,500,1000] [--window 30] [--out file.json]` (see docs/v2-operations.md, Integrated qualification).
// It starts its own PostgreSQL 17 with durability ON (fsync, synchronous_commit), a 256 MB buffer cache and room for the Runners' pools, then runs the integrated test against it with
// the full profile list. The test itself starts NATS, the Gate, Live and the Runners. The result is written to packages/v2-server/bench-results/.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const root = resolve(fileURLToPath(import.meta.url), "../../..");
const profiles = arg("profiles", "5,50,500,1000");
const out = resolve(arg("out", join(root, "packages/v2-server/bench-results", `${new Date().toISOString().slice(0, 10)}-integrated-${profiles.replaceAll(",", "-")}.json`)));

const bin = ["/usr/lib/postgresql"].flatMap((r) => (existsSync(r) ? readdirSync(r).sort((a, b) => b - a).map((v) => join(r, v, "bin")) : [])).find((b) => existsSync(join(b, "initdb")));
if (!bin) throw new Error("No PostgreSQL: run packages/v2-runtime/scripts/ensure-postgres.sh");
const natsDir = join(homedir(), ".cache/pim-bench/nats-server-v2.10.22-linux-amd64");
const path = `${existsSync(natsDir) ? `${natsDir}:` : ""}${process.env.PATH}`;
if (spawnSync("nats-server", ["--version"], { env: { ...process.env, PATH: path } }).status !== 0) throw new Error("No nats-server: run scripts/v2-bench/install-nats.sh");

const port = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => r(port));
	});
});
const dir = mkdtempSync(join(tmpdir(), "pim-bench-pg-"));
spawnSync(join(bin, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], { stdio: "ignore" });
const settings = { fsync: "on", synchronous_commit: "on", full_page_writes: "on", shared_buffers: "256MB", max_connections: "800", wal_buffers: "16MB", max_wal_size: "2GB", checkpoint_timeout: "15min", track_wal_io_timing: "on" };
const flags = Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${v}`]).join(" ");
const started = spawnSync(join(bin, "pg_ctl"), ["-D", join(dir, "data"), "-w", "-l", join(dir, "log"), "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${dir} ${flags}`, "start"], { encoding: "utf8" });
if (started.status !== 0) throw new Error(`pg_ctl start failed: ${started.stdout}${started.stderr}`);
const stop = () => {
	spawnSync(join(bin, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
	rmSync(dir, { recursive: true, force: true });
};
let code = 1;
try {
	const child = spawn("pnpm", ["--filter", "@pim/v2-server", "exec", "vitest", "run", "test/integrated-bench.test.ts"], {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, PATH: path, PIM_V2_PG_URL: `postgres://postgres@127.0.0.1:${port}/postgres`, PIM_BENCH_PROFILES: profiles, PIM_BENCH_WINDOW_S: arg("window", "30"), PIM_BENCH_OUT: out, PIM_BENCH_FULL: "1" },
	});
	code = await new Promise((r) => child.on("exit", (c) => r(c ?? 1)));
} finally {
	stop();
}
console.log(existsSync(out) ? `results: ${out}` : "no results were written");
process.exit(code);
