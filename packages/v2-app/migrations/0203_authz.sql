-- Coding, compute and repository grants an admin manages, and standing approval grants: auditable records that let a named
-- principal act without a human approval each time. Authorization stays separate from approval.
CREATE TABLE pim_app.capability_grants (
	id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	capability text NOT NULL CHECK (capability IN ('coding', 'compute', 'repository')),
	resource text NOT NULL DEFAULT '*',
	quota jsonb NOT NULL DEFAULT '{}',
	granted_by text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz
);
CREATE INDEX grants_by_owner ON pim_app.capability_grants (owner_id, capability);
SELECT pim_app.seal_tenant('pim_app.capability_grants');

CREATE TABLE pim_app.standing_approvals (
	id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	principal text NOT NULL,
	action text NOT NULL,
	resource text NOT NULL DEFAULT '*',
	reason text NOT NULL,
	granted_by text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz,
	revoked_at timestamptz
);
CREATE INDEX standing_by_owner ON pim_app.standing_approvals (owner_id, action);
SELECT pim_app.seal_tenant('pim_app.standing_approvals');

-- Authorization decisions, append only: the app role gets no update or delete policy.
CREATE TABLE pim_app.audit_log (
	id bigserial PRIMARY KEY,
	owner_id text NOT NULL,
	actor text NOT NULL,
	action text NOT NULL,
	resource text,
	decision text NOT NULL,
	detail jsonb NOT NULL DEFAULT '{}',
	at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pim_app.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE pim_app.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY sel ON pim_app.audit_log FOR SELECT USING (owner_id = pim_app.cur_owner());
CREATE POLICY ins ON pim_app.audit_log FOR INSERT WITH CHECK (owner_id = pim_app.cur_owner());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_app_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA pim_app TO pim_app_rw;
