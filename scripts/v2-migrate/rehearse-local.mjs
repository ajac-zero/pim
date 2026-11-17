#!/usr/bin/env node
// Rehearses the whole v1 -> v2 cutover, end to end, on this machine, against a real v1 Worker (the preview, `wrangler dev`) instead of a synthetic snapshot:
//
//   v1        start the v1 preview on a fresh state, fill it through its real API (populate-v1.mjs), and take a digest of what it serves
//   fence     stop it, then run the inert fence Worker (packages/v2-ops/src/fence-worker) on the SAME Durable Object, R2 and KV state
//   export    run.mjs export through the fence Worker's authenticated routes
//   import    migrate every SQL band, run.mjs import (with its audit), then promote into the live schemas
//   serve     start NATS, an S3 server and the Gate, Live and Runner as separate processes on role logins (or use --public-url for an existing stack)
//   verify    verify-v2.mjs: sign in with the old passkey and token, and check every item of the space through the new stack's API
//   rollback  stop the new stack and the fence Worker, start v1 again on the same state, and show that it serves the same data and still fires what fell due
//
// Usage: node scripts/v2-migrate/rehearse-local.mjs [phase ...|all] --database-url postgres://superuser@127.0.0.1:5432/postgres [options]
//   --database-url   a PostgreSQL server where the rehearsal may create (and first drop) the database named by --database, and the NOLOGIN/LOGIN roles it needs
//   --database       database name (default pim_rehearsal)
//   --work           working directory (default /tmp/pim-rehearsal): v1 state, snapshot, objects, reports, logs, expectations
//   --public-url     verify (and only verify) an existing stack, such as the Docker Compose one, instead of starting a local one; add --ingress-secret if its proxy needs it
//   --probe-seconds  a schedule that falls due while the fence is up (default 100); the rollback shows whether v1 fires it after being unfenced
//   --keep           leave the processes running at the end
// Needs: PIM_NATS_BIN (or nats-server on the PATH), and the node_modules of this checkout (wrangler, tsx, s3rver). Nothing here touches Cloudflare, a live host or any cloud.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "../../packages/v2-server/node_modules/pg/lib/index.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		"database-url": { type: "string" },
		database: { type: "string", default: "pim_rehearsal" },
		work: { type: "string", default: "/tmp/pim-rehearsal" },
		"public-url": { type: "string" },
		"ingress-secret": { type: "string", default: "" },
		"probe-seconds": { type: "string", default: "100" },
		"v1-port": { type: "string", default: "8791" },
		"fence-port": { type: "string", default: "8792" },
		keep: { type: "boolean", default: false },
	},
});
const ALL = ["v1", "fence", "export", "import", "serve", "verify", "rollback"];
const phases = positionals.length === 0 || positionals.includes("all") ? ALL : positionals;
const WORK = resolve(values.work);
const dir = (name) => (mkdirSync(join(WORK, name), { recursive: true }), join(WORK, name));
mkdirSync(WORK, { recursive: true });
const log = (...a) => console.log(`\n[rehearse] ${a.join(" ")}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FENCE_TOKEN = "rehearsal-fence-token-" + createHash("sha256").update(WORK).digest("hex").slice(0, 24);
const V1 = `http://localhost:${values["v1-port"]}`;
const FENCE = `http://127.0.0.1:${values["fence-port"]}`;
const expectFile = join(WORK, "v1-expectations.json");
const stateFile = join(WORK, "rehearsal-state.json");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));

// ---- child processes ----
const children = new Map();
function start(name, command, args, { cwd = REPO, env = {} } = {}) {
	const out = createWriteStream(join(dir("logs"), `${name}.log`), { flags: "a" });
	const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
	child.stdout.pipe(out);
	child.stderr.pipe(out);
	child.on("exit", () => children.delete(name));
	children.set(name, child);
	return child;
}
function stop(name) {
	const child = children.get(name);
	if (!child) return Promise.resolve();
	return new Promise((done) => {
		child.once("exit", () => done());
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			done();
		}
		setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
			done();
		}, 8000).unref();
	});
}
const stopAll = () => Promise.all([...children.keys()].map(stop));
process.on("SIGINT", async () => (await stopAll(), process.exit(130)));
async function waitFor(url, what, ms = 120_000, ok = (r) => r.status < 500) {
	const deadline = Date.now() + ms;
	for (;;) {
		try {
			if (ok(await fetch(url))) return;
		} catch {}
		if (Date.now() > deadline) throw new Error(`${what} did not come up at ${url}; see ${join(WORK, "logs")}`);
		await sleep(500);
	}
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); s.on("error", rej); });
function run(label, command, args, { cwd = REPO, env = {} } = {}) {
	const r = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 1 << 28 });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	writeFileSync(join(dir("logs"), `${label}.log`), out);
	if (r.status !== 0) throw new Error(`${label} failed (${r.status}): ${out.split("\n").slice(-12).join("\n")}`);
	return out;
}
const jsonc = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));

