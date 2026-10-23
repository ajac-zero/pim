// Checks the celld profile against what celld v0.6.3 accepts and against wrangler.jsonc, and how
// render-config.mjs adds variables and secrets. No network, no celld binary:
//
//   node --test deploy/celld/test/config.check.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv, parseJsonc, readAppCredentialsKey, readIngressSecret, render } from "../scripts/render-config.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const profile = parseJsonc(read("../wrangler.jsonc"));
const wrangler = parseJsonc(read("../../../wrangler.jsonc"));

// celld v0.6.3, crates/celld/deploy.rs: SUPPORTED_KEYS, and the keys its `assets` block takes.
const CELLD_KEYS = ["$schema", "name", "main", "compatibility_date", "compatibility_flags", "durable_objects", "migrations", "assets", "services", "triggers", "vars", "d1_databases", "kv_namespaces", "queues", "workflows", "r2_buckets", "worker_loaders", "containers", "no_bundle", "define", "rules"];
const CELLD_ASSET_KEYS = ["directory", "binding", "html_handling", "not_found_handling", "run_worker_first"];
// What the profile leaves out of wrangler.jsonc, each explained at the top of the profile.
const LEFT_OUT = ["$schema", "workers_dev", "preview_urls", "build", "ai", "ratelimits", "keep_vars", "version_metadata", "observability"];

test("celld v0.6.3 accepts every key of the profile", () => {
	assert.deepEqual(Object.keys(profile).filter((key) => !CELLD_KEYS.includes(key)), []);
	assert.deepEqual(Object.keys(profile.assets).filter((key) => !CELLD_ASSET_KEYS.includes(key)), []);
	// `define` would put values into the bundle itself; nothing may.
	assert.equal(profile.define, undefined);
	assert.ok(profile.assets.run_worker_first.length <= 100);
});

test("the profile is wrangler.jsonc's Worker, less only what celld can't take", () => {
	assert.deepEqual(
		Object.keys(wrangler).filter((key) => !(key in profile)),
		LEFT_OUT.filter((key) => key in wrangler),
		"wrangler.jsonc gained or lost a key: decide what celld does with it, here and in the profile",
	);
	assert.equal(profile.main, "src/index.ts");
	for (const key of ["compatibility_date", "compatibility_flags", "durable_objects", "migrations", "assets"]) {
		assert.deepEqual(profile[key], wrangler[key], key);
	}
	const names = (list) => list.map((binding) => binding.binding);
	assert.deepEqual(names(profile.kv_namespaces), names(wrangler.kv_namespaces));
	assert.deepEqual(names(profile.r2_buckets), names(wrangler.r2_buckets));
	assert.ok(profile.kv_namespaces.every((binding) => binding.id));
	assert.ok(profile.r2_buckets.every((binding) => binding.bucket_name));
});

test("the profile's Durable Objects are the classes src/index.ts exports", () => {
	const exported = [...read("../../../src/index.ts").matchAll(/^export \{ (\w+) \}/gm)].map((match) => match[1]).sort();
	assert.deepEqual(profile.durable_objects.bindings.map((binding) => binding.class_name).sort(), exported);
	assert.deepEqual(profile.migrations.flatMap((migration) => migration.new_sqlite_classes).sort(), exported);
});

test("the committed examples hold no secret", () => {
	assert.equal(parseEnv(read("../env/secrets.env.example"), "secrets.env.example").size, 0);
	const vars = parseEnv(read("../env/pim.env.example"), "pim.env.example");
	assert.deepEqual([...vars.keys()], ["PIM_PUBLIC_URL"]);
	assert.doesNotThrow(() => render({ profile, vars, ingressSecret: INGRESS }));
	assert.doesNotMatch(read("../env/celld.env.example"), /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)=\S/m);
});

const KEY = Buffer.alloc(32, 7).toString("base64");
const INGRESS = "a".repeat(64);
const vars = new Map([["PIM_PUBLIC_URL", "https://pim.example.com"]]);

