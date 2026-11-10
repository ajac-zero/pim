#!/usr/bin/env bash
# Installs or updates hostopsd on the Pim host. Run it with sudo; running it again is safe and
# keeps what it set up before (the token too, unless you give a new one).
#
#   sudo sandbox-manager/hostopsd/install.sh --url https://pim.example.com
#
# It asks for the hostopsd token without echoing it, or reads it from --token-file (a path, or
# "-" for stdin), or from stdin when stdin is not a terminal. The token is never accepted on the
# command line, where `ps` would show it.
#
# Options, each also taken from the environment variable in brackets:
#   --url URL            [HOSTOPS_URL] Pim's https origin
#   --token-file PATH    [HOSTOPS_TOKEN_FILE] file holding the token, or - for stdin
#   --checkout PATH      [PIM_CHECKOUT] the Pim checkout (default: the one holding this script)
#   --manager-env PATH   [MANAGER_ENV_FILE] the sandbox manager's environment: MANAGER_TOKEN,
#                        PROXY_ADMIN_TOKEN, ... (default: sandbox-manager/.env if it exists,
#                        otherwise captured from the running sandbox-manager container)
#   --manager-url URL    [MANAGER_URL] default http://127.0.0.1:$MANAGER_PORT (8080)
#   --node PATH          [NODE_BIN] Node.js 22 or later (default: node on PATH)
set -euo pipefail

die() {
	echo "install.sh: $*" >&2
	exit 1
}
[ "$(id -u)" = 0 ] || die "run it with sudo"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ETC=/etc/hostopsd
ENV_FILE=$ETC/env
STATE_DIR=/var/lib/hostopsd
URL=${HOSTOPS_URL:-}
TOKEN_FILE=${HOSTOPS_TOKEN_FILE:-}
CHECKOUT=${PIM_CHECKOUT:-$(cd "$SCRIPT_DIR/../.." && pwd)}
MANAGER_ENV=${MANAGER_ENV_FILE:-}
MANAGER_URL=${MANAGER_URL:-}
NODE_BIN=${NODE_BIN:-}
while [ $# -gt 0 ]; do
	case "$1" in
	--url) URL=${2:?--url needs a value}; shift 2 ;;
	--token-file) TOKEN_FILE=${2:?--token-file needs a value}; shift 2 ;;
	--checkout) CHECKOUT=${2:?--checkout needs a value}; shift 2 ;;
	--manager-env) MANAGER_ENV=${2:?--manager-env needs a value}; shift 2 ;;
	--manager-url) MANAGER_URL=${2:?--manager-url needs a value}; shift 2 ;;
	--node) NODE_BIN=${2:?--node needs a value}; shift 2 ;;
	--token | --token=*) die "give the token on stdin, at the prompt or with --token-file, not on the command line" ;;
	*) die "unknown option $1" ;;
	esac
done

# A value from the env file an earlier run wrote.
installed() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 || true; }
as_hostopsd() { runuser -u hostopsd -- env HOME="$STATE_DIR" "$@"; }

# --- What is needed --------------------------------------------------------------------------
CHECKOUT=$(cd "$CHECKOUT" && pwd)
[ -x "$CHECKOUT/sandbox-manager/up.sh" ] || die "$CHECKOUT is not a Pim checkout (no sandbox-manager/up.sh)"
[ -f "$CHECKOUT/sandbox-manager/hostopsd/hostopsd.js" ] || die "$CHECKOUT has no sandbox-manager/hostopsd yet; check out a commit that has it"
for cmd in git docker systemctl runuser; do command -v "$cmd" >/dev/null || die "$cmd is missing"; done
command -v setfacl >/dev/null || die "setfacl is missing (apt-get install acl)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing"
getent group docker >/dev/null || die "there is no docker group"
NODE_BIN=${NODE_BIN:-$(installed NODE_BIN)}
NODE_BIN=${NODE_BIN:-$(command -v node || true)}
[ -n "$NODE_BIN" ] || die "node was not found; install Node.js 22 or later, or pass --node /path/to/node"
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "$NODE_BIN is Node.js $NODE_MAJOR; hostopsd needs 22 or later"

