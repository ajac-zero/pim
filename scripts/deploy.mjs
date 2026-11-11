// `pnpm run deploy`: wrangler deploy, with the coding workspace image's account filled in at deploy time.
// wrangler.jsonc names the image as registry.cloudflare.com/<account>/<repository>@sha256:<digest>, and wrangler
// accepts only that form, so the repository keeps a placeholder account and the real one never enters git.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PLACEHOLDER = "00000000000000000000000000000000";
const config = new URL("../wrangler.jsonc", import.meta.url);
const text = readFileSync(config, "utf8");
if (text.includes(PLACEHOLDER)) {
	let account = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!account) {
		const who = spawnSync("pnpm", ["exec", "wrangler", "whoami", "--json"], { encoding: "utf8" });
		const ids = [...new Set((who.stdout ?? "").match(/\b[0-9a-f]{32}\b/g) ?? [])];
		if (ids.length === 1) account = ids[0];
		else console.error(`deploy: cannot tell the Cloudflare account (${ids.length} candidates); set CLOUDFLARE_ACCOUNT_ID`);
	}
	if (!account || !/^[0-9a-f]{32}$/.test(account)) process.exit(1);
	writeFileSync(config, text.replaceAll(PLACEHOLDER, account));
}
process.exit(spawnSync("pnpm", ["exec", "wrangler", "deploy", ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);