test("variables, secrets and the key all become vars, after the profile's defaults", () => {
	const secrets = new Map([["PIM_OIDC_CLIENT_SECRET", "s3cret"]]);
	const { config, sources } = render({ profile, vars: new Map([...vars, ["PIM_IMAGE_MODEL", "off"]]), secrets, ingressSecret: INGRESS, appCredentialsKey: KEY });
	assert.deepEqual(config.vars, {
		PIM_RUNTIME: "celld",
		PIM_UTILITY_MODEL: "off",
		PIM_IMAGE_MODEL: "off",
		PIM_PUBLIC_URL: "https://pim.example.com",
		PIM_OIDC_CLIENT_SECRET: "s3cret",
		PIM_INGRESS_SECRET: INGRESS,
		APP_CREDENTIALS_KEY: KEY,
	});
	assert.equal(sources.get("PIM_INGRESS_SECRET"), "ingress secret file");
	assert.equal(sources.get("PIM_IMAGE_MODEL"), "variables");
	assert.equal(sources.get("PIM_OIDC_CLIENT_SECRET"), "secrets");
	assert.equal(sources.get("APP_CREDENTIALS_KEY"), "key file");
	assert.deepEqual(profile.vars, { PIM_RUNTIME: "celld", PIM_UTILITY_MODEL: "off", PIM_IMAGE_MODEL: "off" }, "render changed the profile it was given");
});

test("render refuses what would misplace a secret or shadow a binding", () => {
	const refuses = (input, pattern) => assert.throws(() => render({ profile, vars, ingressSecret: INGRESS, ...input }), pattern);
	refuses({ vars: new Map([...vars, ["PIM_GITHUB_CLIENT_SECRET", "x"]]) }, /looks like a secret/);
	refuses({ vars: new Map([...vars, ["GOOGLE_DRIVE_API_KEY", "x"]]) }, /looks like a secret/);
	refuses({ secrets: new Map([["APP_CREDENTIALS_KEY", KEY]]) }, /only from its own file/);
	refuses({ secrets: new Map([["PIM_PUBLIC_URL", "https://other.example"]]) }, /both the variables and the secrets/);
	refuses({ secrets: new Map([["BLOBS", "x"]]) }, /name of a binding/);
	refuses({ secrets: new Map([["ASSETS", "x"]]) }, /name of a binding/);
	assert.throws(() => render({ profile, vars: new Map(), ingressSecret: INGRESS }), /PIM_PUBLIC_URL/);
});

