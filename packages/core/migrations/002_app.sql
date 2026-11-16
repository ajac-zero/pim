-- Pim v2 schema, part 2: application truth, ownership/activation, the command inbox, signals, timers,
-- external operations, execution grants, secrets, objects and view events.

CREATE TABLE app.users (
	tenant_id text NOT NULL REFERENCES app.tenants,
	user_id text NOT NULL,
	username text NOT NULL,
	role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'guest')),
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting')),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, user_id),
	UNIQUE (tenant_id, username)
);

-- A deployment must always keep one active admin able to sign in or recover.
CREATE FUNCTION app.protect_last_admin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remaining integer;
BEGIN
	IF (TG_OP = 'DELETE' AND OLD.role = 'admin' AND OLD.status = 'active')
		OR (TG_OP = 'UPDATE' AND OLD.role = 'admin' AND OLD.status = 'active' AND (NEW.role <> 'admin' OR NEW.status <> 'active')) THEN
		SELECT count(*) INTO remaining FROM app.users
			WHERE tenant_id = OLD.tenant_id AND role = 'admin' AND status = 'active' AND user_id <> OLD.user_id;
		IF remaining = 0 AND current_setting('pim.allow_last_admin_change', true) IS DISTINCT FROM 'on' THEN
			RAISE EXCEPTION 'last active admin cannot be removed, demoted or suspended' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER users_protect_last_admin BEFORE UPDATE OR DELETE ON app.users
	FOR EACH ROW EXECUTE FUNCTION app.protect_last_admin();

CREATE TABLE app.passkeys (
	tenant_id text NOT NULL,
	user_id text NOT NULL,
	credential_id text NOT NULL,
	public_key bytea NOT NULL,
	counter bigint NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, credential_id)
);

-- Server-revocable browser sessions and scoped API tokens. Only a SHA-256 digest of the secret is stored;
-- `token_hash` is the same unsalted digest legacy tokens used, so a migrated token keeps working.
CREATE TABLE app.sessions (
	tenant_id text NOT NULL,
	token_hash text PRIMARY KEY,
	user_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	revoked_at timestamptz,
	last_seen_at timestamptz
);
CREATE INDEX sessions_by_user ON app.sessions (tenant_id, user_id);

CREATE TABLE app.api_tokens (
	tenant_id text NOT NULL,
	token_id text NOT NULL,
	token_hash text NOT NULL UNIQUE,
	user_id text NOT NULL,
	name text NOT NULL,
	scopes text[] NOT NULL,
	legacy boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz,
	revoked_at timestamptz,
	PRIMARY KEY (tenant_id, token_id)
);

CREATE TABLE app.recovery_codes (
	tenant_id text NOT NULL,
	user_id text NOT NULL,
	code_hash text NOT NULL,
	used_at timestamptz,
	PRIMARY KEY (tenant_id, code_hash)
);

-- Rows the owner of a family has not yet seen, and when it must next be looked at. Written by Gate in the
-- same transaction as the command or signal; claimed by Dispatch. Hints (NATS) only make discovery faster.
CREATE TABLE app.activation (
	partition_id text PRIMARY KEY,
	tenant_id text NOT NULL,
	state text NOT NULL DEFAULT 'needs_owner' CHECK (state IN ('needs_owner', 'quiescent')),
	due_at timestamptz NOT NULL DEFAULT now(),
	signal_seq bigint NOT NULL DEFAULT 0
);
CREATE INDEX activation_due ON app.activation (due_at) WHERE state = 'needs_owner';

-- The inbox: a command is accepted once per stable id and returns without waiting for a model or a provision.
CREATE TABLE app.commands (
	tenant_id text NOT NULL,
	command_id text NOT NULL,
	actor text NOT NULL,
	kind text NOT NULL,
	partition_id text,
	payload jsonb NOT NULL,
	status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'rejected')),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, command_id)
);

-- A chat as people name it: a public id mapped to the family that holds it and, once the owner has created it, its pi conversation.
CREATE TABLE app.chats (
	tenant_id text NOT NULL,
	chat_id text NOT NULL,
	partition_id text NOT NULL,
	conversation_id bigint,
	parent_chat_id text,
	created_by text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, chat_id),
	UNIQUE (tenant_id, partition_id)
);

-- Durable signals to a family: input, approval decision, trigger firing, cross-family delivery, coding result.
CREATE TABLE app.signals (
	signal_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	tenant_id text NOT NULL,
	partition_id text NOT NULL,
	kind text NOT NULL,
	operation_id text NOT NULL,
	payload jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	delivered_at timestamptz,
	UNIQUE (tenant_id, operation_id)
);
CREATE INDEX signals_pending ON app.signals (partition_id, signal_id) WHERE delivered_at IS NULL;

