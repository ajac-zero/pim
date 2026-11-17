#!/usr/bin/env bash
# Boots the Compose stack from this checkout and proves the core path over the real proxy, PgBouncer, NATS and SeaweedFS: the first account is set up
# through its claim link, a chat is answered by a Runner through a stand-in OpenAI-compatible model, an http_request is parked for approval and runs
# after it is approved, an image round-trips through object storage, and a backup and restore bring the database and objects back.
# Usage: scripts/v2-compose/smoke.sh [--keep]    (needs Docker with compose; uses deploy/compose/.env, creating a local one if there is none)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
C="$ROOT/deploy/compose/pim.sh"
URL=http://localhost:8088
step() { printf '\n== %s\n' "$*"; }
[ -e "$ROOT/deploy/compose/.env" ] || "$ROOT/deploy/compose/init-env.sh" "$URL" --image pim:v2-smoke
grep -q '^PIM_AI_GATEWAY_URL=' "$ROOT/deploy/compose/.env" || printf 'PIM_AI_GATEWAY_URL=http://fakemodel:9000/v1\nPIM_AI_GATEWAY_KEY=none\nPIM_AI_GATEWAY_MODELS=fake-1\nPIM_DEFAULT_MODEL=gateway/fake-1\n' >> "$ROOT/deploy/compose/.env"
IMAGE="$(grep '^PIM_IMAGE=' "$ROOT/deploy/compose/.env" | cut -d= -f2)"
step "build $IMAGE"
docker build -q -f "$ROOT/deploy/Dockerfile.v2" -t "$IMAGE" "$ROOT"
step "up"
"$C" up -d --wait
docker rm -f pim-fakemodel >/dev/null 2>&1 || true
docker run -d --name pim-fakemodel --network pim_internal --network-alias fakemodel -v "$ROOT/scripts/v2-compose/fake-model.mjs:/fake.mjs:ro" node:26-bookworm-slim node /fake.mjs >/dev/null
JAR="$(mktemp)"
api() { curl -sS -b "$JAR" -c "$JAR" -H "origin: $URL" -H 'content-type: application/json' "$@"; }
step "web app and health"
curl -sSf "$URL/" | grep -q '<div id="root">' && echo "index.html served"
step "first account through its claim link"
api -X POST "$URL/auth/setup-link" >/dev/null
sleep 1
CLAIM="$("$C" logs gate 2>&1 | grep -o '#claim=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2)"
[ -n "$CLAIM" ] || { echo "no claim link in the gate's log"; exit 1; }
api -X POST "$URL/auth/register" -d "{\"username\":\"smoke$RANDOM\",\"bootstrap\":\"$CLAIM\"}" | grep -q '"account"' && echo "admin registered"
api "$URL/api/majordomo" | grep -q '"majordomo":true' && echo "majordomo ready"
step "chat answered by a Runner"
CHAT="$(api -X POST "$URL/api/sessions" -d '{"title":"smoke"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')"
send() { api -X POST "$URL/api/sessions/$CHAT/messages" -d "{\"commandId\":\"cmd_$RANDOM$RANDOM\",\"text\":$1}" >/dev/null; }
until_seen() { for _ in $(seq 1 60); do api "$URL/api/snapshot/chat/$CHAT?limit=100" | grep -q "$1" && return 0; sleep 1; done; echo "never saw $1"; return 1; }
send '"hello smoke"'
until_seen 'Echo: hello smoke' && echo "answered"
step "approval"
send '"/tool http_request {\"method\":\"GET\",\"url\":\"https://example.com\"}"'
for _ in $(seq 1 60); do AP="$(api "$URL/api/approvals?status=pending" | grep -o '"id":"ap_[^"]*"' | head -1 | cut -d'"' -f4 || true)"; [ -n "$AP" ] && break; sleep 1; done
[ -n "$AP" ] && echo "parked for approval $AP"
api -X POST "$URL/api/approvals/$AP/approve" -d '{}' | grep -q '"status":"approved"' && echo "approved"
until_seen 'Tool result: 200' && echo "ran after approval"
step "object storage"
KEY="$(curl -sS "$URL/icon-192.png" | api -X POST -H 'content-type: image/png' --data-binary @- "$URL/api/images" | sed -E 's/.*"key":"([^"]+)".*/\1/')"
api -o /dev/null -w '%{http_code}\n' "$URL/api/images/$KEY" | grep -q 200 && echo "image stored and read back"
step "backup and restore"
BK="$(mktemp -d)"
"$ROOT/scripts/v2-backup/compose-backup.sh" "$BK" | tail -1
send '"after the backup"'
until_seen 'Echo: after the backup'
"$ROOT/scripts/v2-backup/compose-restore.sh" "$BK"/* smoke-restore | tail -1
"$C" up -d --wait >/dev/null
api "$URL/api/snapshot/chat/$CHAT?limit=100" | grep -q 'after the backup' && { echo "restore kept a later message"; exit 1; }
api -o /dev/null -w '%{http_code}\n' "$URL/api/images/$KEY" | grep -q 200 && echo "restored: later message gone, image back"
send '"after the restore"'
until_seen 'Echo: after the restore' && echo "answered after restore"
step "PASS"
[ "${1:-}" = "--keep" ] || { "$C" down -v >/dev/null 2>&1; docker rm -f pim-fakemodel >/dev/null; }
