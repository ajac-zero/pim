// build.sh deletes OUT before it builds there again. These run build.sh with OUTs it must refuse,
// each holding a sentinel file (and build.sh's own marker, where that could fool it), and check
// it refused for the right reason and the sentinel is still there. No build runs: build.sh checks
// OUT before its toolchain, and CELLD points nowhere, so an OUT it accepts stops there instead.
//
//   node --test deploy/celld/test/build-paths.check.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const build = new URL("../build.sh", import.meta.url).pathname;
const repo = realpathSync(new URL("../../..", import.meta.url).pathname);
const root = realpathSync(mkdtempSync(join(tmpdir(), "pim-build-paths-")));
const home = join(root, "home", "operator");
mkdirSync(home, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

/** A directory with a sentinel in it and, unless told otherwise, build.sh's marker. */
function place(dir, { marker = true } = {}) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "sentinel"), "keep me");
	if (marker) writeFileSync(join(dir, ".pim-celld-build"), "");
	return join(dir, "sentinel");
}

function run(out) {
	const result = spawnSync("bash", [build, "HEAD", out], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, CELLD: "/nonexistent/celld" } });
	return { status: result.status, stderr: result.stderr };
}

function refuses(out, pattern, sentinel) {
	const { status, stderr } = run(out);
	assert.equal(status, 1, stderr);
	assert.match(stderr, pattern);
	if (sentinel) assert.ok(existsSync(sentinel), `build.sh deleted ${sentinel}`);
}

test("a symbolic link, even to an earlier build, with or without a trailing slash", () => {
	const target = join(root, "builds", "real");
	const sentinel = place(target);
	symlinkSync(target, join(root, "builds", "link"));
	refuses(join(root, "builds", "link"), /is a symbolic link/, sentinel);
	refuses(`${join(root, "builds", "link")}/`, /is a symbolic link/, sentinel);
});

test("the home directory, and anything above it, even with the marker", () => {
	const sentinel = place(home);
	refuses(home, /home directory or above it/, sentinel);
	refuses(dirname(home), /home directory or above it/);
	refuses(`${home}/../operator`, /home directory or above it/, sentinel);
});

test("the repository, anything in it, and anything above it", () => {
	refuses(repo, /in or above this repository/);
	refuses(join(repo, "deploy"), /in or above this repository/);
	refuses(dirname(repo), /in or above this repository/);
});

test("/ and top-level directories", () => {
	refuses("/", /top-level directory/);
	refuses("/tmp", /top-level directory/);
	refuses("/tmp/../usr", /top-level directory/);
});

test("a directory that isn't a build, or whose marker is a symbolic link", () => {
	refuses(join(root, "not-a-build"), /exists and isn't a build/, place(join(root, "not-a-build"), { marker: false }));
	const fake = join(root, "fake-marker");
	const sentinel = place(fake, { marker: false });
	symlinkSync(join(root, "builds", "real", ".pim-celld-build"), join(fake, ".pim-celld-build"));
	refuses(fake, /exists and isn't a build/, sentinel);
});

test("an earlier build is accepted, and left alone until the toolchain checks pass", () => {
	const sentinel = place(join(root, "builds", "earlier"));
	refuses(join(root, "builds", "earlier"), /celld is missing|this commit builds with/, sentinel);
});