test("Pim's celld runtime gets an ingress secret of its own, from its own file only", () => {
	const refuses = (input, pattern) => assert.throws(() => render({ profile, vars, ingressSecret: INGRESS, ...input }), pattern);
	refuses({ ingressSecret: null }, /PIM_INGRESS_SECRET isn't set/);
	refuses({ ingressSecret: KEY, appCredentialsKey: KEY }, /must differ from APP_CREDENTIALS_KEY/);
	refuses({ secrets: new Map([["PIM_INGRESS_SECRET", INGRESS]]) }, /only from its own file/);
	refuses({ vars: new Map([...vars, ["PIM_RUNTIME", "cloudflare"]]) }, /profile's to set/);
	refuses({ secrets: new Map([["PIM_RUNTIME", "cloudflare"]]) }, /profile's to set/);
	assert.equal(readIngressSecret(`PIM_INGRESS_SECRET=${INGRESS}\n`, "f"), INGRESS);
	assert.equal(readIngressSecret(`PIM_INGRESS_SECRET=${"~!".repeat(16)}\n`, "f"), "~!".repeat(16));
	for (const bad of [`PIM_INGRESS_SECRET=${"a".repeat(31)}`, `PIM_INGRESS_SECRET=${"a".repeat(31)} b`, `PIM_INGRESS_SECRET=${"é".repeat(40)}`, `OTHER=${INGRESS}`, `PIM_INGRESS_SECRET=${INGRESS}\nPIM_X=1`]) {
		assert.throws(() => readIngressSecret(bad, "f"), /at least 32 visible ASCII/, bad);
	}
});

test("env files and the key file are read strictly", () => {
	assert.deepEqual([...parseEnv('# c\n\nA=1\nB="two=2"\nC=\'x y\'\r\n', "f")], [["A", "1"], ["B", "two=2"], ["C", "x y"]]);
	assert.throws(() => parseEnv("A=1\nA=2\n", "f"), /f:2: A is set twice/);
	assert.throws(() => parseEnv("A=\n", "f"), /empty/);
	assert.throws(() => parseEnv("export A=1\n", "f"), /expected NAME=value|upper-case/);
	assert.throws(() => parseEnv("lower=1\n", "f"), /upper-case/);
	assert.equal(readAppCredentialsKey(`${KEY}\n`, "k"), KEY);
	assert.throws(() => readAppCredentialsKey(Buffer.alloc(16).toString("base64"), "k"), /32 random bytes/);
	assert.throws(() => readAppCredentialsKey(`${KEY}\nPIM_X=1`, "k"), /32 random bytes/);
});

test("the command line refuses secrets others can read, and writes a config only its owner can", () => {
	const dir = mkdtempSync(join(tmpdir(), "pim-render-"));
	try {
		const script = new URL("../scripts/render-config.mjs", import.meta.url).pathname;
		const file = (name, text, mode) => {
			writeFileSync(join(dir, name), text);
			chmodSync(join(dir, name), mode);
			return join(dir, name);
		};
		const args = ["--profile", new URL("../wrangler.jsonc", import.meta.url).pathname, "--vars", file("pim.env", "PIM_PUBLIC_URL=https://pim.example.com\n", 0o644)];
		const run = (extra) => execFileSync("node", [script, ...args, ...extra], { encoding: "utf8", stdio: "pipe" });
		const secrets = file("secrets.env", "PIM_OIDC_CLIENT_SECRET=hush-1234\n", 0o640);
		assert.throws(() => run(["--secrets", secrets, "--out", join(dir, "a.json")]), /can be read by others/);
		chmodSync(secrets, 0o600);
		const key = file("key", `${KEY}\n`, 0o444);
		assert.throws(() => run(["--secrets", secrets, "--app-credentials-key", key, "--out", join(dir, "b.json")]), /can be read by others/);
		chmodSync(key, 0o400);
		const out = join(dir, "c.json");
		const ingress = file("ingress.env", `PIM_INGRESS_SECRET=${INGRESS}\n`, 0o644);
		assert.throws(() => run(["--secrets", secrets, "--app-credentials-key", key, "--ingress-secret", ingress, "--out", join(dir, "d.json")]), /can be read by others/);
		chmodSync(ingress, 0o400);
		const { status, stdout, stderr } = spawnSync("node", [script, ...args, "--secrets", secrets, "--app-credentials-key", key, "--ingress-secret", ingress, "--out", out], { encoding: "utf8" });
		assert.equal(status, 0, stderr);
		const printed = stdout + stderr;
		assert.match(printed, /PIM_OIDC_CLIENT_SECRET\s+secrets/);
		assert.equal(statSync(out).mode & 0o777, 0o600);
		const config = JSON.parse(readFileSync(out, "utf8"));
		assert.equal(config.vars.PIM_OIDC_CLIENT_SECRET, "hush-1234");
		assert.equal(config.vars.APP_CREDENTIALS_KEY, KEY);
		assert.equal(config.vars.PIM_INGRESS_SECRET, INGRESS);
		assert.ok(!printed.includes("hush-1234") && !printed.includes(KEY) && !printed.includes(INGRESS));
		// Never over an existing file.
		assert.throws(() => run(["--secrets", secrets, "--ingress-secret", ingress, "--out", out]), /EEXIST/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
