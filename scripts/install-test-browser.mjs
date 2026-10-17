#!/usr/bin/env node
// Downloads the Chrome that wrangler and the tests use in place of Browser Run, into wrangler's
// cache, where wrangler looks for it. Wrangler would download it itself, but on Node 26 its unzip
// leaves the browser out, and a test would spend its time on 160 MB. Run by CI and .agents/setup;
// needs curl and unzip.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const miniflare = readFileSync(require.resolve("miniflare", { paths: [require.resolve("wrangler")] }), "utf8");
const version = miniflare.match(/BROWSER_VERSION = "([\d.]+)"/)?.[1];
if (!version) throw new Error("Couldn't find which Chrome miniflare uses.");

// Chrome for Testing's name for the platform, and @puppeteer/browsers' (wrangler's cache layout).
const [download, cached] =
	platform() === "linux" ? ["linux64", "linux"] : platform() === "darwin" ? (arch() === "arm64" ? ["mac-arm64", "mac_arm"] : ["mac-x64", "mac"]) : [];
if (!download) throw new Error(`No Chrome for Testing download for ${platform()} here; wrangler downloads its own.`);

const cache = process.env.XDG_CACHE_HOME ?? (platform() === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"));
const dir = join(cache, ".wrangler", "chrome", `${cached}-${version}`);
const executable = download === "linux64" ? join(dir, "chrome-linux64", "chrome") : join(dir, `chrome-${download}`, "Google Chrome for Testing.app");
if (existsSync(executable)) {
	console.log(`Chrome ${version} is already in ${dir}.`);
	process.exit(0);
}

const zip = join(tmpdir(), `chrome-${download}-${version}.zip`);
execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--output", zip, `https://storage.googleapis.com/chrome-for-testing-public/${version}/${download}/chrome-${download}.zip`], { stdio: "inherit" });
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
execFileSync("unzip", ["-q", zip, "-d", dir], { stdio: "inherit" });
rmSync(zip);
// Wrangler's sign that the browser has started from here before, so it never clears it as broken.
writeFileSync(join(dir, ".miniflare-install-complete"), "");
console.log(`Chrome ${version} is in ${dir}.`);
