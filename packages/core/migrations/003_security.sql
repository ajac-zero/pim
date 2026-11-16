-- Pim v2 schema, part 3: scoped roles and row-level security.
-- No role below can bypass RLS. A tenant's rows are visible only while `pim.tenant_id` is set for the
-- current transaction (set_config(..., true)), which keeps the context PgBouncer-transaction-mode safe.
-- Cross-tenant work (claiming a family, timers, retention) belongs to pim_steward and pim_maint only, and only on named tables.

DO $$
DECLARE r text;
BEGIN
	FOREACH r IN ARRAY ARRAY['pim_runtime', 'pim_gate', 'pim_live', 'pim_steward', 'pim_maint'] LOOP
		IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
			EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', r);
		END IF;
	END LOOP;
END $$;

CREATE FUNCTION app.current_tenant() RETURNS text LANGUAGE sql STABLE AS
	$$ SELECT nullif(current_setting('pim.tenant_id', true), '') $$;

DO $$
DECLARE t record;
BEGIN
	FOR t IN
		SELECT c.table_schema AS s, c.table_name AS n FROM information_schema.columns c
		WHERE c.column_name = 'tenant_id' AND c.table_schema IN ('app', 'rt')
	LOOP
		EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.s, t.n);
		EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.s, t.n);
		EXECUTE format($p$CREATE POLICY tenant_isolation ON %I.%I FOR ALL TO pim_runtime, pim_gate, pim_live
			USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant())$p$, t.s, t.n);
		EXECUTE format('CREATE POLICY maint_all ON %I.%I FOR ALL TO pim_maint USING (true) WITH CHECK (true)', t.s, t.n);
	END LOOP;
END $$;

-- The steward claims work across tenants, on these tables only.
CREATE POLICY steward_all ON rt.partitions FOR ALL TO pim_steward USING (true) WITH CHECK (true);
CREATE POLICY steward_all ON app.activation FOR ALL TO pim_steward USING (true) WITH CHECK (true);
CREATE POLICY steward_all ON app.timers FOR ALL TO pim_steward USING (true) WITH CHECK (true);
CREATE POLICY steward_all ON app.signals FOR ALL TO pim_steward USING (true) WITH CHECK (true);
CREATE POLICY steward_all ON app.external_ops FOR ALL TO pim_steward USING (true) WITH CHECK (true);
CREATE POLICY steward_read ON app.approvals FOR SELECT TO pim_steward USING (true);
CREATE POLICY steward_read ON rt.commits FOR SELECT TO pim_steward USING (true);
CREATE POLICY steward_read ON app.tenants FOR SELECT TO pim_steward USING (true);

GRANT USAGE ON SCHEMA app, rt TO pim_runtime, pim_gate, pim_live, pim_steward, pim_maint;

-- Runner: the runtime tables and what a running family writes beside them.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rt TO pim_runtime;
GRANT DELETE ON rt.document_revisions TO pim_runtime;
GRANT SELECT ON app.tenants, app.users, app.commands, app.secrets TO pim_runtime;
GRANT SELECT, INSERT, UPDATE ON app.chats TO pim_runtime;
GRANT SELECT, INSERT, UPDATE ON app.activation, app.signals, app.timers, app.external_ops, app.approvals,
	app.view_streams, app.view_events, app.objects TO pim_runtime;
GRANT SELECT, INSERT ON app.audit TO pim_runtime;
GRANT SELECT, UPDATE (spent_cents) ON app.execution_grants TO pim_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO pim_runtime, pim_gate, pim_steward;

-- Gate: accounts, commands, settings and snapshots. It never writes runtime records.
GRANT SELECT, INSERT, UPDATE, DELETE ON app.users, app.passkeys, app.sessions, app.api_tokens, app.recovery_codes,
	app.commands, app.chats, app.signals, app.activation, app.approvals, app.execution_grants, app.secrets, app.objects,
	app.view_streams, app.view_events, app.timers, app.external_ops TO pim_gate;
GRANT SELECT, INSERT ON app.audit TO pim_gate;
GRANT SELECT ON app.tenants TO pim_gate;
GRANT SELECT ON ALL TABLES IN SCHEMA rt TO pim_gate;
GRANT INSERT ON rt.partitions TO pim_gate;

-- Live reads streams and authenticates the subscriber; it writes nothing.
GRANT SELECT ON rt.commits, rt.conversation_directory, rt.partitions, app.view_events, app.sessions, app.api_tokens, app.users, app.tenants TO pim_live;

-- Steward: lease, activation, timers and reconciliation.
GRANT SELECT, UPDATE ON rt.partitions TO pim_steward;
GRANT SELECT ON rt.commits TO pim_steward;
GRANT SELECT, INSERT, UPDATE ON app.activation, app.timers, app.external_ops, app.signals TO pim_steward;
GRANT SELECT ON app.approvals, app.tenants TO pim_steward;

-- Maintenance: retention, export and verification.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app, rt TO pim_maint;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO pim_maint;
