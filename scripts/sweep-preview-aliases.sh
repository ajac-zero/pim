#!/usr/bin/env bash
# Delete Workers Builds preview aliases of the `pim` Worker whose branch no longer exists on GitHub.
# Every preview owns its own Durable Object namespaces (~8 each) and the account caps them at 500, so stale
# previews block production deploys (error 10067). Dry run unless called with --apply.
# Needs: wrangler (logged in), gh (logged in), curl, python3. CLOUDFLARE_ACCOUNT_ID may be set; else wrangler's.
set -euo pipefail
REPO=${REPO:-ajac-zero/pim}; WORKER=${WORKER:-pim}; APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
ACCT=${CLOUDFLARE_ACCOUNT_ID:-$(wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}
TOKEN=${CLOUDFLARE_API_TOKEN:-$(grep -E '^oauth_token' ~/.config/.wrangler/config/default.toml | sed 's/.*= *"\(.*\)"/\1/')}
branches=$(gh api --paginate "repos/$REPO/branches?per_page=100" -q '.[].name')
namespaces=$(curl -fsS -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/durable_objects/namespaces?per_page=1000")
BRANCHES="$branches" NS="$namespaces" WORKER="$WORKER" python3 - <<'PY' > /tmp/stale-previews.txt
import json, os, re
alive = {re.sub(r'[^a-z0-9]+', '-', b.lower()).strip('-') for b in os.environ['BRANCHES'].split('\n') if b}
stale = set()
for n in json.loads(os.environ['NS'])['result']:
    if n.get('script') != os.environ['WORKER']: continue
    m = re.match(re.escape(os.environ['WORKER']) + r'_(.+)_[A-Za-z]+$', n['name'])   # <worker>_<alias>_<Class>
    if not m: continue
    alias = m.group(1)
    # Aliases are branch names with other characters as '-', cut to a length limit.
    if not any(a == alias or a.startswith(alias) for a in alive): stale.add(alias)
print('\n'.join(sorted(stale)))
PY
echo "$(grep -c . /tmp/stale-previews.txt || true) stale preview alias(es):"; cat /tmp/stale-previews.txt
[ $APPLY = 1 ] || { echo "(dry run; pass --apply to delete)"; exit 0; }
while read -r alias; do [ -n "$alias" ] && wrangler preview delete --name "$alias" --worker-name "$WORKER"; done < /tmp/stale-previews.txt
