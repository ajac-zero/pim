#!/bin/sh
# Qualifies the self-hosted Langfuse recipe on a Docker host, with nothing of Pim's or anyone's data: it renders and validates both Compose files, pulls the pinned images, checks the
# binaries the healthchecks and entrypoints assume are in them, starts Langfuse alone from secrets generated for this run, and runs scripts/langfuse-smoke.mjs against it. It is what the
# `langfuse` CI job runs (one ubuntu-latest job, about six containers, 25 minutes at most); run it by hand the same way. It needs docker with the compose plugin, jq and node.
#
# It is safe on a host that already runs Langfuse or Pim: everything it creates is named for this run alone (a Compose project `pimlfq-<id>`, a network `pim-lfq-<id>`, a free
# loopback port), nothing it did not create is ever touched, and it removes only what it created. It never uses the recipe's own project name (`pim-langfuse`), its default network
# (`pim-traces`) or its default port, so a running instance, its containers, volumes and network are left alone; a name that is already taken stops it before it starts anything.
# It works on a copy of deploy/ in a temporary directory, so neither .env file of the checkout is read or written.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ID="$(node -e 'process.stdout.write(require("crypto").randomBytes(4).toString("hex"))')"
PROJECT="pimlfq-$ID"
NETWORK="pim-lfq-$ID"
case "$PROJECT$NETWORK" in *pim-langfuse* | *pim-traces*) echo "refusing to use a default name" >&2; exit 1 ;; esac
WORK="$(mktemp -d)"
# Set only once the thing exists, so cleanup removes what this run made and nothing else.
STARTED=0
NETWORK_CREATED=0
lf() { (cd "$WORK/deploy/langfuse" && docker compose -p "$PROJECT" "$@"); }
cleanup() {
	status=$?
	if [ "$STARTED" = 1 ]; then
		if [ "$status" -ne 0 ]; then
			# Why a container is not healthy: the last results of its own healthcheck, then the tail of every log.
			for c in $(lf ps -a -q 2>/dev/null); do docker inspect --format '{{.Name}} {{json .State.Health}}' "$c" 2>/dev/null | cut -c1-700 || true; done
		fi
		[ "$status" -eq 0 ] || lf logs --no-color --tail 40 2>&1 | sed -E 's/(sk-lf-|pk-lf-)[0-9a-f]+/\1.../g' || true
		lf down -v --remove-orphans >/dev/null 2>&1 || true
	fi
	if [ "$NETWORK_CREATED" = 1 ]; then docker network rm "$NETWORK" >/dev/null 2>&1 || true; fi
	rm -rf "$WORK"
	exit "$status"
}
trap cleanup EXIT
say() { printf '\n== %s\n' "$1"; }
# A check that says which one failed and what it saw, never silently.
assert() { name="$1"; shift; if printf '%s' "$JSON" | jq -e "$@" >/dev/null; then echo "ok    $name"; else echo "FAIL  $name: $(printf '%s' "$JSON" | jq -c "${EXPR:-.}" 2>&1 | cut -c1-400)" >&2; exit 1; fi; }

mkdir -p "$WORK/deploy"
cp -R "$ROOT/deploy/compose" "$ROOT/deploy/langfuse" "$WORK/deploy/"
rm -f "$WORK/deploy/compose/.env" "$WORK/deploy/langfuse/.env"
export LANGFUSE_TRACES_NETWORK="$NETWORK"
export LANGFUSE_PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
export LANGFUSE_URL="http://127.0.0.1:$LANGFUSE_PORT"
echo "this run: project $PROJECT, network $NETWORK, port $LANGFUSE_PORT"

say "Pim's Compose file renders, with every profile and with the local overlay"
(cd "$WORK/deploy/compose" && ./init-env.sh http://localhost:8088 --image pim:qualify --web-image pim-web:qualify >/dev/null \
	&& docker compose -f compose.yaml --profile '*' config -q \
	&& docker compose -f compose.yaml -f compose.local.yaml --profile '*' config -q)
JSON="$(cd "$WORK/deploy/compose" && OTEL_EXPORTER_OTLP_ENDPOINT=http://langfuse-web:3000/api/public/otel OTEL_EXPORTER_OTLP_HEADERS='Authorization=Basic YTpi==,x-langfuse-ingestion-version=4' docker compose -f compose.yaml config --format json)"
assert "the trace headers reach the Runner" '.services.runner.environment.OTEL_EXPORTER_OTLP_HEADERS == "Authorization=Basic YTpi==,x-langfuse-ingestion-version=4"'
assert "Pim's trace network is the one Langfuse joins" '.networks.traces.name == "pim-traces"'
assert "only the Runner joins it" '[.services | to_entries[] | select((.value.networks // {}) | has("traces")) | .key] == ["runner"]'

say "Langfuse's Compose file refuses to render without its secrets, then renders with generated ones"
if lf config -q >/dev/null 2>&1; then echo "rendered without secrets" >&2; exit 1; fi
(cd "$WORK/deploy/langfuse" && ./init-env.sh qualify@example.test >/dev/null)
lf config -q
JSON="$(lf config --format json)"
assert "only the web service publishes a port, on the loopback address" '[.services | to_entries[] | select(.value.ports) | .key] == ["langfuse-web"] and (.services["langfuse-web"].ports | all(.host_ip == "127.0.0.1"))'
assert "the project joins the network of this run" '.networks["pim-traces"].name == "'"$NETWORK"'" and .networks["pim-traces"].external == true'
assert "every service has a healthcheck" '[.services[] | select(.healthcheck.test == null)] | length == 0'

say "the pinned images exist, and hold the binaries the healthchecks and entrypoints use"
lf pull --quiet
printf '%s' "$JSON" | jq -r '.services | to_entries[] | select(.value.healthcheck.test) | [.key, .value.image, (.value.healthcheck.test | if .[0] == "CMD" then .[1] else (.[1] | split(" ")[0]) end)] | @tsv' | while IFS="$(printf '\t')" read -r service image binary; do
	docker run --rm --entrypoint sh "$image" -c "command -v $binary" >/dev/null || { echo "FAIL  $service: $binary is not in $image" >&2; exit 1; }
	echo "ok    $service healthcheck uses $binary"
done
docker run --rm --entrypoint sh "$(printf '%s' "$JSON" | jq -r '.services.minio.image')" -c 'command -v mkdir minio mc' >/dev/null || { echo "FAIL  minio: the entrypoint's binaries are missing" >&2; exit 1; }

say "Langfuse starts, healthy, from generated secrets, and takes and shows what Pim sends"
# A network that cannot be made (the name is taken, or Docker refuses) stops the run before anything else exists; it is never assumed to be ours.
docker network create "$NETWORK" >/dev/null
NETWORK_CREATED=1
STARTED=1
lf up -d --wait --wait-timeout 600
key() { sed -n "s/^$1=//p" "$WORK/deploy/langfuse/.env" | tail -1; }
export LANGFUSE_PUBLIC_KEY="$(key LANGFUSE_PUBLIC_KEY)" LANGFUSE_SECRET_KEY="$(key LANGFUSE_SECRET_KEY)" LANGFUSE_SMOKE_WAIT_SECONDS=120
if [ -n "${LANGFUSE_QUALIFY_SMOKE:-}" ]; then sh -c "$LANGFUSE_QUALIFY_SMOKE"; else node "$ROOT/scripts/langfuse-smoke.mjs"; fi
