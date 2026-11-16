-- Pim v2 schema, part 1: the application root and the pi-durable runtime tables.
-- `app` holds a tenant's application truth; `rt` holds what pi-durable's Storage contract needs.
-- Every tenant-owned table carries tenant_id and gets row-level security in 003_security.sql.

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS rt;

CREATE TABLE app.tenants (
	tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,64}$'),
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleting', 'deleted')),
	settings jsonb NOT NULL DEFAULT '{}',
	created_at timestamptz NOT NULL DEFAULT now()
);

-- The tenant-wide pi id sequence. Runners lease blocks from it, so no lock is held per minted id.
-- Ids stay JavaScript safe integers (at most 2^53 - 1), the bound pi's `Id` brand relies on; next_id may reach 2^53, one past the last id.
CREATE TABLE rt.tenant_ids (
	tenant_id text PRIMARY KEY REFERENCES app.tenants,
	next_id bigint NOT NULL DEFAULT 2 CHECK (next_id >= 2 AND next_id <= 9007199254740992)
);

-- One row per conversation family: the unit of storage, mutation line and exclusive owner. The same row
-- carries the lease and epoch that fence every mutating transaction, and the commit sequence.
CREATE TABLE rt.partitions (
	partition_id text PRIMARY KEY CHECK (partition_id ~ '^[A-Za-z0-9_-]{1,64}$'),
	tenant_id text NOT NULL REFERENCES app.tenants,
	home boolean NOT NULL DEFAULT false,
	owner_id text,
	epoch bigint NOT NULL DEFAULT 0,
	lease_until timestamptz NOT NULL DEFAULT '-infinity',
	next_seq bigint NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
	schema_version integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partitions_one_home ON rt.partitions (tenant_id) WHERE home;
CREATE INDEX partitions_by_tenant ON rt.partitions (tenant_id);

-- Immutable: which family a conversation lives in. Conversation 1 of a tenant is the home family's root.
CREATE TABLE rt.conversation_directory (
	tenant_id text NOT NULL REFERENCES app.tenants,
	conversation_id bigint NOT NULL,
	partition_id text NOT NULL REFERENCES rt.partitions,
	PRIMARY KEY (tenant_id, conversation_id)
);
CREATE INDEX directory_by_partition ON rt.conversation_directory (partition_id);

CREATE TABLE rt.record_ids (
	tenant_id text NOT NULL,
	id bigint NOT NULL,
	partition_id text NOT NULL,
	record_type text NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document')),
	PRIMARY KEY (tenant_id, id)
);

-- Records are JSON text, not jsonb: pi needs the exact value back, and jsonb reorders keys and rejects U+0000.
CREATE TABLE rt.conversations (
	tenant_id text NOT NULL,
	partition_id text NOT NULL,
	id bigint NOT NULL,
	owner_conversation_id bigint,
	owner_task_id bigint,
	record text NOT NULL,
	PRIMARY KEY (tenant_id, id)
);
CREATE INDEX conversations_by_partition ON rt.conversations (partition_id, id);
CREATE INDEX conversations_by_owner_conversation ON rt.conversations (partition_id, owner_conversation_id, id);
CREATE INDEX conversations_by_owner_task ON rt.conversations (partition_id, owner_task_id, id);

CREATE TABLE rt.entries (
	tenant_id text NOT NULL,
	partition_id text NOT NULL,
	id bigint NOT NULL,
	conversation_id bigint NOT NULL,
	head bigint,
	commit_seq bigint NOT NULL,
	record text NOT NULL,
	PRIMARY KEY (tenant_id, id)
);
CREATE INDEX entries_by_conversation ON rt.entries (partition_id, conversation_id, id DESC);
CREATE INDEX entry_heads_by_conversation ON rt.entries (partition_id, conversation_id, id DESC) WHERE head IS NOT NULL;

CREATE TABLE rt.tasks (
	tenant_id text NOT NULL,
	partition_id text NOT NULL,
	id bigint NOT NULL,
	conversation_id bigint NOT NULL,
	kind text NOT NULL,
	status text NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
	abort_requested boolean NOT NULL,
	background boolean NOT NULL,
	record text NOT NULL,
	PRIMARY KEY (tenant_id, id)
);
CREATE INDEX tasks_by_status ON rt.tasks (partition_id, status, id);
CREATE INDEX tasks_by_conversation ON rt.tasks (partition_id, conversation_id, id);
CREATE INDEX tasks_by_kind ON rt.tasks (partition_id, kind, id);
CREATE INDEX tasks_live ON rt.tasks (partition_id, id) WHERE status <> 'terminal';

CREATE TABLE rt.submissions (
	tenant_id text NOT NULL,
	partition_id text NOT NULL,
	id bigint NOT NULL,
	conversation_id bigint NOT NULL,
	request_id text,
	status text NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
	record text NOT NULL,
	PRIMARY KEY (tenant_id, id)
);
CREATE INDEX submissions_by_request ON rt.submissions (partition_id, conversation_id, request_id);
CREATE INDEX submissions_by_conversation ON rt.submissions (partition_id, conversation_id, id);
CREATE INDEX submissions_by_status ON rt.submissions (partition_id, status, id);

CREATE TABLE rt.documents (
	tenant_id text NOT NULL,
	partition_id text NOT NULL,
	id bigint NOT NULL,
	kind text NOT NULL,
	family smallint NOT NULL CHECK (family IN (0, 1)),
	key_value text NOT NULL,
	scope_kind text NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
	owner_id bigint NOT NULL,
	created_at bigint NOT NULL,
	retired_at bigint,
	record text NOT NULL,
	PRIMARY KEY (tenant_id, id)
);
CREATE INDEX documents_by_address ON rt.documents (partition_id, kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at);
CREATE INDEX documents_by_scope ON rt.documents (partition_id, scope_kind, owner_id, id);
CREATE INDEX documents_by_scope_kind ON rt.documents (partition_id, scope_kind, owner_id, kind, id);

CREATE TABLE rt.document_revisions (
	tenant_id text NOT NULL,
	partition_id text NOT NULL,
	document_id bigint NOT NULL,
	seq bigint NOT NULL,
	kind text NOT NULL CHECK (kind IN ('base', 'delta')),
	version integer NOT NULL,
	content text NOT NULL,
	PRIMARY KEY (tenant_id, document_id, seq)
);
CREATE INDEX document_revisions_by_kind ON rt.document_revisions (tenant_id, document_id, kind, seq DESC);

-- One row per commit, inserted in the commit's own transaction: the durability receipt that resolves an
-- unknown COMMIT, and the cursor Live and projectors follow. `summary` names what changed, not its content.
CREATE TABLE rt.commits (
	partition_id text NOT NULL,
	seq bigint NOT NULL,
	tenant_id text NOT NULL,
	epoch bigint NOT NULL,
	token text NOT NULL,
	summary jsonb NOT NULL,
	committed_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (partition_id, seq)
);
CREATE UNIQUE INDEX commits_by_token ON rt.commits (partition_id, token);
