#!/usr/bin/env node
// The development preview of the v2 stack, for working on Pim inside an orb or on a laptop without Docker (`amp orb services ensure` runs it: .amp/services.yaml).
//
// It starts, from what is installed on the machine: a private PostgreSQL cluster (the repository's `packages/v2-runtime/scripts/ensure-postgres.sh` installs the binaries),
// nats-server, an S3 server (s3rver, in this process), the stand-in model (scripts/v2-compose/fake-model.mjs), one Pim process that runs every role (`all-in-one`: the API, no web app),
// the web host (web-host/) serving the built web app, and a small front door on $PORT (8787) that sends each path to one or the other as Caddy does (web-host/src/routes.js). State is
// kept in .wrangler/state-v2-dev: delete that directory for a fresh Pim. The web app is built when it is missing or older than web/src; the web host publishes it as a release when it starts,
// so after rebuilding web/dist, `amp orb service restart preview` (or just restarting the web host) is a frontend-only release that leaves the backend process running.
//
// Signing in: `PIM_DEV_SIGN_IN=1` turns on GET /__dev/sign-in/<username>?returnTo=/path (&bot=<id> makes a new account a guest of that bot). It makes the account when it is new, the
// first being the admin, and sets the session cookie. The stand-in model echoes each message through send_to_user; `/tool <name> {json}` makes it call that tool.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { connect, createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBackendPath } from "../../web-host/src/routes.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const state = join(root, ".wrangler", "state-v2-dev");
const port = Number(process.env.PORT ?? 8787);
const ports = { pg: Number(process.env.PIM_DEV_PG_PORT ?? 54329), nats: Number(process.env.PIM_DEV_NATS_PORT ?? 54222), s3: Number(process.env.PIM_DEV_S3_PORT ?? 54333), model: Number(process.env.PIM_DEV_MODEL_PORT ?? 54900), backend: Number(process.env.PIM_DEV_BACKEND_PORT ?? 54800), web: Number(process.env.PIM_DEV_WEB_PORT ?? 54801) };
const log = (...args) => console.log("[v2-dev]", ...args);
const children = [];
const require = createRequire(join(root, "packages", "v2-server", "package.json"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pgBin() {
	const base = "/usr/lib/postgresql";
	const versions = existsSync(base) ? readdirSync(base).sort((a, b) => Number(b) - Number(a)) : [];
	for (const v of versions) if (existsSync(join(base, v, "bin", "initdb"))) return join(base, v, "bin");
	throw new Error("No PostgreSQL found. Run packages/v2-runtime/scripts/ensure-postgres.sh");
}
const up = (p) => new Promise((resolve) => {
	const socket = createServer().once("error", () => resolve(true)).once("listening", function () { this.close(() => resolve(false)); });
	socket.listen(p, "127.0.0.1");
});
const waitFor = async (what, probe, tries = 600) => {
	for (let i = 0; i < tries; i++) {
		if (await probe().catch(() => false)) return;
		await sleep(100);
	}
	throw new Error(`${what} did not come up`);
};
const run = (name, command, args, env = {}, cwd = root) => {
	const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
	child.on("exit", (code, signal) => {
		if (!stopping) {
			log(`${name} exited (${signal ?? code}); stopping`);
			stop(1);
		}
	});
	children.push(child);
	return child;
};

let stopping = false;
let pgDir;
function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
	if (pgDir) spawnSync(join(pgBin(), "pg_ctl"), ["-D", pgDir, "-m", "fast", "stop"], { stdio: "ignore" });
	setTimeout(() => process.exit(code), 500);
}
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());

mkdirSync(state, { recursive: true });

// ---- PostgreSQL: a private cluster, trust auth on the loopback ----
pgDir = join(state, "pg");
const bin = pgBin();
if (!existsSync(join(pgDir, "PG_VERSION"))) {
	log("making the database cluster");
	execFileSync(join(bin, "initdb"), ["-D", pgDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], { stdio: "ignore" });
}
if (spawnSync(join(bin, "pg_ctl"), ["-D", pgDir, "status"], { stdio: "ignore" }).status !== 0) {
	const started = spawnSync(join(bin, "pg_ctl"), ["-D", pgDir, "-w", "-l", join(state, "pg.log"), "-o", `-p ${ports.pg} -k ${state} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=300 -c unix_socket_directories=${state}`, "start"], { encoding: "utf8" });
	if (started.status !== 0) throw new Error(`pg_ctl start failed: ${started.stdout}${started.stderr}`);
}
const pg = require("pg");
const url = (user, db = "pim") => `postgres://${user}@127.0.0.1:${ports.pg}/${db}`;
{
	const root_ = new pg.Client({ connectionString: url("postgres", "postgres") });
	await root_.connect();
	if (!(await root_.query("SELECT 1 FROM pg_database WHERE datname = 'pim'")).rowCount) await root_.query("CREATE DATABASE pim");
	await root_.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_login') THEN CREATE ROLE dev_login LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$");
	await root_.end();
}
// Every band, by the real migrator, then one login that holds every process role (row-level security still applies to it).
{
	const { migrateAll } = await import(pathToFileURL(join(root, "packages", "v2-server", "src", "migrate.ts")).href);
	const pool = new pg.Pool({ connectionString: url("postgres"), max: 2 });
	const applied = await migrateAll(pool);
	if (applied.length) log(`applied ${applied.length} migrations`);
	await pool.query("GRANT pim_gate, pim_runtime, pim_live, pim_forge, pim_maintenance TO dev_login");
	await pool.end();
}

