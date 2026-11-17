#!/usr/bin/env bash
# Logical backup of a Compose deployment: pg_dump (custom format, with ownership, so definer functions keep their non-superuser owner), the object
# store (every bucket, through the S3 API on the stack's internal network), and checksums.
# The keys are NOT in this backup: keep deploy/compose/.env in a separate, access-controlled place. A restored database without its key ring cannot
# open any sealed secret.
# Usage: scripts/v2-backup/compose-backup.sh <output-dir>        (restore: scripts/v2-backup/compose-restore.sh <output-dir>/<stamp>)
set -euo pipefail
OUT="${1:?usage: compose-backup.sh <output-dir>}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$(mkdir -p "$OUT/$STAMP" && cd "$OUT/$STAMP" && pwd)"
COMPOSE="$(cd "$(dirname "$0")/../../deploy/compose" && pwd)/pim.sh"
set -a; . "$(dirname "$COMPOSE")/.env"; set +a
"$COMPOSE" exec -T postgres pg_dump -U postgres -d pim --format=custom > "$DEST/pim.pgdump"
"$COMPOSE" exec -T postgres pg_restore --list < "$DEST/pim.pgdump" > "$DEST/pim.toc"
mkdir -p "$DEST/objects"
docker run --rm --network pim_internal -v "$DEST/objects:/objects" -e AWS_ACCESS_KEY_ID="$SEAWEED_ACCESS_KEY" -e AWS_SECRET_ACCESS_KEY="$SEAWEED_SECRET_KEY" -e AWS_DEFAULT_REGION=us-east-1 \
	amazon/aws-cli:2.22.35 --endpoint-url http://seaweedfs:8333 s3 sync "s3://${PIM_S3_BUCKET:-pim-objects}" "/objects/${PIM_S3_BUCKET:-pim-objects}" --only-show-errors
cat > "$DEST/README.txt" <<EON
Backup $STAMP of $PIM_PUBLIC_URL
  pim.pgdump   pg_dump custom format (with owners)
  objects/     the ${PIM_S3_BUCKET:-pim-objects} bucket
  Restore:     scripts/v2-backup/compose-restore.sh $DEST   (stops the app, restores, runs the post-restore safety pass, starts it again)
  Keys:        NOT here. Restore needs the same deploy/compose/.env (PIM_KEK_*) that wrote this data.
EON
(cd "$DEST" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "Wrote $DEST ($(du -sh "$DEST" | cut -f1))"
