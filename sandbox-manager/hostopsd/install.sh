#!/usr/bin/env bash
# Installs or updates hostopsd on the Pim host. sandbox-manager/up.sh runs it (through sudo) when
# hostopsd is missing or out of date, so there is normally nothing to run by hand. It must run as
# root; running it again is safe and keeps what it set up before, the credential included.
#
#   sudo sandbox-manager/hostopsd/install.sh --url https://pim.example.com
#
# Without a credential it enrolls with Pim, using the sandbox manager's MANAGER_TOKEN, and stores
# the credential it gets only in /etc/hostopsd/env. It enrolls again when Pim rejects the
# installed one (401). When Pim answers 403 the admin revoked hostopsd in Settings: the unit is
# installed but not started, and nothing is retried. A credential can still be given with
# --token-file (a path, or "-" for stdin). Credentials are never accepted on the command line,
# where `ps` would show them, and never printed.
#
# Options, each also taken from the environment variable in brackets:
#   --url URL            [HOSTOPS_URL] Pim's https origin
#   --token-file PATH    [HOSTOPS_TOKEN_FILE] file holding a credential, or - for stdin
#                        (optional: without one the installer enrolls)
#   --checkout PATH      [PIM_CHECKOUT] the Pim checkout (default: the one holding this script)
#   --manager-env PATH   [MANAGER_ENV_FILE] the sandbox manager's environment: MANAGER_TOKEN,
#                        PROXY_ADMIN_TOKEN, ... (default: sandbox-manager/.env if it exists,
#                        otherwise captured from the running sandbox-manager container)
#   --manager-url URL    [MANAGER_URL] default http://127.0.0.1:$MANAGER_PORT (8080)
#   --node PATH          [NODE_BIN] Node.js 22 or later (default: found on the host, else the
#                        official Node.js 22 is installed in /opt/hostopsd)
set -euo pipefail

die() {
	echo "install.sh: $*" >&2
	exit 1
}
[ "$(id -u)" = 0 ] || die "run it with sudo"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Finding, and when there is none, installing the Node.js hostopsd runs; see node.sh.
source "$SCRIPT_DIR/node.sh"
# The locations can be moved only so the tests can run this script without touching the system.
ETC=${HOSTOPSD_ETC:-/etc/hostopsd}
ENV_FILE=$ETC/env
# Which install.sh and unit are installed, readable by everyone, so up.sh can tell when to run
# this again without being root. It holds no secret.
STAMP=$ETC/installed
STATE_DIR=${HOSTOPSD_STATE_DIR:-/var/lib/hostopsd}
UNIT_DIR=${HOSTOPSD_UNIT_DIR:-/etc/systemd/system}
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
# The host may have no Node.js at all: the manager runs in Docker, and the invoking user's node is
# usually nvm's, under a home directory root's PATH does not see. So an explicit --node must work;
# otherwise look in the usual places (the invoking user's nvm, the system-wide ones and the copy in
# $NODE_DIR an earlier run left); otherwise install the official Node.js 22, checking its SHA256
# against SHASUMS256.txt. The binary is made executable by the hostopsd user below.
NODE_DIR=${HOSTOPSD_NODE_DIR:-/opt/hostopsd}
NODE_DIST=${HOSTOPSD_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}
if [ -n "$NODE_BIN" ]; then
	[ -x "$NODE_BIN" ] || die "--node $NODE_BIN is not executable"
	node_is_new_enough "$NODE_BIN" || die "$NODE_BIN is Node.js $(node_major "$NODE_BIN"); hostopsd needs $NODE_MIN_MAJOR or later"
