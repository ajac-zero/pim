-- Grants for the scoped roles the deployment creates before the migrator runs (deploy/compose/postgres/init).
-- Roles that do not exist (a plain test database) are skipped; the privileges are never granted to PUBLIC.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pim_app_role') THEN
		GRANT USAGE ON SCHEMA pim TO pim_app_role;
		GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim TO pim_app_role;
		ALTER DEFAULT PRIVILEGES IN SCHEMA pim GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pim_app_role;
		REVOKE ALL ON pim.ops_migrations FROM pim_app_role;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pim_runtime_role') THEN
		GRANT USAGE ON SCHEMA pim TO pim_runtime_role;
		GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim TO pim_runtime_role;
		ALTER DEFAULT PRIVILEGES IN SCHEMA pim GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pim_runtime_role;
		REVOKE ALL ON pim.ops_migrations FROM pim_runtime_role;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pim_readonly_role') THEN
		GRANT USAGE ON SCHEMA pim TO pim_readonly_role;
		GRANT SELECT ON ALL TABLES IN SCHEMA pim TO pim_readonly_role;
		ALTER DEFAULT PRIVILEGES IN SCHEMA pim GRANT SELECT ON TABLES TO pim_readonly_role;
		-- Secrets are not readable by a read-only role, even sealed.
		REVOKE ALL ON pim.secret_envelopes FROM pim_readonly_role;
	END IF;
END
$$;
