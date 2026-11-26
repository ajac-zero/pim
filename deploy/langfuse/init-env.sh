#!/bin/sh
# Makes this stack's .env with random secrets (never reused from Pim's), an admin login, and a Langfuse project key pair, then prints what Pim's own .env needs to send its traces here.
# Refuses to overwrite an existing .env: the secrets in it belong to the data already in the volumes.   ./init-env.sh [admin-email]
set -eu
cd "$(dirname "$0")"
[ ! -e .env ] || { echo ".env already exists; remove it only together with the volumes it belongs to (docker compose down -v)" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is needed to make secrets" >&2; exit 1; }
hex() { openssl rand -hex "$1"; }
public="pk-lf-$(openssl rand -hex 16)"
secret="sk-lf-$(openssl rand -hex 16)"
admin_password="$(hex 12)"
umask 077
cat > .env <<ENV
# Written by init-env.sh. Secrets: keep this file private and with the backups of the volumes.
LANGFUSE_URL=http://localhost:3100
LANGFUSE_BIND=127.0.0.1
LANGFUSE_PORT=3100
LANGFUSE_NEXTAUTH_SECRET=$(hex 32)
LANGFUSE_SALT=$(hex 32)
LANGFUSE_ENCRYPTION_KEY=$(hex 32)
LANGFUSE_POSTGRES_PASSWORD=$(hex 24)
LANGFUSE_CLICKHOUSE_PASSWORD=$(hex 24)
LANGFUSE_REDIS_PASSWORD=$(hex 24)
LANGFUSE_MINIO_PASSWORD=$(hex 24)
LANGFUSE_ADMIN_EMAIL=${1:-admin@pim.invalid}
LANGFUSE_ADMIN_PASSWORD=$admin_password
LANGFUSE_PUBLIC_KEY=$public
LANGFUSE_SECRET_KEY=$secret
ENV
auth="$(printf '%s:%s' "$public" "$secret" | openssl base64 -A)"
echo "Wrote $(pwd)/.env (mode 600). Sign in to Langfuse with ${1:-admin@pim.invalid} and the LANGFUSE_ADMIN_PASSWORD in it."
echo
echo "Add to Pim's .env (deploy/compose/.env), then restart the runner:"
echo "OTEL_EXPORTER_OTLP_ENDPOINT=http://langfuse-web:3000/api/public/otel"
echo "OTEL_EXPORTER_OTLP_HEADERS=\"Authorization=Basic $auth,x-langfuse-ingestion-version=4\""
