#!/usr/bin/env bash
# A disposable, single-node Pim on celld, end to end, on this machine: build.sh from a commit,
# deploy.sh with made-up variables and secrets, a celld node, the Caddyfile in front of it, and
# smoke.mjs through it. Then a graceful restart, a check of where the secrets ended up in the
# bucket, and a cold backup restored into an empty prefix and started on a fresh node.
#
#   deploy/celld/test/run-scratch.sh [REF]       REF defaults to HEAD
#
# The commit must have Pim's celld runtime (PIM_RUNTIME=celld); ALLOW_PRE_RUNTIME=1 runs an earlier
# one to test the tooling alone, without the ingress checks.
#
# Needs celld (pinned; CELLD=...), moto_server (`uv tool install 'moto[server]==5.1.14'`) as a
# throwaway S3 that unsigned requests reach, and network for Caddy unless CADDY is set. Nothing it
# makes is real: the bucket is moto's memory, the secrets are random canaries, the model is
# mock-model.mjs, and everything is deleted at the end unless KEEP=1. It costs nothing and
# reaches no third party.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
celld_dir="$(dirname "$here")"
# shellcheck source=../versions.env
source "$celld_dir/versions.env"
ref="${1:-HEAD}"
celld="${CELLD:-celld}"
scratch="$(mktemp -d /tmp/pim-celld-scratch.XXXXXX)"
pids=()
cleanup() {
	for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
	wait 2>/dev/null || true
	if [[ "${KEEP:-0}" == 1 || "${failed:-0}" == 1 ]]; then echo "Kept $scratch"; else rm -rf "$scratch"; fi
}
trap cleanup EXIT
trap 'failed=1' ERR
say() { printf '\n== %s\n' "$*"; }
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
wait_for() { # URL [STATUS]
	for _ in $(seq 1 300); do
		[[ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" == "${2:-200}" ]] && return 0
		sleep 0.2
	done
	echo "$1 never answered ${2:-200}" >&2
	return 1
}

say "Toolchain"
"$celld" --version | grep -qx "celld ${CELLD_VERSION#v}" || { echo "Need celld $CELLD_VERSION; $celld is $("$celld" --version 2>&1 || true)." >&2; exit 1; }
echo "celld: $(command -v "$celld") ($("$celld" --version))"
if [[ -z "${CADDY:-}" ]]; then
	arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
	pin_var="CADDY_SHA256_linux_$arch"
	curl -fsSL -o "$scratch/caddy.tgz" "https://github.com/caddyserver/caddy/releases/download/$CADDY_VERSION/caddy_${CADDY_VERSION#v}_linux_$arch.tar.gz"
	echo "${!pin_var}  $scratch/caddy.tgz" | sha256sum -c --quiet
	mkdir -p "$scratch/bin"
	tar -xzf "$scratch/caddy.tgz" -C "$scratch/bin" caddy
	CADDY="$scratch/bin/caddy"
fi
echo "caddy: $("$CADDY" version | cut -d' ' -f1)"
command -v moto_server >/dev/null || { echo "Need moto_server: uv tool install 'moto[server]==5.1.14'" >&2; exit 1; }

say "Build $ref"
"$celld_dir/build.sh" "$ref" "$scratch/build" | tail -12
build="$scratch/build"
runtime="$(node -p 'require(process.argv[1]).celldRuntime ? 1 : 0' "$build/build-info.json")"
if [[ "$runtime" != 1 ]]; then
	[[ "${ALLOW_PRE_RUNTIME:-0}" == 1 ]] || { echo "$ref predates Pim's celld runtime; ALLOW_PRE_RUNTIME=1 tests the tooling alone." >&2; exit 1; }
	echo "This commit predates Pim's celld runtime: the ingress checks are skipped."
	export PIM_CELLD_ALLOW_PRE_RUNTIME=1
fi

s3_port="$(free_port)"
moto_server -H 127.0.0.1 -p "$s3_port" >"$scratch/s3.log" 2>&1 &
pids+=($!)
export S3_ENDPOINT="http://127.0.0.1:$s3_port"
wait_for "$S3_ENDPOINT/"
node "$here/scratch-bucket.mjs" create pim-scratch
node "$here/scratch-bucket.mjs" create pim-scratch-restore

celld_port="$(free_port)"
internal_port="$(free_port)"
proxy_port="$(free_port)"
model_port="$(free_port)"
pim_url="https://pim.localhost:$proxy_port"
mkdir -p "$scratch/etc"
(umask 077 && cat >"$scratch/etc/celld.env") <<EOF
CELLD_BUCKET=s3://pim-scratch/pim
S3_ENDPOINT=$S3_ENDPOINT
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=scratch
AWS_SECRET_ACCESS_KEY=scratch
CELLD_ADDR=127.0.0.1:$celld_port
CELLD_INTERNAL_ADDR=127.0.0.1:$internal_port
CELLD_TRUST_FORWARDED_HEADERS=1
CELLD_DURABILITY=bucket
CELLD_WATCH=$scratch/state
CELLD_ASSET_CACHE_DIR=$scratch/assets
EOF
echo "PIM_PUBLIC_URL=$pim_url" >"$scratch/etc/pim.env"
canary="canary-$(openssl rand -hex 12)"
(umask 077 && echo "SPOTIFY_CLIENT_SECRET=$canary" >"$scratch/etc/secrets.env")
"$celld_dir/gen-app-credentials-key.sh" "$scratch/etc/app-credentials-key"
app_key="$(cat "$scratch/etc/app-credentials-key")"
"$celld_dir/gen-ingress-secret.sh" "$scratch/etc/ingress.env"
ingress_secret="$(sed -n 's/^PIM_INGRESS_SECRET=//p' "$scratch/etc/ingress.env")"

say "Deploy"
CELLD="$celld" "$celld_dir/deploy.sh" "$build" --vars "$scratch/etc/pim.env" --secrets "$scratch/etc/secrets.env" \
	--app-credentials-key "$scratch/etc/app-credentials-key" --ingress-secret "$scratch/etc/ingress.env" \
	--celld-env "$scratch/etc/celld.env" 2>&1 | tee "$scratch/deploy.log"
if grep -qF -e "$canary" -e "$app_key" -e "$ingress_secret" "$scratch/deploy.log"; then echo "deploy.sh printed a secret" >&2; exit 1; fi
if compgen -G "$build/.deploy-*" >/dev/null; then echo "deploy.sh left its configuration behind" >&2; exit 1; fi
echo "deploy.sh printed no secret value and left no configuration with secrets behind."

start_node() { # LOG [BUCKET] [WATCH]
	(
		# As deploy.sh reads it, never through a shell.
		while IFS= read -r -d '' entry; do export "${entry?}"; done < <(node "$celld_dir/scripts/render-config.mjs" --print-env "$scratch/etc/celld.env")
		[[ -z "${2:-}" ]] || export CELLD_BUCKET="$2"
		[[ -z "${3:-}" ]] || export CELLD_WATCH="$3"
		exec "$celld"
	) >>"$1" 2>&1 &
	node_pid=$!
	pids+=("$node_pid")
	wait_for "http://127.0.0.1:$celld_port/.well-known/celld/health"
}
stop_node() {
	kill -TERM "$node_pid"
	wait "$node_pid" || true
}

say "Start a node, the mock model and the proxy"
start_node "$scratch/node.log"
node "$here/mock-model.mjs" "$model_port" >"$scratch/model.log" 2>&1 &
pids+=($!)
env -i PATH="$PATH" HOME="$scratch" XDG_DATA_HOME="$scratch/caddy" XDG_CONFIG_HOME="$scratch/caddy" \
	PIM_HOST="pim.localhost" PIM_CONTENT_HOST="pim-content.localhost" CELLD_ADDR="127.0.0.1:$celld_port" \
	CADDY_HTTPS_PORT="$proxy_port" CADDY_HTTP_PORT="$(free_port)" CADDY_ADMIN="localhost:$(free_port)" PIM_INGRESS_SECRET="$ingress_secret" \
	"$CADDY" run --config "$celld_dir/caddy/Caddyfile" --adapter caddyfile >"$scratch/caddy.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 100); do curl -sk -o /dev/null --resolve "pim.localhost:$proxy_port:127.0.0.1" "$pim_url/health" && break; sleep 0.2; done

export PIM_URL="$pim_url" PROXY_PORT="$proxy_port" CELLD_URL="http://127.0.0.1:$celld_port" CELLD_LOG="$scratch/node.log" \
	MOCK_MODEL_URL="http://127.0.0.1:$model_port/v1" WEB_DIST="$build/web/dist" STATE="$scratch/state.json" \
	INGRESS_SECRET="$ingress_secret" RUNTIME="$runtime"
say "Smoke: setup"
node "$here/smoke.mjs" setup
echo "Runtime: $(grep -m1 -o 'runtime_version="[^"]*"' "$scratch/node.log")"

say "Graceful restart (SIGTERM, then the same node state)"
stop_node
start_node "$scratch/node.log"
node "$here/smoke.mjs" verify

say "Where the secrets are"
stop_node
# First, that the search reads the Worker's modules and the static assets as they are stored: a
# string from src/accounts.ts and the web app's script name must each be found somewhere.
script="$(grep -o '/assets/index-[^"]*\.js' "$build/web/dist/index.html" | head -1)"
node "$here/scratch-bucket.mjs" find pim-scratch pim/deploy/ "Pim setup link" "$script" | tee "$scratch/controls-found.txt"
[[ "$(cut -f1 "$scratch/controls-found.txt" | grep -vc manifest.json)" -ge 2 ]] || { echo "The search can't read the deployment's modules or assets." >&2; exit 1; }
node "$here/scratch-bucket.mjs" find pim-scratch pim/ "$canary" "$app_key" "$ingress_secret" | tee "$scratch/secrets-found.txt"
if grep -vqE '^pim/deploy/pim/[0-9a-f]+/manifest\.json	3/3$' "$scratch/secrets-found.txt"; then
	echo "A secret is somewhere besides the deployment's manifest." >&2
	exit 1
fi
[[ "$(wc -l <"$scratch/secrets-found.txt")" == 1 ]] || { echo "Expected the secrets in exactly one manifest." >&2; exit 1; }
if grep -rqF -e "$canary" -e "$app_key" -e "$ingress_secret" "$build/web/dist" "$build/build-info.json"; then echo "A secret is in the build." >&2; exit 1; fi
echo "All three secrets are in the deployment's manifest only: not in the Worker's modules, the static assets, the data, or the build."

say "Cold backup, restored into an empty prefix, on a fresh node"
node "$here/scratch-bucket.mjs" copy pim-scratch pim/ pim-scratch-restore pim/
start_node "$scratch/node-restored.log" "s3://pim-scratch-restore/pim" "$scratch/state-restored"
CELLD_LOG="$scratch/node-restored.log" node "$here/smoke.mjs" verify
stop_node

say "Passed"
