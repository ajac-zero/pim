#!/usr/bin/env bash
# End-to-end check against a real Docker daemon ($DOCKER_HOST or the local socket) that has gVisor.
# Brings the compose stack up, drives the manager's HTTP API, and checks for leftovers.
# Needs: docker (with compose), curl, jq. Set KEEP=1 to leave the stack running.
set -euo pipefail
cd "$(dirname "$0")/.."

export MANAGER_TOKEN="${MANAGER_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')}"
export PROXY_ADMIN_TOKEN="${PROXY_ADMIN_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')}"
export AGENTD_TOKEN_SECRET="${AGENTD_TOKEN_SECRET:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')}"
export MANAGER_PORT="${MANAGER_PORT:-18080}"
export DISK_CHECK_SEC=2
IMAGE=pim-smoke-sandbox:local
ALLOWED=example.com
DENIED=example.org
SID="smoke-$RANDOM"
URL="http://127.0.0.1:$MANAGER_PORT"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
docker compose version >/dev/null 2>&1 || fail "'docker compose' (the compose plugin) is required"
command -v jq >/dev/null || fail "jq is required"
command -v curl >/dev/null || fail "curl is required"
# Classic builder when buildx is missing.
docker buildx version >/dev/null 2>&1 || export DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0
# Mount the daemon's socket from a unix:// DOCKER_HOST.
case "${DOCKER_HOST:-}" in unix://*) export DOCKER_SOCKET="${DOCKER_HOST#unix://}";; esac
api() { curl -sS -H "authorization: Bearer $MANAGER_TOKEN" -H 'content-type: application/json' "$@"; }

# The default workspace image (workspace-agentd), plus curl for the egress checks.
docker compose build workspace-image >/dev/null
docker build -q -t "$IMAGE" - <<'DOCKERFILE' >/dev/null
FROM pim-workspace:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
USER 10001:10001
DOCKERFILE
export ALLOWED_IMAGES="$IMAGE"