// ---- the legacy Worker and the fence Worker, on one state directory ----
const stateDir = () => join(WORK, "v1-state");
function v1Config() {
	const preview = jsonc(join(REPO, "wrangler.preview.jsonc"));
	delete preview.build; // the web app is already built; the rehearsal must not rebuild it
	preview.main = join(REPO, "preview/worker.ts");
	preview.assets = { ...preview.assets, directory: join(REPO, "web/dist") };
	preview.dev = { ip: "127.0.0.1", port: Number(values["v1-port"]) };
	const origin = V1;
	preview.vars = { ...preview.vars, PIM_PUBLIC_URL: origin, PIM_CONTENT_ORIGIN: `http://127.0.0.1:${values["v1-port"]}`, PIM_APPS_ORIGIN: `http://apps.localhost:${values["v1-port"]}` };
	const file = join(dir("v1"), "wrangler.json");
	writeFileSync(file, JSON.stringify(preview, null, 2));
	return file;
}
function fenceConfig() {
	// The production config's classes, bindings and migrations (so nothing is deleted), under the preview's name, buckets and namespace so it opens the same state.
	const prod = jsonc(join(REPO, "wrangler.jsonc"));
	const preview = jsonc(join(REPO, "wrangler.preview.jsonc"));
	const config = {};
	for (const [k, v] of Object.entries(prod)) if (!["assets", "ai", "build", "ratelimits", "previews", "send_email", "$schema", "triggers", "routes", "route", "containers"].includes(k)) config[k] = structuredClone(v);
	Object.assign(config, { name: preview.name, main: join(REPO, "packages/v2-ops/src/fence-worker/index.ts"), workers_dev: false, vars: {}, r2_buckets: preview.r2_buckets, kv_namespaces: preview.kv_namespaces.filter((k) => k.binding === "OAUTH_KV"), version_metadata: preview.version_metadata });
	const d = dir("fence");
	writeFileSync(join(d, "wrangler.json"), JSON.stringify(config, null, 2));
	writeFileSync(join(d, ".dev.vars"), `FENCE_EXPORT_TOKEN=${FENCE_TOKEN}\n`, { mode: 0o600 });
	return join(d, "wrangler.json");
}
const wrangler = (name, config, port) => start(name, "pnpm", ["exec", "wrangler", "dev", "--local", "-c", config, "--persist-to", stateDir(), "--ip", "127.0.0.1", "--port", String(port)]);

/** What a person sees through the legacy API, as one hash per area, leaving out what the fence probe adds. */
async function digestV1() {
	const expect = JSON.parse(readFileSync(expectFile, "utf8"));
	const out = {};
	for (const [who, token] of Object.entries(expect.tokens)) {
		const get = async (p) => (await fetch(`${V1}/api${p}`, { headers: { authorization: `Bearer ${token}` } })).json();
		const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
		const sessions = (await get("/sessions")).sessions.filter((s) => s.title !== "Fence probe");
		const messages = {};
		for (const s of sessions.sort((a, b) => (a.id < b.id ? -1 : 1))) messages[s.id] = (await get(`/sessions/${s.id}/messages`)).messages.map((m) => [m.id, m.role, JSON.stringify(m.parts)]);
		out[who] = {
			sessions: hash(sessions.map((s) => [s.id, s.title])),
			messages: hash(messages),
			agents: hash((await get("/agents")).agents.map((a) => [a.id, a.name, a.instructions, a.skills])),
			skills: hash((await get("/skills")).skills.map((s) => [s.name, s.version])),
			memory: hash((await get("/memory/log")).entries.map((m) => [m.id, m.text])),
			goals: hash((await get("/goals")).goals.map((g) => [g.id, g.title, g.steps])),
			artifacts: hash((await get("/artifacts")).artifacts.map((a) => [a.id, a.title, a.versions])),
			approvals: hash((await get("/approvals?status=pending")).approvals.map((a) => a.id)),
			schedules: hash((await get("/schedules")).schedules.filter((s) => s.label !== "Fence probe").map((s) => [s.id, s.label, s.next])),
		};
	}
	return out;
}

