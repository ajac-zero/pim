#!/usr/bin/env bash
# Restores a compose-backup.sh backup into the running Compose stack's PostgreSQL and object store, then runs the post-restore safety pass before any
# Runner starts: in-flight and pending external operations go to needs_reconciliation (never re-sent), unfinished tool tasks are held, and overdue
# schedules are recomputed without a catch-up. Everything written after the backup is replaced: take a fresh backup first if it matters.
# Usage: scripts/v2-backup/compose-restore.sh <backup-dir> [restore-id]
set -euo pipefail
SRC="$(cd "${1:?usage: compose-restore.sh <backup-dir> [restore-id]}" && pwd)"
RESTORE_ID="${2:-restore-$(date -u +%Y%m%dT%H%M%SZ)}"
COMPOSE="$(cd "$(dirname "$0")/../../deploy/compose" && pwd)/pim.sh"
set -a; . "$(dirname "$COMPOSE")/.env"; set +a
(cd "$SRC" && sha256sum --quiet -c SHA256SUMS)
# Nothing may run against the database while it is replaced; Runners stay stopped until the safety pass has run.
"$COMPOSE" stop caddy gate live runner forge maintenance
"$COMPOSE" exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'pim' AND pid <> pg_backend_pid()" >/dev/null
"$COMPOSE" exec -T postgres pg_restore -U postgres -d pim --clean --if-exists --exit-on-error < "$SRC/pim.pgdump"
docker run --rm --network pim_internal -v "$SRC/objects:/objects:ro" -e AWS_ACCESS_KEY_ID="$SEAWEED_ACCESS_KEY" -e AWS_SECRET_ACCESS_KEY="$SEAWEED_SECRET_KEY" -e AWS_DEFAULT_REGION=us-east-1 \
	amazon/aws-cli:2.22.35 --endpoint-url http://seaweedfs:8333 s3 sync "/objects/${PIM_S3_BUCKET:-pim-objects}" "s3://${PIM_S3_BUCKET:-pim-objects}" --delete --only-show-errors
# Migrations the restored dump predates, then the safety pass, as the schema owner.
"$COMPOSE" run --rm migrator migrate
"$COMPOSE" run --rm -e PIM_RESTORE_ID="$RESTORE_ID" migrator post-restore
"$COMPOSE" up -d
echo "Restored $SRC as $RESTORE_ID"
