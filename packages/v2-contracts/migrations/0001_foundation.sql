-- The foundation every workstream's migrations build on: the schemas, the roles that own them, the
-- migration ledger and the helper row-level security policies read. Workstreams add tables in their own
-- bands (see src/db.ts MIGRATION_BANDS) and never edit this file.

CREATE TABLE IF NOT EXISTS public.pim_schema_migrations (
	number      integer     PRIMARY KEY,
	name        text        NOT NULL,
	checksum    text        NOT NULL,
	applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE SCHEMA IF NOT EXISTS pim_app;
CREATE SCHEMA IF NOT EXISTS pim_runtime;
CREATE SCHEMA IF NOT EXISTS pim_forge;
CREATE SCHEMA IF NOT EXISTS pim_projection;

-- One NOLOGIN role per kind of process. A deployment grants each to the login it connects as.
DO $$
DECLARE r text;
BEGIN
	FOREACH r IN ARRAY ARRAY['pim_gate', 'pim_runtime', 'pim_live', 'pim_forge', 'pim_maintenance'] LOOP
		IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
			EXECUTE format('CREATE ROLE %I NOLOGIN', r);
		END IF;
	END LOOP;
END $$;

GRANT USAGE ON SCHEMA pim_app, pim_runtime, pim_forge, pim_projection TO pim_gate, pim_runtime, pim_live, pim_forge, pim_maintenance;

-- Each schema's tables are written by its own role; the others read only what their workstream's migrations grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA pim_app        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pim_gate;
ALTER DEFAULT PRIVILEGES IN SCHEMA pim_runtime    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pim_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA pim_forge      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pim_forge;
ALTER DEFAULT PRIVILEGES IN SCHEMA pim_projection GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pim_live;
ALTER DEFAULT PRIVILEGES IN SCHEMA pim_app, pim_runtime, pim_forge, pim_projection GRANT ALL ON TABLES TO pim_maintenance;
ALTER DEFAULT PRIVILEGES IN SCHEMA pim_app, pim_runtime, pim_forge, pim_projection GRANT USAGE, SELECT ON SEQUENCES TO pim_gate, pim_runtime, pim_live, pim_forge, pim_maintenance;

-- The owner a transaction acts for, set with `SELECT set_config('pim.owner_id', $1, true)` (SET LOCAL) so it
-- ends with the transaction and is safe behind PgBouncer. Null when unset, so a policy `owner_id = pim_current_owner_id()`
-- matches no row for a connection that never set it.
CREATE OR REPLACE FUNCTION public.pim_current_owner_id() RETURNS text
	LANGUAGE sql STABLE PARALLEL SAFE
	AS $$ SELECT nullif(current_setting('pim.owner_id', true), '') $$;

GRANT EXECUTE ON FUNCTION public.pim_current_owner_id() TO pim_gate, pim_runtime, pim_live, pim_forge, pim_maintenance;
