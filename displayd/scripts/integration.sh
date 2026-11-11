#!/usr/bin/env bash
# Checks on a real host, with real Xvnc, that two displays are isolated from each other. Not run
# in CI: it needs Xvnc, openbox, xdotool, xclip, curl and jq, and a running displayd.
#
#   DISPLAYD_TOKEN=... displayd/scripts/integration.sh        # DISPLAYD_URL defaults to http://127.0.0.1:9900
#
# It acquires displays for two throwaway threads, checks what is below, and releases them.
#   1. each display answers with its own DISPLAY, cookie, bus address and VNC port
#   2. the X cookie of A does not open B, and the VNC ports listen on loopback only
#   3. xdotool moving the pointer in A leaves B's pointer where it was
#   4. a clipboard set with xclip in A is not seen in B
#   5. after release the context directories and processes are gone
set -euo pipefail
URL=${DISPLAYD_URL:-http://127.0.0.1:9900}
: "${DISPLAYD_TOKEN:?set DISPLAYD_TOKEN}"
for cmd in curl jq xdotool xclip; do command -v "$cmd" >/dev/null || { echo "missing $cmd" >&2; exit 2; }; done

fails=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
api() { # method path [json]
	curl -fsS --max-time 90 -X "$1" -H "authorization: Bearer $DISPLAYD_TOKEN" -H 'content-type: application/json' ${3:+-d "$3"} "$URL$2"
}
RUN=$$
A=itest-a-$RUN
B=itest-b-$RUN
cleanup() {
	api POST /release "{\"threadId\":\"$A\"}" >/dev/null 2>&1 || true
	api POST /release "{\"threadId\":\"$B\"}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Acquire and wait (displayd starts one display at a time, so wait for each in turn).
acquire() {
	local lease state
	for _ in $(seq 60); do
		lease=$(api POST /acquire "{\"threadId\":\"$1\",\"spaceId\":\"itest\",\"waitMs\":5000}" | jq -c .lease)
		state=$(jq -r .state <<<"$lease")
		[ "$state" = active ] && { echo "$lease"; return; }
	done
	echo "display for $1 never became active (state $state)" >&2
	exit 1
}
LA=$(acquire "$A")
LB=$(acquire "$B")
# In a subshell with a display's environment: run it with `on A|B cmd...`.
env_of() { jq -r '.env | to_entries[] | "export \(.key)=\(.value|@sh)"' <<<"$1"; }
on() { local which=$1 lease; shift; [ "$which" = A ] && lease=$LA || lease=$LB; (eval "$(env_of "$lease")"; "$@"); }

echo "A: $(jq -c '{display,vncPort,cdpPort}' <<<"$LA")  B: $(jq -c '{display,vncPort,cdpPort}' <<<"$LB")"
for f in display vncPort cdpPort id; do
	[ "$(jq -r ".$f" <<<"$LA")" != "$(jq -r ".$f" <<<"$LB")" ] && ok "$f differs" || bad "$f is shared"
done
for k in XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR; do
	[ "$(jq -r ".env.$k" <<<"$LA")" != "$(jq -r ".env.$k" <<<"$LB")" ] && ok "$k differs" || bad "$k is shared"
done
[ "$(stat -c %a "$(dirname "$(jq -r .env.XAUTHORITY <<<"$LA")")")" = 700 ] && ok "context dir is 0700" || bad "context dir is not 0700"
[ "$(stat -c %a "$(jq -r .env.XAUTHORITY <<<"$LA")")" = 600 ] && ok "cookie is 0600" || bad "cookie is not 0600"

# 2. A's cookie does not open B's display; the VNC ports are loopback only.
DB=$(jq -r .env.DISPLAY <<<"$LB")
if DISPLAY=$DB XAUTHORITY=$(jq -r .env.XAUTHORITY <<<"$LA") xdotool getmouselocation >/dev/null 2>&1; then bad "A's cookie opened B's display"; else ok "A's cookie is refused by B"; fi
for L in "$LA" "$LB"; do
	port=$(jq -r .vncPort <<<"$L")
	listen=$(ss -ltnH "sport = :$port" | awk '{print $4}')
	[[ "$listen" == 127.0.0.1:* && $(wc -l <<<"$listen") = 1 ]] && ok "VNC $port listens on loopback only" || bad "VNC $port listens on: $listen"
done
for L in "$LA" "$LB"; do
	d=$(jq -r .display <<<"$L")
	ss -ltnH | awk '{print $4}' | grep -qE ":$((6000 + d))$" && bad "X listens on TCP for :$d" || ok "no TCP X for :$d"
done

# 3. Pointer isolation.
on B xdotool mousemove 600 600
before=$(on B xdotool getmouselocation)
on A xdotool mousemove 10 20
sleep 0.3
[ "$(on A xdotool getmouselocation | cut -d' ' -f1-2)" = "x:10 y:20" ] && ok "A's pointer moved" || bad "A's pointer did not move"
[ "$(on B xdotool getmouselocation)" = "$before" ] && ok "B's pointer unchanged" || bad "B's pointer moved with A's"

# 4. Clipboard isolation.
secret=secret-$RUN
printf '%s' "$secret" | on A xclip -selection clipboard -i
sleep 0.3
[ "$(on A xclip -selection clipboard -o 2>/dev/null)" = "$secret" ] && ok "A reads its own clipboard" || bad "A cannot read its own clipboard"
seen=$(on B timeout 3 xclip -selection clipboard -o 2>/dev/null || true)
[ "$seen" != "$secret" ] && ok "B does not see A's clipboard" || bad "B sees A's clipboard"

# 5. Release.
DIRA=$(dirname "$(jq -r .env.XAUTHORITY <<<"$LA")")
api POST /release "{\"threadId\":\"$A\"}" >/dev/null
api POST /release "{\"threadId\":\"$B\"}" >/dev/null
[ ! -e "$DIRA" ] && ok "A's context directory is gone" || bad "A's context directory remains"
ss -ltnH "sport = :$(jq -r .vncPort <<<"$LA")" | grep -q . && bad "A's VNC port still listens" || ok "A's VNC port is closed"

[ "$fails" = 0 ] && echo "all checks passed" || { echo "$fails check(s) failed"; exit 1; }
