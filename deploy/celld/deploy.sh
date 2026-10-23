#!/usr/bin/env bash
# Deploys a build from build.sh to the fleet bucket, with this Pim's variables and secrets. Running
# nodes adopt it in place within CELLD_DEPLOY_POLL_S (30 s by default); nothing restarts.
#
#   deploy/celld/deploy.sh BUILD --vars FILE [--secrets FILE] [--app-credentials-key FILE]
#                          [--celld-env FILE] [--dry-run]
#
#   BUILD                      a directory build.sh made
#   --vars FILE                this Pim's variables, such as PIM_PUBLIC_URL (env/pim.env.example)
#   --secrets FILE             its secrets, mode 600 (env/secrets.env.example)
#   --app-credentials-key FILE APP_CREDENTIALS_KEY, as gen-app-credentials-key.sh made it, mode 400
#   --celld-env FILE           the bucket settings the node uses too (env/celld.env.example);
#                              otherwise CELLD_BUCKET, S3_ENDPOINT, AWS_* from the environment
#   --dry-run                  check the files and bundle, write nothing
#
# celld v0.6.3 has no secret store: every variable, secrets too, is kept in this deployment's
# manifest in the fleet bucket (deploy/pim/<version>/manifest.json), which the bucket's
# credentials already control. The configuration with them in it exists only while this runs,
# mode 600, inside BUILD, and is deleted after. celld prints the names of the variables, never
# their values. See docs/celld.md, "Secrets".
set -euo pipefail

celld="${CELLD:-celld}"
fail() {
	echo "deploy.sh: $*" >&2
	exit 1
}

build="${1:-}"
[[ -n "$build" && "$build" != --* ]] || fail "usage: deploy.sh BUILD --vars FILE [--secrets FILE] [--app-credentials-key FILE] [--celld-env FILE] [--dry-run]"
shift
render_args=()
dry_run=()
while (($#)); do
	case "$1" in
	--vars | --secrets | --app-credentials-key)
		[[ -f "${2:-}" ]] || fail "$1 needs a file; ${2:-nothing} isn't one."
		render_args+=("$1" "$2")
		shift 2
		;;
	--celld-env)
		[[ -f "${2:-}" ]] || fail "$1 needs a file; ${2:-nothing} isn't one."
		set -a
		# shellcheck disable=SC1090
		source "$2"
		set +a
		shift 2
		;;
	--dry-run)
		dry_run=(--dry-run)
		shift
		;;
	*) fail "unknown option $1" ;;
	esac
done
[[ " ${render_args[*]} " == *" --vars "* ]] || fail "--vars is required: PIM_PUBLIC_URL at least."

[[ -f "$build/.pim-celld-build" && -f "$build/build-info.json" ]] || fail "$build isn't a finished build.sh build."
built_with="$(node -p 'require(process.argv[1]).toolchain.celld' "$build/build-info.json")"
have_celld="$("$celld" --version | sed -n 's/^celld //p')"
[[ "$have_celld" == "$built_with" ]] || fail "$build was built with celld $built_with; this is celld $have_celld."
((${#dry_run[@]})) || [[ -n "${CELLD_BUCKET:-}" ]] || fail "CELLD_BUCKET isn't set: pass --celld-env, or export the bucket settings."

umask 077
config="$build/.deploy-$$.jsonc"
trap 'rm -f "$config"' EXIT
trap 'exit 130' INT TERM
echo "Variables for this deployment (names only):"
# The build's own copy, so the variables are added as the commit that was built adds them.
node "$build/deploy/celld/scripts/render-config.mjs" --profile "$build/wrangler.celld.jsonc" --out "$config" "${render_args[@]}"

esbuild="$(cd "$build" && node -e 'const { createRequire } = require("node:module"); console.log(createRequire(require.resolve("wrangler/package.json")).resolve("esbuild/bin/esbuild"))')"
(cd "$build" && CELLD_ESBUILD="$esbuild" "$celld" deploy "$(basename "$config")" "${dry_run[@]}")
echo "Commit: $(node -p 'require(process.argv[1]).commit' "$build/build-info.json")"
