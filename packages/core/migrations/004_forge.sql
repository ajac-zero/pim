-- Pim v2 schema, part 4: Forge, the coding control plane. A run is an external operation (app.external_ops holds
-- its start, handle and receipt) with progress and results here. Transcript floods are bounded: events past the cap
-- are counted in `dropped`, not stored.

CREATE TABLE app.coding_runs (
	tenant_id text NOT NULL,
	op_id text NOT NULL,
	harness text NOT NULL CHECK (harness IN ('pi', 'claude-code', 'codex', 'mistral-vibe', 'amp')),
	repo text NOT NULL,
	pool text,
	branch text,
	state text NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning', 'running', 'done', 'failed', 'cancelled', 'interrupted', 'reconcile')),
	session_id text,
	workspace jsonb,
	journal jsonb,
	cursor bigint NOT NULL DEFAULT 0,
	dropped bigint NOT NULL DEFAULT 0,
	cost_usd numeric,
	usage jsonb,
	result jsonb,
	created_by text NOT NULL,
	grant_id text,
	cleaned_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, op_id)
);
CREATE INDEX coding_runs_open ON app.coding_runs (state) WHERE state IN ('provisioning', 'running', 'reconcile', 'interrupted');

CREATE TABLE app.coding_events (
	tenant_id text NOT NULL,
	op_id text NOT NULL,
	cursor bigint NOT NULL,
	at timestamptz NOT NULL DEFAULT now(),
	kind text NOT NULL,
	payload jsonb NOT NULL,
	PRIMARY KEY (tenant_id, op_id, cursor)
);

ALTER TABLE app.coding_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.coding_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.coding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.coding_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.coding_runs FOR ALL TO pim_runtime, pim_gate, pim_live USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
CREATE POLICY tenant_isolation ON app.coding_events FOR ALL TO pim_runtime, pim_gate, pim_live USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());
CREATE POLICY maint_all ON app.coding_runs FOR ALL TO pim_maint USING (true) WITH CHECK (true);
CREATE POLICY maint_all ON app.coding_events FOR ALL TO pim_maint USING (true) WITH CHECK (true);
CREATE POLICY steward_read ON app.coding_runs FOR SELECT TO pim_steward USING (true);

GRANT SELECT, INSERT, UPDATE ON app.coding_runs TO pim_runtime;
GRANT SELECT, INSERT, DELETE ON app.coding_events TO pim_runtime;
GRANT SELECT ON app.coding_runs, app.coding_events TO pim_gate, pim_live, pim_steward;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.coding_runs, app.coding_events TO pim_maint;
