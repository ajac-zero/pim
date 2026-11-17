-- Host operations: the few fixed operations on the machine the stack runs on that the admin's majordomo asks for, each after a person approves it, and that the
-- `hostopsd` daemon carries out. The daemon dials out (it holds the Docker access, the stack never does), so operations wait here until it polls. Instance-level
-- rows, like the computer host's: only the Gate and the Runner's application login (pim_gate) reach them.
CREATE TABLE pim_app.hostops_ops (
	id text PRIMARY KEY,
	-- The call that asked, so a replayed call finds its operation instead of queueing another.
	request_key text UNIQUE,
	-- The approval the operation runs under; each approval runs one operation.
	approval_id text UNIQUE,
	created_at timestamptz NOT NULL DEFAULT now(),
	caller_owner_id text NOT NULL,
	caller_agent_id text NOT NULL,
	caller_chat_id text,
	op text NOT NULL,
	args jsonb NOT NULL,
	state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'rolled_back', 'expired')),
	started_at timestamptz,
	finished_at timestamptz,
	summary text,
	data jsonb
);
CREATE INDEX hostops_ops_by_state ON pim_app.hostops_ops (state, created_at);

-- Every request, refused or not, and every change of an operation's state; the newest 10,000 rows are kept. Arguments are stored redacted.
CREATE TABLE pim_app.hostops_audit (
	id bigserial PRIMARY KEY,
	ts timestamptz NOT NULL DEFAULT now(),
	actor_kind text NOT NULL,
	actor_id text,
	action text NOT NULL,
	op_id text,
	args jsonb,
	outcome text NOT NULL,
	detail text,
	chat_id text
);

-- The daemon's credential, `pimhostops_<secret>`: only its SHA-256 is kept, and one is current at a time.
CREATE TABLE pim_app.hostops_credential (
	hash text PRIMARY KEY,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz,
	agent_version text,
	agent_commit text,
	revoked_at timestamptz
);

GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.hostops_ops, pim_app.hostops_audit, pim_app.hostops_credential TO pim_gate;
GRANT USAGE ON SEQUENCE pim_app.hostops_audit_id_seq TO pim_gate;
