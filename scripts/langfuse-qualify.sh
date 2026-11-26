#!/bin/sh
# Qualifies the self-hosted Langfuse recipe on a Docker host, with nothing of Pim's or anyone's data: it renders and validates both Compose files, pulls the pinned images, checks the
# binaries the healthchecks and entrypoints assume are in them, starts Langfuse alone from secrets generated for this run, and runs scripts/langfuse-smoke.mjs against it. Everything it
# starts is removed afterwards, volumes included. It is what the `langfuse` CI job runs (a single ubuntu-latest job, about six containers, 25 minutes at most); run it by hand the same way.
# It needs docker with the compose plugin, jq and node, and leaves deploy/compose/.env and deploy/langfuse/.env alone if they exist (it uses a copy of the tree in a temporary directory).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'status=$?; [ "$status" -eq 0 ] || (cd "$WORK/deploy/langfuse" && docker compose logs --no-color --tail 80 2>&1 | sed -E "s/(sk-lf-|pk-lf-)[0-9a-f]+/\1…/g" || true); (cd "$WORK/deploy/langfuse" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true; docker network rm pim-traces >/dev/null 2>&1 || true; rm -rf "$WORK"; exit $status' EXIT
mkdir -p "$WORK/deploy"
cp -R "$ROOT/deploy/compose" "$ROOT/deploy/langfuse" "$WORK/deploy/"
rm -f "$WORK/deploy/compose/.env" "$WORK/deploy/langfuse/.env"
say() { printf '\n== %s\n' "$1"; }

say "Pim's Compose file renders, with every profile and with the local overlay"
(cd "$WORK/deploy/compose" && ./init-env.sh http://localhost:8088 --image pim:qualify --web-image pim-web:qualify >/dev/null \
	&& docker compose -f compose.yaml --profile '*' config -q \
	&& docker compose -f compose.yaml -f compose.local.yaml --profile '*' config -q)
# The trace variables reach the Runner, and only the Runner shares the trace network.
(cd "$WORK/deploy/compose" && OTEL_EXPORTER_OTLP_ENDPOINT=http://langfuse-web:3000/api/public/otel OTEL_EXPORTER_OTLP_HEADERS='Authorization=Basic YTpi==,x-langfuse-ingestion-version=4' docker compose -f compose.yaml config --format json \
	| jq -e '.services.runner.environment.OTEL_EXPORTER_OTLP_HEADERS == "Authorization=Basic YTpi==,x-langfuse-ingestion-version=4" and .networks.traces.name == "pim-traces" and ([.services[] | select(.networks.traces) ] | length) == 1' >/dev/null)

say "Langfuse's Compose file refuses to render without its secrets, then renders with generated ones"
if (cd "$WORK/deploy/langfuse" && docker compose config -q >/dev/null 2>&1); then echo "rendered without secrets" >&2; exit 1; fi
(cd "$WORK/deploy/langfuse" && ./init-env.sh qualify@example.test >/dev/null && docker compose config -q)
# The recipe's address for the smoke test is the one it publishes; the web container must be the only service that publishes anything.
(cd "$WORK/deploy/langfuse" && docker compose config --format json | jq -e '[.services[] | select(.ports)] | length == 1 and (.[0].ports[0].host_ip == "127.0.0.1")' >/dev/null)

say "the pinned images exist, and hold the binaries the healthchecks and entrypoints use"
cd "$WORK/deploy/langfuse"
docker compose config --format json > "$WORK/langfuse.json"
docker compose pull --quiet
jq -r '.services | to_entries[] | select(.value.healthcheck.test) | [.key, .value.image, (.value.healthcheck.test | if .[0] == "CMD" then .[1] else (.[1] | split(" ")[0]) end)] | @tsv' "$WORK/langfuse.json" | while IFS="$(printf '\t')" read -r service image binary; do
	docker run --rm --entrypoint sh "$image" -c "command -v $binary" >/dev/null || { echo "$service: $binary is not in $image" >&2; exit 1; }
	echo "ok    $service healthcheck uses $binary"
done
# Every service has a healthcheck, and the one entrypoint the recipe overrides (MinIO's `sh`) is there too.
jq -e '[.services[] | select(.healthcheck.test == null)] | length == 0' "$WORK/langfuse.json" >/dev/null
docker run --rm --entrypoint sh "$(jq -r '.services.minio.image' "$WORK/langfuse.json")" -c 'command -v mkdir minio mc' >/dev/null

say "Langfuse starts, healthy, from generated secrets, and takes and shows what Pim sends"
docker network create pim-traces >/dev/null 2>&1 || true
docker compose up -d --wait --wait-timeout 600
set -a; . ./.env; set +a
LANGFUSE_URL="http://127.0.0.1:${LANGFUSE_PORT}" LANGFUSE_SMOKE_WAIT_SECONDS=120 node "$ROOT/scripts/langfuse-smoke.mjs"