// ---- NATS, S3, the stand-in model ----
if (await up(ports.nats)) log("nats is already up");
else run("nats-server", "nats-server", ["-a", "127.0.0.1", "-p", String(ports.nats)]);
{
	const S3rver = require(join(root, "packages", "v2-app", "node_modules", "s3rver"));
	const directory = join(state, "s3");
	mkdirSync(directory, { recursive: true });
	await new S3rver({ port: ports.s3, address: "127.0.0.1", silent: true, directory, configureBuckets: [{ name: "pim", configs: [] }] }).run();
}
run("fake-model", process.execPath, [join(root, "scripts", "v2-compose", "fake-model.mjs")], { PORT: String(ports.model) });

// ---- the web app ----
const dist = join(root, "web", "dist");
const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((latest, e) => Math.max(latest, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0);
if (!existsSync(join(dist, "index.html")) || newest(join(root, "web", "src")) > statSync(join(dist, "index.html")).mtimeMs) {
	log("building the web app");
	execFileSync("pnpm", ["--filter", "pim-web", "build"], { cwd: root, stdio: "inherit" });
}

// ---- Pim ----
const kekFile = join(state, "kek");
if (!existsSync(kekFile)) writeFileSync(kekFile, randomBytes(32).toString("base64"), { mode: 0o600 });
const dev = url("dev_login");
const env = {
	PIM_ROLE: "all-in-one",
	PIM_PUBLIC_URL: process.env.PIM_PUBLIC_URL ?? `http://localhost:${port}`,
	PIM_DATABASE_URL: dev,
	PIM_APP_DATABASE_URL: dev,
	PIM_FORGE_DATABASE_URL: dev,
	PIM_NATS_URL: `127.0.0.1:${ports.nats}`,
	PIM_S3_ENDPOINT: `http://127.0.0.1:${ports.s3}`,
	PIM_S3_BUCKET: "pim",
	PIM_S3_ACCESS_KEY: "S3RVER",
	PIM_S3_SECRET_KEY: "S3RVER",
	PIM_HTTP_PORT: String(ports.backend),
	PIM_METRICS_PORT: "0",
	PIM_KEK_CURRENT: "dev",
	PIM_KEK_dev: readFileSync(kekFile, "utf8").trim(),
	PIM_DEV_SIGN_IN: "1",
	PIM_AI_GATEWAY_URL: `http://127.0.0.1:${ports.model}/v1`,
	PIM_AI_GATEWAY_KEY: "none",
	PIM_AI_GATEWAY_MODELS: "fake-1",
	PIM_DEFAULT_MODEL: "gateway/fake-1",
	// One person signing in as several accounts from one address, and a page that polls, are what development does.
	PIM_REGISTRATIONS_PER_ADDRESS: "1000",
	PIM_RATE_AUTH: "100000",
	PIM_RATE_API: "1000000",
	PIM_RATE_PUBLIC: "100000",
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PIM_"))),
};
run("pim", process.execPath, ["--import", "tsx", "src/main.ts", "all-in-one"], env, join(root, "packages", "v2-server"));
// The web host is its own process and may be replaced alone, as a web image is in a deployment: when it exits it is started again with the build in `state/web-source` (a directory) if
// that file exists, else web/dist, and nothing else is restarted. Stopping it (`kill <pid>`; the pid is in state/web.pid) is therefore a frontend-only release.
const webSource = () => (existsSync(join(state, "web-source")) ? readFileSync(join(state, "web-source"), "utf8").trim() : dist);
function startWeb() {
	const child = spawn(process.execPath, [join(root, "web-host", "src", "main.js")], { cwd: root, env: { ...process.env, PIM_HTTP_PORT: String(ports.web), PIM_WEB_SOURCE: webSource(), PIM_WEB_RELEASES: join(state, "web-releases") }, stdio: ["ignore", "inherit", "inherit"] });
	writeFileSync(join(state, "web.pid"), String(child.pid));
	children.push(child);
	child.on("exit", () => {
		children.splice(children.indexOf(child), 1);
		if (!stopping) startWeb();
	});
}
startWeb();
await waitFor("Pim", async () => (await fetch(`http://127.0.0.1:${ports.backend}/health`)).ok, 1200);
await waitFor("the web host", async () => (await fetch(`http://127.0.0.1:${ports.web}/readyz`)).ok, 600);

// ---- the front door: what Caddy is in a deployment ----
const upstream = (url) => (isBackendPath(new URL(url ?? "/", "http://front").pathname) ? ports.backend : ports.web);
const front = http.createServer((req, res) => {
	const proxied = http.request({ host: "127.0.0.1", port: upstream(req.url), method: req.method, path: req.url, headers: req.headers }, (answer) => {
		res.writeHead(answer.statusCode ?? 502, answer.headers);
		answer.pipe(res);
	});
	proxied.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
	req.pipe(proxied);
});
front.on("upgrade", (req, socket, head) => {
	const target = connect(upstream(req.url), "127.0.0.1", () => {
		let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
		for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
		target.write(`${raw}\r\n`);
		target.write(head);
		socket.pipe(target).pipe(socket);
	});
	target.on("error", () => socket.destroy());
	socket.on("error", () => target.destroy());
});
await new Promise((resolve) => front.listen(port, "0.0.0.0", resolve));
log(`Pim is up on http://localhost:${port}. Sign in: http://localhost:${port}/__dev/sign-in/ada?returnTo=/ (the first account is the admin)`);
await new Promise(() => {});
