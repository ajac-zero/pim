-- Sign-in credentials. Each is found by its secret key before the owner is known, then belongs to one owner.
CREATE TABLE pim_app.passkeys (
	credential_id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	user_handle text NOT NULL,
	rp_id text NOT NULL,
	spki text NOT NULL,
	algorithm integer NOT NULL,
	sign_count bigint NOT NULL DEFAULT 0,
	name text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_used_at timestamptz
);
CREATE INDEX passkeys_by_owner ON pim_app.passkeys (owner_id);
SELECT pim_app.seal_lookup('pim_app.passkeys', 'credential_id');

CREATE TABLE pim_app.oidc_identities (
	id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	provider text NOT NULL,
	issuer text NOT NULL,
	subject text NOT NULL,
	identity_key text GENERATED ALWAYS AS (issuer || E'\n' || subject) STORED,
	label text NOT NULL,
	name text,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_used_at timestamptz,
	UNIQUE (issuer, subject)
);
CREATE INDEX oidc_by_owner ON pim_app.oidc_identities (owner_id);
SELECT pim_app.seal_lookup('pim_app.oidc_identities', 'identity_key');

CREATE TABLE pim_app.recovery_codes (
	code_hash text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	created_at timestamptz NOT NULL DEFAULT now(),
	used_at timestamptz
);
SELECT pim_app.seal_lookup('pim_app.recovery_codes', 'code_hash');

CREATE TABLE pim_app.device_links (
	code_hash text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	credential_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL
);
SELECT pim_app.seal_lookup('pim_app.device_links', 'code_hash');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;