else
	NODE_BIN=$(pick_node "$(command -v node 2>/dev/null || true)" "$(nvm_node "${SUDO_USER:-}")" \
		${HOSTOPSD_NODE_FALLBACKS:-/usr/local/bin/node /usr/bin/node} "$NODE_DIR/node" || true)
	if [ -z "$NODE_BIN" ]; then
		echo "install.sh: no Node.js $NODE_MIN_MAJOR or later on this host; installing the official Node.js 22 in $NODE_DIR"
		NODE_BIN=$(install_node_tarball "$NODE_DIST" "$NODE_DIR") || die "could not install Node.js 22 from $NODE_DIST; install Node.js 22 or later and pass --node /path/to/node"
	fi
fi

URL=${URL:-$(installed HOSTOPS_URL)}
URL=${URL%/}
[[ "$URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "give Pim's origin with --url https://... (got '${URL}')"

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
# The directory is open for traversal so up.sh can read the stamp; the files in it stay 0640.
install -d -o root -g hostopsd -m 0755 "$ETC"
# hostopsd must be able to execute the node binary, which one under the invoking user's home
# directory (nvm's usual place) may well not be: test -x as hostopsd also proves it can traverse
# every directory on the way to it. A node in a home directory is copied to the root-owned
# $NODE_DIR regardless, so the unit does not depend on the invoking user's files.
invoker_home=
[ -n "${SUDO_USER:-}" ] && invoker_home=$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || true)
if [[ "$NODE_BIN" == /home/* || ( -n "$invoker_home" && "$NODE_BIN" == "$invoker_home"* ) ]] || ! as_hostopsd test -x "$NODE_BIN"; then
	if [ "$NODE_BIN" != "$NODE_DIR/node" ]; then
		echo "install.sh: copying $NODE_BIN to $NODE_DIR/node so hostopsd can run it"
		install -d -m 0755 "$NODE_DIR"
		install -m 0755 "$NODE_BIN" "$NODE_DIR/node"
		NODE_BIN=$NODE_DIR/node
	fi
fi
as_hostopsd "$NODE_BIN" --version >/dev/null || die "hostopsd cannot run $NODE_BIN"

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

# --- The credential ---------------------------------------------------------------------------
# Requests to Pim take their Authorization header from a curl config on stdin, so no secret is
# ever on a command line. Prints the HTTP status (000 when Pim cannot be reached); the body goes
# to $RESPONSE.
RESPONSE=$(mktemp)
trap 'rm -f "$RESPONSE"' EXIT
pim_post() { # path bearer body
	local status
	status=$(printf 'header = "Authorization: Bearer %s"\n' "$2" |
		curl --silent --show-error --max-time 30 --config - --output "$RESPONSE" --write-out '%{http_code}' \
			--request POST --header 'content-type: application/json' --data "$3" "$URL$1" 2>/dev/null) || true
	echo "${status:-000}"
}

TOKEN=${HOSTOPS_TOKEN:-}
if [ -z "$TOKEN" ] && [ -n "$TOKEN_FILE" ]; then
	if [ "$TOKEN_FILE" = - ]; then IFS= read -r TOKEN || true; else IFS= read -r TOKEN <"$TOKEN_FILE" || true; fi
fi
TOKEN=${TOKEN%$'\r'}
HOW="kept the installed credential"
REVOKED=0
if [ -n "$TOKEN" ]; then
	HOW="installed the given credential"
else
	TOKEN=$(installed HOSTOPS_TOKEN)
	if [ -n "$TOKEN" ] && [ "$(pim_post /api/hostops/agent/poll "$TOKEN" '{"agentVersion":"install","commit":"","waitMs":0}')" = 401 ]; then
		echo "the installed credential was rejected by Pim (401); enrolling again"
		TOKEN=
	fi
	if [ -z "$TOKEN" ]; then
		MANAGER_TOKEN=$(sed -n 's/^MANAGER_TOKEN=//p' "$MANAGER_ENV" | tail -n 1)
		[[ "$MANAGER_TOKEN" =~ ^[A-Za-z0-9._~+/=-]{8,1024}$ ]] || die "MANAGER_TOKEN in $MANAGER_ENV has unexpected characters or length"
		status=$(pim_post /api/hostops/agent/enroll "$MANAGER_TOKEN" '{}')
		unset MANAGER_TOKEN
		case "$status" in
		201)
			TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RESPONSE" | head -n 1)
			[ -n "$TOKEN" ] || die "Pim enrolled hostopsd but its answer has no token"
			HOW="enrolled with Pim"
			;;
		403)
			REVOKED=1
			HOW="credential revoked in Pim's Settings"
			;;
		401) die "Pim rejected MANAGER_TOKEN (401) when enrolling hostopsd; is $MANAGER_ENV the manager's current environment?" ;;
		404) die "$URL does not support enrolling hostopsd (404); update Pim, or give a credential with --token-file" ;;
		000) die "could not reach $URL to enroll hostopsd" ;;
		*) die "Pim answered $status when enrolling hostopsd" ;;
		esac
	fi
fi
if [ "$REVOKED" = 0 ]; then
	[[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]{16,1024}$ ]] || die "the credential has unexpected characters or length"
fi

# --- The env file and the unit ---------------------------------------------------------------
umask 077
tmp=$(mktemp "$ETC/.env.XXXXXX")
{
	echo "# Written by sandbox-manager/hostopsd/install.sh; run it again to change these."
	printf 'HOSTOPS_URL=%s\n' "$URL"
	[ "$REVOKED" = 1 ] || printf 'HOSTOPS_TOKEN=%s\n' "$TOKEN"
	printf 'PIM_CHECKOUT=%s\n' "$CHECKOUT"
	printf 'MANAGER_URL=%s\n' "$MANAGER_URL"
	printf 'MANAGER_ENV_FILE=%s\n' "$MANAGER_ENV"
	printf 'NODE_BIN=%s\n' "$NODE_BIN"
} >"$tmp"
chown root:hostopsd "$tmp"
chmod 0640 "$tmp"
mv -f "$tmp" "$ENV_FILE"
unset TOKEN

install -m 0644 "$SCRIPT_DIR/hostopsd.service" "$UNIT_DIR/hostopsd.service"
tmp=$(mktemp "$ETC/.installed.XXXXXX")
{
	echo "INSTALL_SHA=$(sha256sum <"$SCRIPT_DIR/install.sh" | cut -d' ' -f1)"
	echo "UNIT_SHA=$(sha256sum <"$SCRIPT_DIR/hostopsd.service" | cut -d' ' -f1)"
	echo "HOSTOPS_URL=$URL"
	echo "PIM_CHECKOUT=$CHECKOUT"
	[ "$REVOKED" = 1 ] && echo "REVOKED=1"
	true
} >"$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$STAMP"
systemctl daemon-reload
systemctl enable --quiet hostopsd
if [ "$REVOKED" = 1 ]; then
	systemctl stop hostopsd 2>/dev/null || true
	echo "hostopsd is installed but not running: its credential was revoked in Pim's Settings, so it stays stopped. Re-enable it there, then run: sudo $SCRIPT_DIR/install.sh"
	exit 0
fi
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart hostopsd
# End to end: the daemon logs "polling" once it starts, and "rejected" when Pim refuses its credential.
for _ in 1 2 3 4 5 6 7 8 9 10; do
	journal=$(journalctl -u hostopsd --since "$since" --no-pager -o cat 2>/dev/null || true)
	if grep -q ' polling ' <<<"$journal" || grep -q 'rejected HOSTOPS_TOKEN' <<<"$journal"; then break; fi
	sleep 1
done
systemctl is-active --quiet hostopsd || die "hostopsd is not running; see journalctl -u hostopsd"
grep -q 'rejected HOSTOPS_TOKEN' <<<"$journal" && die "hostopsd is running but Pim rejects its credential; see journalctl -u hostopsd"
grep -q ' polling ' <<<"$journal" || die "hostopsd started but has not begun polling Pim yet; see journalctl -u hostopsd"
echo "hostopsd: $HOW, running and polling $URL"