// ---- phases ----
async function phaseV1() {
	log("v1: a fresh preview, filled through its real API");
	rmSync(stateDir(), { recursive: true, force: true });
	wrangler("v1", v1Config(), values["v1-port"]);
	await waitFor(`${V1}/health`, "the v1 preview");
	run("populate", "node", ["scripts/v2-migrate/populate-v1.mjs", "--base", V1, "--expect", expectFile, "--probe-seconds", values["probe-seconds"]]);
	state.populatedAt = Date.now();
	state.digestBefore = await digestV1();
	save();
	console.log(`  populated; digest of what v1 serves: ${JSON.stringify(state.digestBefore.ada)}`);
}

async function phaseFence() {
	log("fence: stop v1, run the inert fence Worker on the same state");
	await stop("v1");
	await sleep(1500);
	wrangler("fence", fenceConfig(), values["fence-port"]);
	await waitFor(`${FENCE}/api/account`, "the fence Worker", 120_000, (r) => r.status === 503);
	const denied = await fetch(`${FENCE}/fence/v1/version`);
	const allowed = await fetch(`${FENCE}/fence/v1/version`, { headers: { authorization: `Bearer ${FENCE_TOKEN}` } });
	if (denied.status !== 503 || allowed.status !== 200) throw new Error(`the fence Worker's export routes: without token ${denied.status}, with token ${allowed.status}`);
	state.fencedAt = Date.now();
	save();
	console.log("  every ordinary path answers 503 Maintenance; the export routes answer only with the token");
}

async function phaseExport() {
	log("export: through the fence Worker's read-only routes");
	rmSync(join(WORK, "snapshot"), { recursive: true, force: true });
	const out = run("export", "node", ["scripts/v2-migrate/run.mjs", "export", "--url", FENCE, "--out", join(WORK, "snapshot"), "--cutover-at", new Date().toISOString()], { env: { FENCE_EXPORT_TOKEN: FENCE_TOKEN } });
	console.log(out.split("\n").filter((l) => /rows|Exported/.test(l)).map((l) => `  ${l}`).join("\n"));
	state.exportedAt = Date.now();
	save();
}

