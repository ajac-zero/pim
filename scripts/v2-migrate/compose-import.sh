#!/usr/bin/env bash
# Imports a v1 export (`run.mjs export` through the fence Worker) into a fresh Compose stack and promotes it into the live schemas, inside the stack's own
# image and with its own keys, so nothing about the import depends on the machine it runs from. The stack must be new: up once (so the migrations ran)
# and never claimed. Gate, Live, Runners, Forge and maintenance stay stopped until the import and promotion have finished, then start again.
# Usage: scripts/v2-migrate/compose-import.sh <work-dir> [legacy-rp-id] [default-model]
#   <work-dir>      holds snapshot/ from the export; objects/ and report/ are written next to it
#   legacy-rp-id    the old deployment's passkey RP id (its hostname); passkeys only carry over when it equals the new one
#   default-model   provider/model for imported chats whose provider the new deployment lacks (default: the stack's PIM_DEFAULT_MODEL)
set -euo pipefail
WORK="$(cd "${1:?usage: compose-import.sh <work-dir> [legacy-rp-id] [default-model]}" && pwd)"
COMPOSE="$(cd "$(dirname "$0")/../../deploy/compose" && pwd)/pim.sh"
set -a; . "$(dirname "$COMPOSE")/.env"; set +a
NEW_RP_ID="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$PIM_PUBLIC_URL")"
LEGACY_RP_ID="${2:-$NEW_RP_ID}"
MODEL="${3:-${PIM_DEFAULT_MODEL:-}}"
[ -f "$WORK/snapshot/manifest.json" ] || { echo "no snapshot/manifest.json in $WORK" >&2; exit 1; }
CUTOVER_AT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).cutoverAt)' "$WORK/snapshot/manifest.json")"
chmod -R a+rwX "$WORK"
"$COMPOSE" up -d --wait postgres pgbouncer nats seaweedfs
"$COMPOSE" stop caddy gate live runner forge maintenance
"$COMPOSE" run --rm migrator migrate
"$COMPOSE" run --rm --no-deps -v "$WORK:/work" -e LEGACY_RP_ID="$LEGACY_RP_ID" -e NEW_RP_ID="$NEW_RP_ID" --entrypoint sh migrator -c \
	'node --import tsx ../v2-ops/src/cli/migrate.ts import --snapshot /work/snapshot --database-url "$PIM_DATABASE_URL" --objects-dir /work/objects --cutover-id "cut-$(date -u +%Y%m%dT%H%M%SZ)" --report /work/report --legacy-rp-id "$LEGACY_RP_ID" --new-rp-id "$NEW_RP_ID"'
"$COMPOSE" run --rm --no-deps -v "$WORK:/work" -e PIM_RP_ID="$NEW_RP_ID" -e PIM_LEGACY_RP_ID="$LEGACY_RP_ID" -e PIM_CUTOVER_AT="$CUTOVER_AT" -e PIM_LEGACY_OBJECTS_DIR=/work/objects ${MODEL:+-e PIM_DEFAULT_MODEL="$MODEL"} migrator promote | tee "$WORK/report/promote.log"
"$COMPOSE" up -d --wait
echo "Imported $WORK/snapshot; the audit and promotion reports are in $WORK/report"