cleanup() {
	# Remove the sessions first so a failed step leaks no container, volume or network.
	for s in "$SID" "$SID-q"; do curl -sS -X DELETE -H "authorization: Bearer $MANAGER_TOKEN" "$URL/sessions/$s" >/dev/null 2>&1 || true; done
	[ "${KEEP:-}" = 1 ] || docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose up -d --build
for _ in $(seq 60); do curl -fsS "$URL/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$URL/health" | jq -e '.runsc == true' >/dev/null || { docker compose logs sandbox-manager; fail "manager not healthy / runsc missing"; }
ok "manager healthy, runsc verified"

create() { api -X POST "$URL/sessions" -d "{\"sessionId\":\"$1\",\"image\":\"$IMAGE\",\"limits\":{\"cpu\":1,\"memMiB\":256,\"diskMiB\":$2,\"pids\":128},\"egressAllow\":[\"$ALLOWED\"]}"; }
create "$SID" 256 | jq -e ".sessionId == \"$SID\"" >/dev/null || fail "create"
ok "session created (agentd answered)"
exec_json() { api -X POST "$URL/sessions/$SID/exec" -d "$1"; }

[ "$(exec_json '{"cmd":["echo","hi"],"timeoutMs":10000}' | jq -r .stdout)" = "hi" ] || fail "echo hi"
ok "exec echo hi"
[ "$(exec_json '{"cmd":["sh","-c","echo ${AGENTD_TOKEN:-none}"],"timeoutMs":10000}' | jq -r .stdout)" = "none" ] || fail "exec sees AGENTD_TOKEN"
ok "commands do not see the agentd token"

# gVisor's kernel reports itself in uname; runc would show the host kernel build.
UNAME=$(exec_json '{"cmd":["uname","-a"],"timeoutMs":10000}' | jq -r .stdout)
echo "uname: $UNAME"
echo "$UNAME" | grep -qi gvisor || fail "uname does not show gVisor"
docker inspect "pim-s-$SID" --format '{{.HostConfig.Runtime}}' | grep -qx runsc || fail "container is not runtime runsc"
ok "runtime is runsc"

# docker-socket-proxy must refuse exec (the manager no longer uses it), build and swarm.
via_proxy() { docker compose exec -T sandbox-manager node -e "fetch('http://docker-socket-proxy:2375'+process.argv[1],{method:'POST',headers:{'content-type':'application/json'},body:process.argv[2]}).then(r=>console.log(r.status))" "$@"; }
[ "$(via_proxy /exec/x/start '{}')" = 403 ] || fail "docker-socket-proxy allows exec start"
[ "$(via_proxy /build '{}')" = 403 ] || fail "docker-socket-proxy allows /build"
[ "$(via_proxy /swarm/init '{}')" = 403 ] || fail "docker-socket-proxy allows /swarm"
ok "docker-socket-proxy denies exec, build and swarm"

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
api "$URL/sessions/$SID/list?path=dir" | jq -e '.[0].name == "a.txt"' >/dev/null || fail "list"
api "$URL/sessions/$SID/stat?path=dir" | jq -e '.type == "dir"' >/dev/null || fail "stat"
api -X DELETE "$URL/sessions/$SID/files?path=dir&recursive=1" | jq -e .ok >/dev/null || fail "delete file"
exec_json '{"cmd":["ln","-s","/etc","/workspace/evil"],"timeoutMs":10000}' >/dev/null
[ "$(api -o /dev/null -w '%{http_code}' "$URL/sessions/$SID/files?path=evil/passwd")" = 403 ] || fail "symlink escape not rejected"
ok "files, list, stat, delete; confined to /workspace"

# A timeout kills that exec's process group only: a process in its own session survives it.
pid=$(exec_json '{"cmd":["sh","-c","setsid sleep 300 >/dev/null 2>&1 & echo $!"],"timeoutMs":10000}' | jq -r .stdout)
r=$(exec_json '{"cmd":["sleep","30"],"timeoutMs":1000}')
[ "$(jq -r .timedOut <<<"$r")" = true ] || fail "timeout not reported"
[ "$(exec_json "{\"cmd\":[\"sh\",\"-c\",\"kill -0 $pid\"],\"timeoutMs\":5000}" | jq -r .exitCode)" = 0 ] || fail "timeout killed an unrelated process"
ok "exec timeout kills only its own process group"

# Restarting the manager and recreating the proxy must keep the session usable.
docker compose up -d --force-recreate egress-proxy sandbox-manager >/dev/null
for _ in $(seq 60); do curl -fsS "$URL/health" >/dev/null 2>&1 && break; sleep 1; done
[ "$(exec_json '{"cmd":["echo","back"],"timeoutMs":10000}' | jq -r .stdout)" = "back" ] || fail "session unreachable after manager restart"
code=$(exec_json "{\"cmd\":[\"curl\",\"-sS\",\"-o\",\"/dev/null\",\"-w\",\"%{http_code}\",\"--max-time\",\"15\",\"https://$ALLOWED\"],\"timeoutMs\":30000}" | jq -r .stdout)
case "$code" in 2*|3*) ok "session and egress survive a recreated manager and proxy";; *) fail "egress lost after recreate: $code";; esac

# Disk quota: in volume mode the write fails; in measure mode the session is stopped.
create "$SID-q" 64 >/dev/null
mode=$(api "$URL/sessions/$SID-q/status" | jq -r .quotaMode)
api -X POST "$URL/sessions/$SID-q/exec" -d '{"cmd":["sh","-c","head -c 100000000 /dev/zero > /workspace/big"],"timeoutMs":60000}' >/dev/null || true
if [ "$mode" = measure ]; then
	sleep 5
	api "$URL/sessions/$SID-q/status" | jq -e '.state == "stopped" and .reason == "over_disk_quota"' >/dev/null || fail "over-quota session not stopped"
else
	api "$URL/sessions/$SID-q/status" | jq -e '.diskBytes <= 67108864' >/dev/null || fail "volume quota not enforced"
fi
ok "disk quota enforced ($mode)"

api -X DELETE "$URL/sessions/$SID?keepVolume=1" | jq -e '.keptVolume' >/dev/null || fail "delete keepVolume"
docker volume inspect "pim-ws-$SID" >/dev/null || fail "kept volume is gone"
api -X DELETE "$URL/sessions/$SID" | jq -e .deleted >/dev/null || fail "delete"
api -X DELETE "$URL/sessions/$SID-q" | jq -e .deleted >/dev/null || fail "delete"
left=$(docker ps -aq --filter label=pim.coding.session; docker volume ls -q --filter label=pim.coding.session; docker volume ls -q --filter label=pim.coding.kept; docker network ls -q --filter label=pim.coding.session)
[ -z "$left" ] || fail "leftovers after delete: $left"
docker network inspect "pim-net-$SID" >/dev/null 2>&1 && fail "session network still exists"
ok "no leftovers"
echo "ALL OK"
