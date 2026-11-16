#!/usr/bin/env node
// Writes (or with --check, verifies) packages/v2-ops/src/fence-worker/wrangler.jsonc from the root wrangler.jsonc.
import { readFileSync, writeFileSync } from "node:fs";
import { FENCE_CONFIG_HEADER, fenceConfig, parseJsonc } from "../../packages/v2-ops/src/fence-worker/config.ts";

const legacy = parseJsonc(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));
const target = new URL("../../packages/v2-ops/src/fence-worker/wrangler.jsonc", import.meta.url);
const text = FENCE_CONFIG_HEADER + JSON.stringify(fenceConfig(legacy, { relativeRoot: "../../../..", main: "./index.ts" }), null, "\t") + "\n";
if (process.argv.includes("--check")) {
	if (readFileSync(target, "utf8") !== text) {
		console.error("The fence Worker's wrangler.jsonc is out of date: run node scripts/v2-migrate/fence-config.mjs");
		process.exit(1);
	}
} else writeFileSync(target, text);
