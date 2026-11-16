-- Coding grants an admin manages (the CodingGrant contract) and standing approvals (the StandingApproval contract): auditable
-- records, never code paths. Permission and human approval are separate answers; a standing approval only stands in for the person.
CREATE TABLE pim_app.coding_grants (
	grant_id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	permissions text[] NOT NULL DEFAULT '{}',
	pools text[] NOT NULL DEFAULT '{}',
	repositories text[] NOT NULL DEFAULT '{}',
	quota jsonb NOT NULL DEFAULT '{}',
	granted_by text NOT NULL,
	granted_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz
);
CREATE INDEX coding_grants_by_owner ON pim_app.coding_grants (owner_id) WHERE revoked_at IS NULL;
SELECT pim_app.seal_tenant('pim_app.coding_grants');

CREATE TABLE pim_app.standing_approvals (
	approval_id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	action text NOT NULL,
	scope jsonb NOT NULL DEFAULT '{}',
	granted_by text NOT NULL,
	granted_at timestamptz NOT NULL DEFAULT now(),
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
CREATE POLICY sel ON pim_app.audit_log FOR SELECT USING (owner_id = public.pim_current_owner_id());
CREATE POLICY ins ON pim_app.audit_log FOR INSERT WITH CHECK (owner_id = public.pim_current_owner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA pim_app TO pim_gate;