URL=${URL:-$(installed HOSTOPS_URL)}
URL=${URL%/}
[[ "$URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "give Pim's origin with --url https://... (got '${URL}')"

TOKEN=${HOSTOPS_TOKEN:-}
if [ -z "$TOKEN" ] && [ -n "$TOKEN_FILE" ]; then
	if [ "$TOKEN_FILE" = - ]; then IFS= read -r TOKEN || true; else IFS= read -r TOKEN <"$TOKEN_FILE" || true; fi
elif [ -z "$TOKEN" ] && [ -t 0 ]; then
	prompt="hostopsd token from Pim"
	[ -n "$(installed HOSTOPS_TOKEN)" ] && prompt="$prompt (Enter keeps the installed one)"
	IFS= read -r -s -p "$prompt: " TOKEN || true
	echo >&2
elif [ -z "$TOKEN" ]; then
	IFS= read -r TOKEN || true
fi
TOKEN=${TOKEN%$'\r'}
TOKEN=${TOKEN:-$(installed HOSTOPS_TOKEN)}
[ -n "$TOKEN" ] || die "no token: paste it at the prompt, pipe it in, or pass --token-file"
[[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]{16,1024}$ ]] || die "the token has unexpected characters or length"

# --- The user and its directories ------------------------------------------------------------
if ! id hostopsd >/dev/null 2>&1; then
	useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin hostopsd
	echo "created the hostopsd user"
fi
# The docker group is root-equivalent; see README.md. systemd-journal lets `logs hostopsd` read
# its own journal.
usermod -aG docker hostopsd
getent group systemd-journal >/dev/null && usermod -aG systemd-journal hostopsd
install -d -o hostopsd -g hostopsd -m 0750 "$STATE_DIR"
install -d -o root -g hostopsd -m 0750 "$ETC"
as_hostopsd "$NODE_BIN" --version >/dev/null || die "hostopsd cannot run $NODE_BIN (is it under a home directory?); pass --node with a system-wide Node.js"

# --- The checkout ----------------------------------------------------------------------------
# hostopsd checks out commits in it, so it gets read and write access through ACLs, which new
# files inherit; the owner keeps full access to files hostopsd creates.
OWNER=$(stat -c %U "$CHECKOUT")
setfacl -R -m "u:hostopsd:rwX,d:u:hostopsd:rwX,d:u:$OWNER:rwX" "$CHECKOUT"
dir=$(dirname "$CHECKOUT")
while [ "$dir" != / ]; do
	as_hostopsd test -x "$dir" || setfacl -m u:hostopsd:--x "$dir"
	dir=$(dirname "$dir")
done
if ! as_hostopsd git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$CHECKOUT"; then
	as_hostopsd git config --global --add safe.directory "$CHECKOUT"
fi
as_hostopsd git -C "$CHECKOUT" rev-parse --verify --quiet HEAD >/dev/null || die "hostopsd cannot read the git repository in $CHECKOUT"
as_hostopsd env GIT_TERMINAL_PROMPT=0 git -C "$CHECKOUT" ls-remote --quiet origin HEAD >/dev/null ||
	echo "warning: hostopsd cannot reach the checkout's origin remote, so deploy will fail; give it a remote it can fetch without credentials" >&2

# --- The manager's environment ---------------------------------------------------------------
# up.sh and docker compose need the variables the stack was started with.
MANAGER_ENV=${MANAGER_ENV:-$(installed MANAGER_ENV_FILE)}
if [ -z "$MANAGER_ENV" ] && [ -f "$CHECKOUT/sandbox-manager/.env" ]; then MANAGER_ENV=$CHECKOUT/sandbox-manager/.env; fi
if [ -z "$MANAGER_ENV" ]; then
	MANAGER_ENV=$ETC/manager.env
	docker inspect sandbox-manager >/dev/null 2>&1 || die "no manager environment: start the stack with ./up.sh first, or pass --manager-env with MANAGER_TOKEN, PROXY_ADMIN_TOKEN and AGENTD_TOKEN_SECRET"
	KEYS='MANAGER_TOKEN|PROXY_ADMIN_TOKEN|AGENTD_TOKEN_SECRET|ALLOWED_IMAGES|PROBE_IMAGE|MIN_FREE_DISK_PCT|MAX_CONCURRENT|IDLE_MIN|DEFAULT_DISK_MIB|MAX_TOTAL_WORKSPACE_GB|DISK_QUOTA_MODE|DISK_CHECK_SEC|KEPT_VOLUME_DAYS|WORKSPACE_TMPFS|SNAPSHOT_MAX_GB|SNAPSHOT_CACHE_PCT'
	tmp=$(mktemp "$ETC/.manager.env.XXXXXX")
	{
		echo "# Captured from the running sandbox-manager container by install.sh."
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' sandbox-manager | grep -E "^($KEYS)=" || true
		root_host=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/docker-root"}}{{.Source}}{{end}}{{end}}' sandbox-manager)
		[ -n "$root_host" ] && [ "$root_host" != /var/lib/pim-sandbox ] && echo "DOCKER_ROOT_HOST=$root_host"
		port=$(docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{if eq $p "8080/tcp"}}{{(index $b 0).HostPort}}{{end}}{{end}}' sandbox-manager)
		[ -n "$port" ] && [ "$port" != 8080 ] && echo "MANAGER_PORT=$port"
		true
	} >"$tmp"
	chown root:hostopsd "$tmp"
	chmod 0640 "$tmp"
	mv -f "$tmp" "$MANAGER_ENV"
	echo "wrote $MANAGER_ENV from the running manager: $(grep -v '^#' "$MANAGER_ENV" | cut -d= -f1 | tr '\n' ' ')"
fi
grep -q '^MANAGER_TOKEN=.' "$MANAGER_ENV" || die "$MANAGER_ENV has no MANAGER_TOKEN"
as_hostopsd test -r "$MANAGER_ENV" || die "hostopsd cannot read $MANAGER_ENV"
port=$(sed -n 's/^MANAGER_PORT=//p' "$MANAGER_ENV" | tail -n 1)
MANAGER_URL=${MANAGER_URL:-$(installed MANAGER_URL)}
MANAGER_URL=${MANAGER_URL:-http://127.0.0.1:${port:-8080}}

# --- The env file and the unit ---------------------------------------------------------------
umask 077
tmp=$(mktemp "$ETC/.env.XXXXXX")
{
	echo "# Written by sandbox-manager/hostopsd/install.sh; run it again to change these."
	printf 'HOSTOPS_URL=%s\n' "$URL"
	printf 'HOSTOPS_TOKEN=%s\n' "$TOKEN"
	printf 'PIM_CHECKOUT=%s\n' "$CHECKOUT"
	printf 'MANAGER_URL=%s\n' "$MANAGER_URL"
	printf 'MANAGER_ENV_FILE=%s\n' "$MANAGER_ENV"
	printf 'NODE_BIN=%s\n' "$NODE_BIN"
} >"$tmp"
chown root:hostopsd "$tmp"
chmod 0640 "$tmp"
mv -f "$tmp" "$ENV_FILE"
unset TOKEN

install -m 0644 "$SCRIPT_DIR/hostopsd.service" /etc/systemd/system/hostopsd.service
systemctl daemon-reload
systemctl enable --quiet hostopsd
systemctl restart hostopsd
sleep 3
systemctl --no-pager --lines=20 status hostopsd || true
systemctl is-active --quiet hostopsd || die "hostopsd is not running; see journalctl -u hostopsd"
echo "hostopsd is installed and polling $URL"
