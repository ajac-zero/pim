-- Sign-in ceremonies in flight, setup codes, and MCP OAuth clients and codes.
-- A flow is instance-level state keyed by the digest of a random cookie value: a challenge being answered, a provider sign-in under way,
-- or an authorization code waiting to be exchanged. It holds no secret a digest does not already protect, and it expires.
CREATE TABLE pim_app.auth_flows (
	id text PRIMARY KEY,
	kind text NOT NULL CHECK (kind IN ('challenge', 'oauth', 'consent', 'code')),
	data jsonb NOT NULL,
	expires_at timestamptz NOT NULL
);
CREATE INDEX auth_flows_by_expiry ON pim_app.auth_flows (expires_at);

-- A setup code lets an account without a credential make its first passkey or link its first identity, once.
CREATE TABLE pim_app.setup_codes (
	code_hash text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	used_at timestamptz
);
SELECT pim_app.seal_lookup('pim_app.setup_codes', 'code_hash');

-- Dynamically registered MCP OAuth clients (RFC 7591): public metadata, so no tenant.
CREATE TABLE pim_app.oauth_clients (
	client_id text PRIMARY KEY,
	metadata jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;