const keysFile = () => join(WORK, "keys.env");
function keyEnv() {
	if (!existsSync(keysFile())) writeFileSync(keysFile(), `PIM_KEK_CURRENT=k1\nPIM_KEK_k1=${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
	return Object.fromEntries(readFileSync(keysFile(), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
const dbUrl = (name, user) => {
	const u = new URL(values["database-url"]);
	u.pathname = `/${name}`;
	if (user) u.username = user;
	return u.toString();
};
const need = (v, n) => { if (!v) throw new Error(`${n} is required`); return v; };


/** An S3-protocol server (s3rver) as a child process: the import and promote steps block this process while they run, so it cannot serve from inside it. */
async function startS3() {
	if (children.has("s3")) return state.s3Endpoint;
	const port = await freePort();
	const code = `const S3rver = require("s3rver"); new S3rver({ port: ${port}, address: "127.0.0.1", silent: true, directory: ${JSON.stringify(dir("s3"))}, configureBuckets: [{ name: "pim", configs: [] }] }).run().then(() => console.log("up"))`;
	start("s3", "node", ["-e", code], { cwd: join(REPO, "packages/v2-server") });
	await waitFor(`http://127.0.0.1:${port}/`, "the S3 server", 30_000);
	state.s3Endpoint = `http://127.0.0.1:${port}`;
	save();
	return state.s3Endpoint;
}

async function phaseImport() {
	need(values["database-url"], "--database-url");
	log(`import: migrate every SQL band into ${values.database}, import the snapshot with its audit, promote into the live schemas`);
	const root = new pg.Client({ connectionString: dbUrl("postgres") });
	await root.connect();
	await root.query(`DROP DATABASE IF EXISTS ${values.database} WITH (FORCE)`);
	await root.query(`CREATE DATABASE ${values.database}`);
	await root.end();
	const owner = dbUrl(values.database);
	const keys = keyEnv();
	const s3 = await startS3();
	const env = { ...keys, PIM_DATABASE_URL: owner, PIM_S3_ENDPOINT: s3, PIM_S3_BUCKET: "pim", PIM_S3_ACCESS_KEY: "S3RVER", PIM_S3_SECRET_KEY: "S3RVER" };
	const server = join(REPO, "packages/v2-server");
	run("migrate", "node", ["--import", "tsx", "src/main.ts", "migrate"], { cwd: server, env });
	rmSync(join(WORK, "objects"), { recursive: true, force: true });
	const imported = run("import", "node", ["scripts/v2-migrate/run.mjs", "import", "--snapshot", join(WORK, "snapshot"), "--database-url", owner, "--objects-dir", join(WORK, "objects"), "--cutover-id", "cut-rehearsal", "--report", dir("report"), "--legacy-rp-id", "localhost", "--new-rp-id", "localhost"], { env: keys });
	console.log(`  ${imported.trim().split("\n").at(-1)}`);
	const manifest = JSON.parse(readFileSync(join(WORK, "snapshot/manifest.json"), "utf8"));
	const expect = existsSync(expectFile) ? JSON.parse(readFileSync(expectFile, "utf8")) : null;
	const model = values["default-model"] ?? (expect?.providers?.[0] ? `${expect.providers[0].id}/rehearsal-model` : "");
	const promoted = run("promote", "node", ["--import", "tsx", "src/main.ts", "promote"], { cwd: server, env: { ...env, PIM_RP_ID: "localhost", PIM_CUTOVER_AT: String(manifest.cutoverAt), PIM_LEGACY_OBJECTS_DIR: join(WORK, "objects"), ...(model ? { PIM_DEFAULT_MODEL: model } : {}) } });
	const report = JSON.parse(promoted.split("\n").find((l) => l.includes("pim.promote")));
	console.log(`  promoted: ${JSON.stringify({ chats: report.chats, messages: report.messages, orphanedTasks: report.orphanedTasks, clearedRuns: report.clearedRuns, ...report.domain })}`);
	if (report.skipped.length) console.log(`  skipped (reported, never faked): ${report.skipped.join("; ")}`);
	state.promote = report;
	state.databaseUrl = owner;
	save();
}

async function phaseServe() {
	need(values["database-url"], "--database-url");
	log("serve: NATS, S3, and Gate, Live and Runner as separate processes on role logins");
	const keys = keyEnv();
	const admin = new pg.Client({ connectionString: dbUrl(values.database) });
	await admin.connect();
	for (const kind of ["gate", "runtime", "live", "forge", "maintenance"]) {
		await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rh_${kind}_login') THEN CREATE ROLE rh_${kind}_login LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
		await admin.query(`GRANT pim_${kind} TO rh_${kind}_login`);
	}
	await admin.end();
	const s3 = await startS3();
	const natsPort = await freePort();
	start("nats", process.env.PIM_NATS_BIN ?? "nats-server", ["-a", "127.0.0.1", "-p", String(natsPort)]);
	await sleep(1000);
	const gatePort = await freePort();
	const url = `http://localhost:${gatePort}`;
	const common = { ...keys, PIM_PUBLIC_URL: url, PIM_NATS_URL: `127.0.0.1:${natsPort}`, PIM_S3_ENDPOINT: s3, PIM_S3_BUCKET: "pim", PIM_S3_ACCESS_KEY: "S3RVER", PIM_S3_SECRET_KEY: "S3RVER", PIM_INGRESS_SECRET: "rehearsal-ingress", PIM_METRICS_PORT: "0", PIM_DRAIN_WINDOW_SECONDS: "2" };
	const server = join(REPO, "packages/v2-server");
	const role = (name, login, port, extra = {}) => start(name, "node", ["--import", "tsx", "src/main.ts", name], { cwd: server, env: { ...common, PIM_HTTP_PORT: String(port), PIM_DATABASE_URL: dbUrl(values.database, `rh_${login}_login`), ...extra } });
	role("gate", "gate", gatePort);
	role("live", "live", await freePort());
	role("runner", "runtime", await freePort(), { PIM_APP_DATABASE_URL: dbUrl(values.database, "rh_gate_login"), PIM_FORGE_DATABASE_URL: dbUrl(values.database, "rh_forge_login") });
	await waitFor(`${url}/readyz`, "the Gate", 120_000, (r) => r.status === 200);
	state.publicUrl = url;
	state.ingressSecret = "rehearsal-ingress";
	save();
	console.log(`  the new stack answers at ${url}`);
}

async function phaseVerify() {
	log("verify: through the new stack's API, as the people who used the old one");
	const url = values["public-url"] ?? need(state.publicUrl, "a started stack (run the serve phase, or pass --public-url)");
	const args = ["scripts/v2-migrate/verify-v2.mjs", "--public-url", url, "--expect", expectFile, "--ingress-secret", values["public-url"] ? values["ingress-secret"] : state.ingressSecret];
	if (state.databaseUrl && !values["public-url"]) args.push("--database-url", state.databaseUrl);
	const r = spawnSync("node", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	writeFileSync(join(dir("report"), "verify.log"), r.stdout + r.stderr);
	console.log(r.stdout.split("\n").map((l) => `  ${l}`).join("\n"));
	if (r.status !== 0) throw new Error(`verification failed; ${r.stderr.slice(-400)}`);
}

async function phaseRollback() {
	log("rollback: stop the new stack and the fence, start v1 again on the same state; nothing is deleted");
	for (const name of ["runner", "live", "gate", "nats"]) await stop(name);
	await stop("fence");
	await sleep(1500);
	wrangler("v1", v1Config(), values["v1-port"]);
	await waitFor(`${V1}/health`, "the v1 preview, unfenced");
	const after = await digestV1();
	const same = JSON.stringify(after) === JSON.stringify(state.digestBefore);
	console.log(`  v1 is back and serves the same data as before the fence: ${same ? "YES" : "NO"}`);
	if (!same) console.log(`  before ${JSON.stringify(state.digestBefore)}\n  after  ${JSON.stringify(after)}`);
	const expect = JSON.parse(readFileSync(expectFile, "utf8"));
	// The probe was due while the fence consumed the alarms. Does the unfenced Worker fire it without anyone calling it?
	const wait = Math.max(0, expect.probe.dueAt + 90_000 - Date.now());
	console.log(`  waiting up to ${Math.round(wait / 1000)}s for the schedule that fell due during the fence`);
	let fired = false;
	const token = expect.tokens.ada;
	const quiet = Date.now() + wait;
	// An unfenced Worker with no traffic has nothing to wake it, so first look without touching it, then after one ordinary request.
	for (let touched = false; !fired && Date.now() < quiet + 1; ) {
		await sleep(5000);
		const sessions = (await (await fetch(`${V1}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).json()).sessions;
		fired = sessions.some((s) => s.title === "Fence probe");
		if (!fired && !touched && Date.now() > expect.probe.dueAt + 10_000) {
			touched = true;
			state.probeFiredWithoutTraffic = false;
			console.log("  not fired by itself 10s after it was due; making one ordinary request");
		} else if (fired && !touched) state.probeFiredWithoutTraffic = true;
	}
	state.probeFiredAfterUnfence = fired;
	state.rollbackSameData = same;
	save();
	console.log(`  the schedule that fell due during the fence ${fired ? `fired after the unfence${state.probeFiredWithoutTraffic ? " by itself" : ""}` : "did NOT fire within the wait"}`);
	const keep = values["public-url"] ? "" : "";
	void keep;
	if (!same) throw new Error("rollback did not give back the same data");
}

try {
	for (const phase of phases) {
		if (!ALL.includes(phase)) throw new Error(`unknown phase ${phase}; one of ${ALL.join(", ")}`);
		await { v1: phaseV1, fence: phaseFence, export: phaseExport, import: phaseImport, serve: phaseServe, verify: phaseVerify, rollback: phaseRollback }[phase]();
	}
	log(`done: ${phases.join(" > ")}. Logs and reports are in ${WORK}`);
} catch (error) {
	console.error(`\n[rehearse] FAILED: ${error.message}`);
	process.exitCode = 1;
} finally {
	if (!values.keep) {
		await stopAll();
	} else console.log("[rehearse] --keep: processes left running");
	process.exit(process.exitCode ?? 0);
}
