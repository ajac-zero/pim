-- Browser sessions and tokens are server-side rows, so revoking one takes effect on the next request. Only SHA-256 digests are kept.
CREATE TABLE pim_app.browser_sessions (
	id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	token_hash text NOT NULL UNIQUE,
	credential_id text,
	user_agent text,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	last_seen_at timestamptz,
	revoked_at timestamptz
);
CREATE INDEX sessions_by_owner ON pim_app.browser_sessions (owner_id);
SELECT pim_app.seal_lookup('pim_app.browser_sessions', 'token_hash');

-- API tokens (pim_<owner>_...). Scopes of '*' are the legacy unscoped tokens migrated as hashes; new tokens name their scopes.
CREATE TABLE pim_app.api_tokens (
	id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	name text NOT NULL,
	token_hash text NOT NULL UNIQUE,
	scopes text[] NOT NULL DEFAULT '{}',
	legacy boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz,
	last_used_at timestamptz,
	revoked_at timestamptz
);
CREATE INDEX tokens_by_owner ON pim_app.api_tokens (owner_id);
SELECT pim_app.seal_lookup('pim_app.api_tokens', 'token_hash');

-- Every other bearer a person's space issues: computer pairing (pimc_), host (pimh_), MCP OAuth clients, grants and refresh tokens.
CREATE TABLE pim_app.token_consumers (
	id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	kind text NOT NULL CHECK (kind IN ('computer', 'host', 'mcp_client', 'mcp_grant', 'mcp_refresh')),
	token_hash text NOT NULL UNIQUE,
	label text,
	scopes text[] NOT NULL DEFAULT '{}',
	metadata jsonb NOT NULL DEFAULT '{}',
	reissued_from text,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz,
	revoked_at timestamptz
);
CREATE INDEX consumers_by_owner ON pim_app.token_consumers (owner_id, kind);
SELECT pim_app.seal_lookup('pim_app.token_consumers', 'token_hash');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;
