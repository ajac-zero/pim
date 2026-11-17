#!/bin/sh
# Pairs and runs the stack's own computer (Compose profile `local-computer`): a container beside the stack that dials out to it like any computer.
#
#   deploy/compose/pim-computer.sh pimc_...          # a token from Settings → Computer ("Connect a computer")
#   PIM_API_TOKEN=pim_... deploy/compose/pim-computer.sh   # or pair with a personal API token (POST /api/computer; replaces the person's computer)
#   deploy/compose/pim-computer.sh stop              # stop it (the token stays in .env; `down` is not needed)
#
# It writes PIM_COMPUTER_URL and PIM_COMPUTER_TOKEN into deploy/compose/.env, builds the computer's image (deploy/Dockerfile.computer) and starts it,
# then waits until it is connected. The container gets no database, NATS, object-store or key credentials: `.env` is not its env_file.
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo "No deploy/compose/.env: run deploy/compose/init-env.sh first." >&2; exit 1; }
if [ "${1:-}" = stop ]; then ./pim.sh --profile local-computer stop pim-computer; exit 0; fi
public=$(sed -n 's/^PIM_PUBLIC_URL=//p' .env)
case "$public" in
	http://*) url=http://caddy:8088; alias= ;;   # the plain-HTTP trial stack: Caddy on the computer's own network
	*) url=$public; alias=${public#*://}; alias=${alias%%[:/]*} ;;
esac
token=${1:-}
if [ -z "$token" ]; then
	[ -n "${PIM_API_TOKEN:-}" ] || { echo "Give a pimc_ token (Settings → Computer → Connect a computer) or set PIM_API_TOKEN to pair one." >&2; exit 1; }
	origin=$public
	token=$(curl -fsS -X POST -H "authorization: Bearer $PIM_API_TOKEN" -H "origin: $origin" -H 'content-type: application/json' -d '{}' "$origin/api/computer" | sed -n 's/.*"token":"\(pimc_[^"]*\)".*/\1/p')
	[ -n "$token" ] || { echo "Pairing at $origin/api/computer gave no token." >&2; exit 1; }
fi
case "$token" in pimc_*) ;; *) echo "That is not a pimc_ token." >&2; exit 1 ;; esac
tmp=$(mktemp)
grep -v '^PIM_COMPUTER_\(URL\|TOKEN\|HOST_ALIAS\)=' .env > "$tmp" || true
printf 'PIM_COMPUTER_URL=%s\nPIM_COMPUTER_TOKEN=%s\n' "$url" "$token" >> "$tmp"
[ -z "$alias" ] || printf 'PIM_COMPUTER_HOST_ALIAS=%s\n' "$alias" >> "$tmp"
cat "$tmp" > .env && rm -f "$tmp"
./pim.sh --profile local-computer up -d --build --force-recreate pim-computer
for _ in $(seq 1 60); do
	if ./pim.sh --profile local-computer logs --no-log-prefix pim-computer 2>&1 | grep -q 'Connected to'; then echo "Connected: Settings → Computer shows it online."; exit 0; fi
	sleep 1
done
echo "Not connected after a minute; see: deploy/compose/pim.sh --profile local-computer logs pim-computer" >&2
exit 1
