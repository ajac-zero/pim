#!/bin/sh
# `docker compose` with this directory's files: the stack alone, or with compose.local.yaml (plain HTTP on 127.0.0.1:8088) when .env's PIM_PUBLIC_URL is http://,
# and with compose.dev.yaml (this checkout's sources) when PIM_DEV=1.   deploy/compose/pim.sh up -d | ps | logs -f gate | restart gate | down
#
#   deploy/compose/pim.sh update [TAG]      pull the published image (TAG: a channel, a version or sha-…; default PIM_CHANNEL from .env, else stable), back up, switch, roll back on failure
#   deploy/compose/pim.sh update --check    say whether a newer image exists for the channel, changing nothing
#   deploy/compose/pim.sh update-web [TAG]  release only the web app: pull the pim-web image of the channel and replace the `web` container, leaving every other service running
# `update` (which moves the web image to the same tag as the backend's) and `update-web` print one JSON line last: {"event":"pim.update","from":…,"to":…,"result":"updated|unchanged|rolled_back|failed"}; it exits non-zero for rolled_back and failed.
set -eu
cd "$(dirname "$0")"
files="-f compose.yaml"
# PIM_LOCAL=1 is for a stack behind a tunnel or portal: an https PIM_PUBLIC_URL, with Caddy still on plain HTTP on 127.0.0.1:8088 (PIM_DOMAIN=:8088).
if grep -q '^PIM_PUBLIC_URL=http://' .env || [ "${PIM_LOCAL:-}" = 1 ]; then files="$files -f compose.local.yaml"; fi
if [ "${PIM_DEV:-}" = 1 ]; then
	# compose.dev.yaml mounts ../../web/dist into the web container; Docker would create a missing one empty and owned by root, and the web host would have no build to publish.
	[ -f ../../web/dist/index.html ] || { echo "PIM_DEV=1 needs the built web app: run pnpm --filter pim-web build first" >&2; exit 1; }
	files="$files -f compose.dev.yaml"
fi
case "${1:-}" in update | update-web) ;; *) exec docker compose $files "$@" ;; esac
command="$1"
shift
env_get() { sed -n "s/^$1=//p" .env | tail -1; }
# Sets KEY=VALUE in .env (replacing the line, or appending one), keeping the file's owner and mode.
env_set() {
	awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; done=1; next} {print} END{if(!done) print k "=" v}' .env > .env.tmp
	cat .env.tmp > .env && rm -f .env.tmp
}
say() { printf '{"event":"pim.update","from":"%s","to":"%s","result":"%s"}\n' "$from" "$to" "$1"; }
repo="$(env_get PIM_REPOSITORY)"; repo="${repo:-ghcr.io/ajac-zero/pim}"
from="$(env_get PIM_IMAGE)"; to="$from"
check=0
if [ "$command" = update ] && [ "${1:-}" = --check ]; then check=1; shift; fi
tag="${1:-$(env_get PIM_CHANNEL)}"; tag="${tag:-stable}"
webrepo="${repo}-web"
web_from="$(env_get PIM_WEB_IMAGE)"; web_from="${web_from:-$webrepo:stable}"
say_web() { printf '{"event":"pim.update.web","from":"%s","to":"%s","result":"%s"}\n' "$web_from" "$web_to" "$1"; }
web_to="$web_from"
[ -n "$from" ] || { echo "PIM_IMAGE is not set in .env" >&2; exit 1; }

# The digest an image reference points at, as this host knows it: pinned in the reference, else the one its pulled copy came from.
local_digest() {
	case "$1" in
		*@sha256:*) echo "sha256:${1##*@sha256:}" ;;
		*) docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n "s|^${1%:*}@||p" | head -1 ;;
	esac
}
# The digest the registry has for repo:tag now, without pulling it.
remote_digest() {
	{ raw="$(docker buildx imagetools inspect --raw "$repo:$tag" 2>/dev/null)" && [ -n "$raw" ] && printf 'sha256:%s\n' "$(printf %s "$raw" | sha256sum | cut -d' ' -f1)"; } \
		|| { docker pull -q "$repo:$tag" >/dev/null 2>&1 && local_digest "$repo:$tag"; }
}

