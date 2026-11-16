#!/bin/sh
# Creates the scoped roles before anything else connects. Runs once, on an empty data directory.
#   pim_migrator      owns the schema and runs migrations; the only role that can change it
#   pim_app_role      ordinary data access (gate, forge, maintenance): no superuser, no BYPASSRLS, no DDL
#   pim_runtime_role  the Runner's data access, through PgBouncer; same limits
#   pim_readonly_role SELECT only, never secrets
#   pgbouncer_auth    may only look up password hashes for PgBouncer's auth_query
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE pim_migrator LOGIN PASSWORD '${PIM_MIGRATOR_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE pim_app_role LOGIN PASSWORD '${PIM_APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE pim_runtime_role LOGIN PASSWORD '${PIM_RUNTIME_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE pim_readonly_role LOGIN PASSWORD '${PIM_READONLY_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE pgbouncer_auth LOGIN PASSWORD '${PGBOUNCER_AUTH_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

-- Nobody but the migrator creates objects in the database.
REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO pim_migrator, pim_app_role, pim_runtime_role, pim_readonly_role, pgbouncer_auth;
GRANT CREATE ON DATABASE ${POSTGRES_DB} TO pim_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Bounded sessions per role, under PgBouncer's pool sizes.
ALTER ROLE pim_app_role CONNECTION LIMIT 40;
ALTER ROLE pim_runtime_role CONNECTION LIMIT 80;
ALTER ROLE pim_readonly_role CONNECTION LIMIT 10;
ALTER ROLE pim_app_role SET statement_timeout = '30s';
ALTER ROLE pim_runtime_role SET statement_timeout = '30s';
ALTER ROLE pim_readonly_role SET statement_timeout = '60s';
ALTER ROLE pim_runtime_role SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE pim_app_role SET idle_in_transaction_session_timeout = '30s';

-- The migrator's objects are readable and writable by the other roles through default privileges (pim.* grants are in sql/0502_roles.sql).
ALTER DEFAULT PRIVILEGES FOR ROLE pim_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pim_app_role, pim_runtime_role;
ALTER DEFAULT PRIVILEGES FOR ROLE pim_migrator IN SCHEMA public GRANT SELECT ON TABLES TO pim_readonly_role;

-- PgBouncer's auth lookup: a function that returns one role's hash and nothing else.
CREATE SCHEMA pgbouncer AUTHORIZATION postgres;
CREATE FUNCTION pgbouncer.get_auth(p_usename TEXT) RETURNS TABLE(usename name, passwd text) AS
\$\$ SELECT usename::name, passwd::text FROM pg_catalog.pg_shadow WHERE usename = p_usename \$\$
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog;
REVOKE ALL ON FUNCTION pgbouncer.get_auth(TEXT) FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(TEXT) TO pgbouncer_auth;
SQL
