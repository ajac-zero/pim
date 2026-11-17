#!/bin/sh
# Writes deploy/compose/.env from env.example with every CHANGE_ME replaced by a fresh random value, once: an existing .env is never overwritten,
# because its keys open what is already stored (PIM_KEK_K1 above all) and every browser's push subscription is bound to the VAPID public key. Back the file up with the database backups.
#
#   deploy/compose/init-env.sh https://pim.example.com                  # a public deployment: Caddy gets certificates for that host
#   deploy/compose/init-env.sh http://localhost:8088 --image pim:v2      # a trial on this machine, plain HTTP on port 8088 (compose.local.yaml)
set -eu
cd "$(dirname "$0")"
[ -e .env ] && { echo ".env exists; not overwriting it" >&2; exit 1; }
url="${1:?usage: init-env.sh <public URL> [--image <image>]}"
image="pim:v2"
[ "${2:-}" = "--image" ] && image="${3:?}"
host="$(printf %s "$url" | sed -E 's|^[a-z]+://||; s|/.*$||')"
name="${host%%:*}"
scheme="${url%%://*}"
rand() { node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))' 2>/dev/null || openssl rand -hex 24; }
kek() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' 2>/dev/null || openssl rand -base64 32; }
# The Web Push key pair (VAPID, ES256): the public point and the private scalar, base64url. Without node, push stays off until the two variables are set by hand.
vapid="$(node -e 'const e=require("crypto").createECDH("prime256v1");e.generateKeys();process.stdout.write(e.getPublicKey().toString("base64url")+" "+e.getPrivateKey().toString("base64url"))' 2>/dev/null || true)"
umask 077
while IFS= read -r line; do
	case "$line" in
		PIM_KEK_K1=CHANGE_ME) echo "PIM_KEK_K1=$(kek)" ;;
		PIM_VAPID_PUBLIC_KEY=) echo "PIM_VAPID_PUBLIC_KEY=${vapid%% *}" ;;
		PIM_VAPID_PRIVATE_KEY=) echo "PIM_VAPID_PRIVATE_KEY=${vapid#* }" ;;
		*=CHANGE_ME) echo "${line%%=*}=$(rand)" ;;
		PIM_IMAGE=*) echo "PIM_IMAGE=$image" ;;
		PIM_PUBLIC_URL=*) echo "PIM_PUBLIC_URL=$url" ;;
		PIM_DOMAIN=*) if [ "$scheme" = http ]; then echo "PIM_DOMAIN=:${host##*:}"; else echo "PIM_DOMAIN=$host"; fi ;;
		PIM_CONTENT_DOMAIN=*) if [ "$scheme" = http ]; then echo "PIM_CONTENT_DOMAIN=http://content.$host"; else echo "PIM_CONTENT_DOMAIN=content.$host"; fi ;;
		PIM_CONTENT_ORIGIN=*) echo "PIM_CONTENT_ORIGIN=$scheme://content.$host" ;;
		PIM_APPS_DOMAIN=*) echo "PIM_APPS_DOMAIN=apps.$name" ;;
		PIM_APPS_ORIGIN=*) echo "PIM_APPS_ORIGIN=$scheme://apps.$host" ;;
		*) echo "$line" ;;
	esac
done < env.example > .env
[ "$scheme" = http ] && echo "PIM_APPS_SITE=http://*.apps.$host" >> .env
echo "Wrote $(pwd)/.env for $url. Keep a copy of it with your backups: without PIM_KEK_K1 sealed keys cannot be opened."