# The web app on its own: nothing but the `web` container is replaced, so no role restarts, no migration runs and no backup is needed. The pages open on the release before it keep
# the scripts they still ask for (the web container keeps earlier releases), and the stack's API, sockets and sessions are untouched.
if [ "$command" = update-web ]; then
	echo "Pulling $webrepo:$tag" >&2
	if ! docker pull -q "$webrepo:$tag" >/dev/null; then echo "cannot pull $webrepo:$tag" >&2; say_web failed; exit 1; fi
	digest="$(local_digest "$webrepo:$tag")"
	[ -n "$digest" ] || { echo "no digest for $webrepo:$tag" >&2; say_web failed; exit 1; }
	web_to="$webrepo:$tag@$digest"
	if [ "$(local_digest "$web_from")" = "$digest" ]; then web_to="$web_from"; say_web unchanged; exit 0; fi
	web_previous="$(env_get PIM_WEB_IMAGE_PREVIOUS)"
	env_set PIM_WEB_IMAGE_PREVIOUS "$web_from"
	env_set PIM_WEB_IMAGE "$web_to"
	echo "Starting $web_to" >&2
	if "$0" up -d --no-deps --wait web >&2; then say_web updated; exit 0; fi
	echo "The new web image did not come up; putting $web_from back" >&2
	env_set PIM_WEB_IMAGE "$web_from"
	env_set PIM_WEB_IMAGE_PREVIOUS "$web_previous"
	"$0" up -d --no-deps --wait web >&2 || echo "the previous web image did not come up either; check pim.sh ps and logs web" >&2
	say_web rolled_back
	exit 1
fi

if [ "$check" = 1 ]; then
	latest="$(remote_digest)" || latest=""
	[ -n "$latest" ] || { echo "cannot reach $repo:$tag" >&2; exit 1; }
	have="$(local_digest "$from")"
	if [ "$have" = "$latest" ]; then avail=false; else avail=true; fi
	printf '{"event":"pim.update.check","channel":"%s","current":"%s","latest":"%s@%s","available":%s}\n' "$tag" "$from" "$repo:$tag" "$latest" "$avail"
	exit 0
fi

echo "Pulling $repo:$tag" >&2
if ! docker pull -q "$repo:$tag" >/dev/null; then echo "cannot pull $repo:$tag" >&2; say failed; exit 1; fi
digest="$(local_digest "$repo:$tag")"
[ -n "$digest" ] || { echo "no digest for $repo:$tag" >&2; say failed; exit 1; }
to="$repo:$tag@$digest"
if [ "$(local_digest "$from")" = "$digest" ]; then to="$from"; say unchanged; exit 0; fi

# The web image follows the same tag: the backend and the interface of one release are updated together, and `update-web` moves the interface alone.
docker pull -q "$webrepo:$tag" >/dev/null || { echo "cannot pull $webrepo:$tag" >&2; say failed; exit 1; }
web_to="$webrepo:$tag@$(local_digest "$webrepo:$tag")"

# The pim-computer image follows the same tag when the local-computer profile is in use.
computer="$(env_get PIM_COMPUTER_URL)"
if [ -n "$computer" ]; then
	crepo="${repo}-computer"
	docker pull -q "$crepo:$tag" >/dev/null || { echo "cannot pull $crepo:$tag" >&2; say failed; exit 1; }
fi

# Migrations cannot be undone, so the data is saved before anything changes. The stack must be running for the backup to read it.
backups="$(env_get PIM_BACKUP_DIR)"; backups="${backups:-$PWD/backups}"
echo "Backing up to $backups" >&2
if ! ../../scripts/v2-backup/compose-backup.sh "$backups" >&2; then echo "backup failed; nothing was changed" >&2; say failed; exit 1; fi
# Update backups older than PIM_BACKUP_KEEP_DAYS (14 by default; 0 keeps them all) go once a new one has been taken. Only directories named
# like a backup's stamp are touched, and the newest one is always kept.
keep="$(env_get PIM_BACKUP_KEEP_DAYS)"; keep="${keep:-14}"
if [ "$keep" -gt 0 ] 2>/dev/null; then
	newest="$(ls -1d "$backups"/[0-9]*T[0-9]*Z 2>/dev/null | sort | tail -1)"
	find "$backups" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T[0-9]*Z' -mtime +"$keep" ! -path "$newest" -print -exec rm -rf {} + >&2
fi

previous="$(env_get PIM_IMAGE_PREVIOUS)"
previous_computer="$(env_get PIM_COMPUTER_IMAGE)"
web_previous="$(env_get PIM_WEB_IMAGE_PREVIOUS)"
env_set PIM_IMAGE_PREVIOUS "$from"
env_set PIM_IMAGE "$to"
env_set PIM_WEB_IMAGE_PREVIOUS "$web_from"
env_set PIM_WEB_IMAGE "$web_to"
if [ -n "$computer" ]; then env_set PIM_COMPUTER_IMAGE "$crepo:$tag@$(local_digest "$crepo:$tag")"; fi
echo "Starting $to" >&2
if "$0" up -d --wait >&2; then say updated; exit 0; fi

echo "The new image did not come up; putting $from back" >&2
env_set PIM_IMAGE "$from"
env_set PIM_IMAGE_PREVIOUS "$previous"
env_set PIM_WEB_IMAGE "$web_from"
env_set PIM_WEB_IMAGE_PREVIOUS "$web_previous"
env_set PIM_COMPUTER_IMAGE "$previous_computer"
"$0" up -d --wait >&2 || echo "the previous image did not come up either; check pim.sh ps and logs" >&2
say rolled_back
exit 1
