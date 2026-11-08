#!/usr/bin/env bash
# End-to-end check against a real Docker daemon ($DOCKER_HOST or the local socket) that has gVisor.
# Brings the compose stack up, drives the manager's HTTP API, and checks for leftovers.
# Needs: docker (with compose), curl, jq. Set KEEP=1 to leave the stack running.
set -euo pipefail
cd "$(dirname "$0")/.."

export MANAGER_TOKEN="${MANAGER_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')}"
export PROXY_ADMIN_TOKEN="${PROXY_ADMIN_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')}"
export MANAGER_PORT="${MANAGER_PORT:-18080}"
IMAGE=pim-smoke-sandbox:local
ALLOWED=example.com
DENIED=example.org
SID="smoke-$RANDOM"
URL="http://127.0.0.1:$MANAGER_PORT"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
api() { curl -sS -H "authorization: Bearer $MANAGER_TOKEN" -H 'content-type: application/json' "$@"; }

# A tiny sandbox image: sh, realpath, curl, and /workspace owned by the sandbox user.
docker build -q -t "$IMAGE" - <<'DOCKERFILE' >/dev/null
FROM alpine:3.20
RUN apk add --no-cache curl && mkdir /workspace && chown 10001:10001 /workspace
DOCKERFILE
export ALLOWED_IMAGES="$IMAGE"

cleanup() { [ "${KEEP:-}" = 1 ] || docker compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker compose up -d --build
for _ in $(seq 60); do curl -fsS "$URL/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$URL/health" | jq -e '.runsc == true' >/dev/null || { docker compose logs sandbox-manager; fail "manager not healthy / runsc missing"; }
ok "manager healthy, runsc verified"

api -X POST "$URL/sessions" -d "{\"sessionId\":\"$SID\",\"image\":\"$IMAGE\",\"limits\":{\"cpu\":1,\"memMiB\":256,\"diskMiB\":256,\"pids\":128},\"egressAllow\":[\"$ALLOWED\"]}" | jq -e ".sessionId == \"$SID\"" >/dev/null || fail "create"
ok "session created"
exec_json() { api -X POST "$URL/sessions/$SID/exec" -d "$1"; }

[ "$(exec_json '{"cmd":["echo","hi"],"timeoutMs":10000}' | jq -r .stdout)" = "hi" ] || fail "echo hi"
ok "exec echo hi"

# gVisor's kernel reports itself in uname; runc would show the host kernel build.
UNAME=$(exec_json '{"cmd":["uname","-a"],"timeoutMs":10000}' | jq -r .stdout)
echo "uname: $UNAME"
echo "$UNAME" | grep -qiE 'runsc| 4\.4\.0 ' || fail "uname does not look like gVisor"
docker inspect "pim-s-$SID" --format '{{.HostConfig.Runtime}}' | grep -qx runsc || fail "container is not runtime runsc"
ok "runtime is runsc"

code=$(exec_json "{\"cmd\":[\"curl\",\"-sS\",\"-o\",\"/dev/null\",\"-w\",\"%{http_code}\",\"--max-time\",\"15\",\"https://$ALLOWED\"],\"timeoutMs\":30000}" | jq -r .stdout)
case "$code" in 2*|3*) ok "allowlisted https://$ALLOWED reachable ($code)";; *) fail "allowlisted host not reachable: $code";; esac
r=$(exec_json "{\"cmd\":[\"curl\",\"-sS\",\"-o\",\"/dev/null\",\"--max-time\",\"15\",\"https://$DENIED\"],\"timeoutMs\":30000}")
[ "$(jq -r .exitCode <<<"$r")" != 0 ] || fail "non-allowlisted host was reachable"
ok "non-allowlisted https://$DENIED blocked"
r=$(exec_json '{"cmd":["curl","-sS","--noproxy","*","--max-time","5","https://1.1.1.1"],"timeoutMs":20000}')
[ "$(jq -r .exitCode <<<"$r")" != 0 ] || fail "direct egress bypassing the proxy worked"
ok "direct egress (no proxy) has no route"

echo hello | api -X PUT "$URL/sessions/$SID/files?path=dir/a.txt" --data-binary @- -H 'content-type: application/octet-stream' | jq -e .ok >/dev/null || fail "file put"
[ "$(api "$URL/sessions/$SID/files?path=dir/a.txt")" = hello ] || fail "file get"
exec_json '{"cmd":["ln","-s","/etc","/workspace/evil"],"timeoutMs":10000}' >/dev/null
[ "$(api -o /dev/null -w '%{http_code}' "$URL/sessions/$SID/files?path=evil/passwd")" = 403 ] || fail "symlink escape not rejected"
ok "files confined to /workspace"

r=$(exec_json '{"cmd":["sleep","30"],"timeoutMs":1000}')
[ "$(jq -r .timedOut <<<"$r")" = true ] || fail "timeout not reported"
ok "exec timeout"

api -X DELETE "$URL/sessions/$SID" | jq -e .deleted >/dev/null || fail "delete"
left=$(docker ps -aq --filter label=pim.coding.session; docker volume ls -q --filter label=pim.coding.session; docker network ls -q --filter label=pim.coding.session)
[ -z "$left" ] || fail "leftovers after delete: $left"
docker network inspect "pim-net-$SID" >/dev/null 2>&1 && fail "session network still exists"
ok "no leftovers"
echo "ALL OK"