-- Time-based work outside pi: approval expiry, review expiry, trigger ticks, scheduled pushes, retry waits.
CREATE TABLE app.timers (
	timer_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	tenant_id text NOT NULL,
	kind text NOT NULL,
	ref text NOT NULL,
	partition_id text,
	due_at timestamptz NOT NULL,
	claimed_by text,
	claim_until timestamptz,
	done_at timestamptz,
	UNIQUE (tenant_id, kind, ref)
);
CREATE INDEX timers_due ON app.timers (due_at) WHERE done_at IS NULL;

-- Cross-domain external operations: intent -> effect -> result, with a stable id and a receipt.
CREATE TABLE app.external_ops (
	tenant_id text NOT NULL,
	op_id text NOT NULL,
	kind text NOT NULL,
	partition_id text,
	state text NOT NULL DEFAULT 'intent' CHECK (state IN
		('intent', 'effecting', 'succeeded', 'failed', 'reconciliation_needed', 'cancel_requested', 'cancelled', 'cancel_uncertain')),
	idempotent boolean NOT NULL,
	grant_id text,
	fence_epoch bigint,
	request jsonb NOT NULL,
	handle jsonb,
	receipt jsonb,
	attempts integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, op_id)
);
CREATE INDEX external_ops_open ON app.external_ops (state) WHERE state IN ('intent', 'effecting', 'reconciliation_needed', 'cancel_requested', 'cancel_uncertain');

-- Coding, compute and repository authority: explicit records, distinct from an agent's tool permission and from
-- a person's approval of one action. `standing` marks an approved standing push or merge authority.
CREATE TABLE app.execution_grants (
	tenant_id text NOT NULL,
	grant_id text NOT NULL,
	subject_user text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('coding', 'compute', 'repo_push', 'repo_merge')),
	pools text[] NOT NULL DEFAULT '{}',
	repos text[] NOT NULL DEFAULT '{}',
	standing boolean NOT NULL DEFAULT false,
	quota_runs integer,
	spend_cap_cents bigint,
	spent_cents bigint NOT NULL DEFAULT 0,
	granted_by text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz,
	revoked_at timestamptz,
	PRIMARY KEY (tenant_id, grant_id)
);
CREATE INDEX grants_by_subject ON app.execution_grants (tenant_id, subject_user, kind);

CREATE TABLE app.approvals (
	tenant_id text NOT NULL,
	approval_id text NOT NULL,
	partition_id text NOT NULL,
	conversation_id bigint NOT NULL,
	task_id bigint,
	call_id text NOT NULL,
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
	decided_by text,
	decided_at timestamptz,
	-- Set once the owner has re-applied the decision to the suspended tool task (resumeTask returned `resumed` or `terminal`).
	applied_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, approval_id),
	UNIQUE (tenant_id, partition_id, call_id)
);

-- Envelope-encrypted secrets: one data key per row, wrapped by a versioned key-encryption key.
CREATE TABLE app.secrets (
	tenant_id text NOT NULL,
	secret_id text NOT NULL,
	purpose text NOT NULL,
	key_version integer NOT NULL,
	wrapped_key bytea NOT NULL,
	nonce bytea NOT NULL,
	ciphertext bytea NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	rotated_at timestamptz,
	PRIMARY KEY (tenant_id, secret_id)
);

-- Object metadata and ACL; bodies are in S3-compatible storage (SeaweedFS by default).
CREATE TABLE app.objects (
	tenant_id text NOT NULL,
	object_id text NOT NULL,
	s3_key text NOT NULL,
	size_bytes bigint NOT NULL,
	sha256 text NOT NULL,
	content_type text NOT NULL,
	owner_user text NOT NULL,
	acl jsonb NOT NULL DEFAULT '{"private": true}',
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, object_id)
);

-- Tenant-level view streams (chat list, unread, approvals). A stream's cursor is assigned under the
-- stream row's lock, so cursors commit in order. Conversation streams use the family's commit seq instead.
CREATE TABLE app.view_streams (
	tenant_id text NOT NULL,
	stream text NOT NULL,
	next_cursor bigint NOT NULL DEFAULT 1,
	PRIMARY KEY (tenant_id, stream)
);
CREATE TABLE app.view_events (
	tenant_id text NOT NULL,
	stream text NOT NULL,
	cursor bigint NOT NULL,
	event_id text NOT NULL,
	version integer NOT NULL DEFAULT 1,
	kind text NOT NULL,
	payload jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, stream, cursor),
	UNIQUE (tenant_id, stream, event_id)
);

CREATE TABLE app.audit (
	audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	tenant_id text NOT NULL,
	actor text NOT NULL,
	action text NOT NULL,
	resource text,
	outcome text NOT NULL,
	at timestamptz NOT NULL DEFAULT now()
);

-- Applied-migration ledger for the import toolkit and the maintenance role.
CREATE TABLE app.import_ledger (
	tenant_id text NOT NULL,
	import_id text NOT NULL,
	unit text NOT NULL,
	checksum text NOT NULL,
	rows_imported bigint NOT NULL,
	at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, import_id, unit)
);
