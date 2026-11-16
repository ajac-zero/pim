#!/usr/bin/env bash
# Logical backup of a Compose deployment: pg_dump (custom format), the object store, and the names and fingerprints of the key material.
# The keys themselves are NOT in this backup: keep .env (or the OpenBao export) in a separate, access-controlled place. A restored database without its key ring cannot open any sealed secret.
# Usage: scripts/v2-backup/compose-backup.sh <output-dir>
set -euo pipefail
OUT="${1:?usage: compose-backup.sh <output-dir>}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$OUT/$STAMP"
mkdir -p "$DEST"
cd "$(dirname "$0")/../../deploy/compose"
docker compose exec -T postgres pg_dump -U postgres -d pim --format=custom --no-owner > "$DEST/pim.pgdump"
docker compose exec -T postgres pg_restore --list < "$DEST/pim.pgdump" > "$DEST/pim.toc"
# Objects: SeaweedFS exposes the S3 API on the internal network; copy through the aws CLI or mc of your choice from any host that can reach it.
cat > "$DEST/README.txt" <<EON
Backup $STAMP
  pim.pgdump  pg_dump custom format; restore with: pg_restore --clean --if-exists -d pim pim.pgdump
  Objects     copy the bucket separately (aws s3 sync / mc mirror) from the seaweedfs S3 endpoint into $DEST/objects
  After a restore, BEFORE starting runners:  docker compose stop runner && node scripts/v2-backup/run.mjs post-restore --database-url ... --restore-id <id>
EON
sha256sum "$DEST"/pim.pgdump > "$DEST/SHA256SUMS"
echo "Wrote $DEST"
