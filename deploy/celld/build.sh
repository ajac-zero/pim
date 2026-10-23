#!/usr/bin/env bash
# Builds Pim for celld from one commit, the same way every time: the commit's files (git archive,
# so nothing uncommitted or ignored gets in), its lockfile, the Node.js major in its .nvmrc, the
# pnpm in its package.json, the celld in its deploy/celld/versions.env, and the esbuild Wrangler
# uses from its lockfile. The web app is built explicitly first, in an environment with nothing of
# the operator's in it, so no stray VITE_* variable or secret can end up in the files it serves.
#
#   deploy/celld/build.sh [REF] [OUT]
#     REF  the commit to build (default HEAD)
#     OUT  where (default ~/.cache/pim-celld/builds/<commit>); replaced if it is an earlier build
#
# Needs git, node, pnpm and celld (on PATH, or CELLD=/path/to/celld). Touches no bucket and no
# secret: deploy.sh deploys what it leaves. OUT/build-info.json records what went in, and the
# deployment version celld gives the build before any variable is added, which a second build of
# the same commit must reproduce.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
ref="${1:-HEAD}"
commit="$(git -C "$repo" rev-parse --verify "$ref^{commit}")"
out="${2:-${XDG_CACHE_HOME:-$HOME/.cache}/pim-celld/builds/$commit}"
celld="${CELLD:-celld}"

fail() {
	echo "build.sh: $*" >&2
	exit 1
}

git -C "$repo" cat-file -e "$commit:deploy/celld/wrangler.jsonc" 2>/dev/null || fail "$commit has no deploy/celld/wrangler.jsonc, so it has no celld build."

# The toolchain the commit asks for.
want_node="$(git -C "$repo" show "$commit:.nvmrc" | tr -d '[:space:]')"
want_pnpm="$(git -C "$repo" show "$commit:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).packageManager.split("@")[1]))')"
want_celld="$(git -C "$repo" show "$commit:deploy/celld/versions.env" | sed -n 's/^CELLD_VERSION=v//p')"
have_node="$(node -p 'process.versions.node.split(".")[0]')"
have_pnpm="$(pnpm --version)"
have_celld="$("$celld" --version 2>/dev/null | sed -n 's/^celld //p')" || true
[[ "$have_node" == "$want_node" ]] || fail "this commit builds with Node.js $want_node (.nvmrc); this is Node.js $have_node."
[[ "$have_pnpm" == "$want_pnpm" ]] || fail "this commit builds with pnpm $want_pnpm (package.json); this is pnpm $have_pnpm."
[[ "$have_celld" == "$want_celld" ]] || fail "this commit builds with celld $want_celld (deploy/celld/versions.env); $celld is ${have_celld:-missing}. Run deploy/celld/install-celld.sh."

if [[ -e "$out" ]]; then
	[[ -f "$out/.pim-celld-build" ]] || fail "$out exists and isn't a build; choose another OUT."
	rm -rf "$out"
fi
mkdir -p "$out"
git -C "$repo" archive --format=tar "$commit" | tar -x -C "$out"
touch "$out/.pim-celld-build"

# Only what the tools need: no VITE_*, no NODE_OPTIONS, no credentials. Commit time as the build's
# time, for any tool that stamps one.
clean_env=(env -i "HOME=$HOME" "PATH=$PATH" "LANG=C.UTF-8" "TZ=UTC" "CI=true"
	"SOURCE_DATE_EPOCH=$(git -C "$repo" show -s --format=%ct "$commit")")
[[ -z "${XDG_CACHE_HOME:-}" ]] || clean_env+=("XDG_CACHE_HOME=$XDG_CACHE_HOME")
[[ -z "${XDG_DATA_HOME:-}" ]] || clean_env+=("XDG_DATA_HOME=$XDG_DATA_HOME")

echo "Installing $commit's dependencies from its lockfile..."
(cd "$out" && "${clean_env[@]}" pnpm install --frozen-lockfile --prefer-offline --reporter=silent)
echo "Building the web app..."
(cd "$out" && "${clean_env[@]}" pnpm --filter pim-web build >"$out/web-build.log" 2>&1) || {
	tail -40 "$out/web-build.log" >&2
	fail "the web app's build failed; its log is $out/web-build.log."
}
[[ -f "$out/web/dist/index.html" ]] || fail "the web app's build left no web/dist/index.html."

cp "$out/deploy/celld/wrangler.jsonc" "$out/wrangler.celld.jsonc"
esbuild="$(cd "$out" && node -e 'const { createRequire } = require("node:module"); console.log(createRequire(require.resolve("wrangler/package.json")).resolve("esbuild/bin/esbuild"))')"
echo "Bundling the Worker with celld $have_celld and esbuild $("$esbuild" --version)..."
dry_run="$(cd "$out" && CELLD_ESBUILD="$esbuild" "$celld" deploy wrangler.celld.jsonc --dry-run --json 2>"$out/celld-dry-run.log" | tail -1)" || {
	cat "$out/celld-dry-run.log" >&2
	fail "celld refused the build; see above."
}

# One hash over every file the web app serves, by path, so two builds compare in one line.
web_dist="$(cd "$out/web/dist" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
node -e '
const [commit, node, pnpm, celld, esbuild, webDist, dryRun] = process.argv.slice(1);
const info = {
	commit,
	toolchain: { node, pnpm, celld, esbuild },
	webDistSha256: webDist,
	// The version celld gives this build before deploy.sh adds any variable.
	profileVersion: JSON.parse(dryRun).version,
};
require("node:fs").writeFileSync(process.argv[8], JSON.stringify(info, null, 2) + "\n");
' "$commit" "$(node --version)" "$have_pnpm" "$have_celld" "$("$esbuild" --version)" "$web_dist" "$dry_run" "$out/build-info.json"
cat "$out/build-info.json"
echo "Built $commit in $out. Deploy it with deploy/celld/deploy.sh $out."
