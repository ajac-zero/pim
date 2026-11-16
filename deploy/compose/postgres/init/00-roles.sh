#!/bin/sh
# Runs once, on an empty data directory, before anything connects. It creates what 0001_foundation.sql (@pim/v2-contracts) expects to find or may create itself:
#   - the five NOLOGIN process roles pim_gate, pim_runtime, pim_live, pim_forge, pim_maintenance (0001 creates any that are missing, so these are the same roles);
#   - one login per process kind, a member of its role and nothing else, with a connection limit and the statement timeout that process kind has in DEFAULT_POOL_BUDGETS;
#   - pim_migrator, the only role that owns schema objects and runs migrations; and pgbouncer_auth, which may only look up password hashes.
# No login is superuser or BYPASSRLS: row-level security policies on owner_id = public.pim_current_owner_id() bind every process role.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE pim_gate NOLOGIN;
CREATE ROLE pim_runtime NOLOGIN;
CREATE ROLE pim_live NOLOGIN;
CREATE ROLE pim_forge NOLOGIN;
CREATE ROLE pim_maintenance NOLOGIN;

CREATE ROLE pim_migrator LOGIN PASSWORD '${PIM_MIGRATOR_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE pim_gate_login LOGIN PASSWORD '${PIM_GATE_DB_PASSWORD}' IN ROLE pim_gate NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB CONNECTION LIMIT 60;
CREATE ROLE pim_runtime_login LOGIN PASSWORD '${PIM_RUNTIME_DB_PASSWORD}' IN ROLE pim_runtime NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB CONNECTION LIMIT 80;
CREATE ROLE pim_live_login LOGIN PASSWORD '${PIM_LIVE_DB_PASSWORD}' IN ROLE pim_live NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB CONNECTION LIMIT 40;
CREATE ROLE pim_forge_login LOGIN PASSWORD '${PIM_FORGE_DB_PASSWORD}' IN ROLE pim_forge NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB CONNECTION LIMIT 30;
CREATE ROLE pim_maintenance_login LOGIN PASSWORD '${PIM_MAINTENANCE_DB_PASSWORD}' IN ROLE pim_maintenance NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB CONNECTION LIMIT 8;
CREATE ROLE pgbouncer_auth LOGIN PASSWORD '${PGBOUNCER_AUTH_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

-- Statement timeouts follow DEFAULT_POOL_BUDGETS: foreground 10 s (Gate, Live), runtime 30 s, forge 30 s, maintenance 600 s.
ALTER ROLE pim_gate_login SET statement_timeout = '10s';
ALTER ROLE pim_live_login SET statement_timeout = '10s';
ALTER ROLE pim_runtime_login SET statement_timeout = '30s';
ALTER ROLE pim_forge_login SET statement_timeout = '30s';
ALTER ROLE pim_maintenance_login SET statement_timeout = '600s';
ALTER ROLE pim_gate_login SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE pim_runtime_login SET idle_in_transaction_session_timeout = '30s';

-- Only the migrator creates objects.
REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO pim_migrator, pim_gate_login, pim_runtime_login, pim_live_login, pim_forge_login, pim_maintenance_login, pgbouncer_auth;
GRANT CREATE ON DATABASE ${POSTGRES_DB} TO pim_migrator;
-- 0001 creates public.pim_schema_migrations and public.pim_current_owner_id() as the migrator.
GRANT USAGE, CREATE ON SCHEMA public TO pim_migrator;
GRANT USAGE ON SCHEMA public TO pim_gate, pim_runtime, pim_live, pim_forge, pim_maintenance;

-- PgBouncer's auth lookup: a function that returns one role's hash and nothing else.
CREATE SCHEMA pgbouncer AUTHORIZATION postgres;
CREATE FUNCTION pgbouncer.get_auth(p_usename TEXT) RETURNS TABLE(usename name, passwd text) AS
\$\$ SELECT usename::name, passwd::text FROM pg_catalog.pg_shadow WHERE usename = p_usename \$\$
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog;
REVOKE ALL ON FUNCTION pgbouncer.get_auth(TEXT) FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(TEXT) TO pgbouncer_auth;
SQL
