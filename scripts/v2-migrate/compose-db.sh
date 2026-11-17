#!/usr/bin/env bash
# Opens the Compose stack's PostgreSQL on 127.0.0.1:55432 (a socat container on the stack's network; stop it with `docker rm -f pim-db-forward`) and prints the superuser's URL, so that
# `verify-v2.mjs --database-url "$(scripts/v2-migrate/compose-db.sh)"` can also check the database's own view: the explicit settings, and that no credential is in clear anywhere.
set -euo pipefail
ENV="$(cd "$(dirname "$0")/../../deploy/compose" && pwd)/.env"
PASSWORD="$(grep '^POSTGRES_SUPERUSER_PASSWORD=' "$ENV" | cut -d= -f2-)"
docker rm -f pim-db-forward >/dev/null 2>&1 || true
docker run -d --name pim-db-forward --network pim_internal -p 127.0.0.1:55432:5432 alpine/socat tcp-listen:5432,fork,reuseaddr tcp-connect:postgres:5432 >/dev/null
sleep 1
echo "postgres://postgres:${PASSWORD}@127.0.0.1:55432/pim"
