-- The import landing schema: where a legacy snapshot lands. Identity, authentication and secrets are
-- typed; pi-durable history is split into conversation-family partitions with its numeric ids kept;
-- everything else a space owns is kept row for row in legacy_rows so that nothing is dropped silently.
CREATE TABLE pim.tenants (
	tenant_id text PRIMARY KEY,
	username text NOT NULL UNIQUE,
	role text NOT NULL,
	status text NOT NULL,
	created_at_ms bigint NOT NULL,
	activated_at_ms bigint,
	status_reason text
);
CREATE TABLE pim.identities (
	issuer text NOT NULL,
	subject text NOT NULL,
	tenant_id text NOT NULL REFERENCES pim.tenants,
	PRIMARY KEY (issuer, subject)
);
CREATE TABLE pim.passkeys (
	tenant_id text NOT NULL REFERENCES pim.tenants,
	id text NOT NULL,
	spki text NOT NULL,
	algorithm integer NOT NULL,
	name text NOT NULL,
	created_at_ms bigint NOT NULL,
	last_used_at_ms bigint NOT NULL,
	PRIMARY KEY (tenant_id, id)
);
CREATE TABLE pim.api_tokens (
	tenant_id text NOT NULL REFERENCES pim.tenants,
	id text NOT NULL,
	name text NOT NULL,
	hash text NOT NULL UNIQUE,
	created_at_ms bigint NOT NULL,
	last_used_at_ms bigint,
	PRIMARY KEY (tenant_id, id)
);
CREATE TABLE pim.recovery_codes (
	tenant_id text NOT NULL REFERENCES pim.tenants,
	hash text NOT NULL,
	created_at_ms bigint NOT NULL,
	used_at_ms bigint,
	PRIMARY KEY (tenant_id, hash)
);
-- Envelope-encrypted secrets. legacy_sealed keeps the exact legacy ciphertext so the original key backup
-- can still open it; envelope is the same plaintext under the new envelope scheme.
CREATE TABLE pim.secret_envelopes (
	tenant_id text NOT NULL,
	name text NOT NULL,
	purpose text NOT NULL,
	envelope jsonb NOT NULL,
	legacy_format text NOT NULL,
	legacy_sealed text,
	PRIMARY KEY (tenant_id, name)
);

CREATE TABLE pim.partitions (
	tenant_id text NOT NULL REFERENCES pim.tenants,
	partition_id text NOT NULL,
	home boolean NOT NULL DEFAULT false,
	next_commit_seq bigint NOT NULL,
	PRIMARY KEY (tenant_id, partition_id)
);
CREATE UNIQUE INDEX one_home_partition ON pim.partitions (tenant_id) WHERE home;
-- A tenant's pi ids come from one sequence: every id was unique in the one legacy storage and is never renumbered.
CREATE TABLE pim.tenant_id_sequence (
	tenant_id text PRIMARY KEY REFERENCES pim.tenants,
	next_id bigint NOT NULL
);
CREATE TABLE pim.conversation_directory (
	tenant_id text NOT NULL,
	conversation_id bigint NOT NULL,
	partition_id text NOT NULL,
	PRIMARY KEY (tenant_id, conversation_id),
	FOREIGN KEY (tenant_id, partition_id) REFERENCES pim.partitions
);
CREATE TABLE pim.pi_conversations (
	tenant_id text NOT NULL,
	id bigint NOT NULL,
	partition_id text NOT NULL,
	parent_conversation_id bigint,
	parent_at bigint,
	owner_conversation_id bigint,
	owner_task_id bigint,
	record jsonb NOT NULL,
	PRIMARY KEY (tenant_id, id),
	FOREIGN KEY (tenant_id, partition_id) REFERENCES pim.partitions
);
CREATE TABLE pim.pi_entries (
	tenant_id text NOT NULL,
	id bigint NOT NULL,
	partition_id text NOT NULL,
	conversation_id bigint NOT NULL,
	head bigint,
	commit_seq bigint NOT NULL,
	record jsonb NOT NULL,
	PRIMARY KEY (tenant_id, id),
	FOREIGN KEY (tenant_id, conversation_id) REFERENCES pim.pi_conversations
);
CREATE INDEX pi_entries_by_conversation ON pim.pi_entries (tenant_id, conversation_id, id);
CREATE TABLE pim.pi_tasks (
	tenant_id text NOT NULL,
	id bigint NOT NULL,
	partition_id text NOT NULL,
	conversation_id bigint NOT NULL,
	kind text NOT NULL,
	status text NOT NULL,
	abort_requested boolean NOT NULL,
	background boolean NOT NULL,
	hold text,
	record jsonb NOT NULL,
	PRIMARY KEY (tenant_id, id),
	FOREIGN KEY (tenant_id, conversation_id) REFERENCES pim.pi_conversations
);
CREATE TABLE pim.pi_submissions (
	tenant_id text NOT NULL,
	id bigint NOT NULL,
	partition_id text NOT NULL,
	conversation_id bigint NOT NULL,
	request_id text,
	status text NOT NULL,
	record jsonb NOT NULL,
	PRIMARY KEY (tenant_id, id),
	FOREIGN KEY (tenant_id, conversation_id) REFERENCES pim.pi_conversations
);
CREATE TABLE pim.pi_documents (
	tenant_id text NOT NULL,
	id bigint NOT NULL,
	partition_id text NOT NULL,
	kind text NOT NULL,
	family integer NOT NULL,
	key_value text NOT NULL,
	scope_kind text NOT NULL,
	owner_id bigint NOT NULL,
	created_at bigint NOT NULL,
	retired_at bigint,
	record jsonb NOT NULL,
	PRIMARY KEY (tenant_id, id)
);
CREATE TABLE pim.pi_document_revisions (
	tenant_id text NOT NULL,
	document_id bigint NOT NULL,
	seq bigint NOT NULL,
	kind text NOT NULL,
	version integer NOT NULL,
	content jsonb NOT NULL,
	PRIMARY KEY (tenant_id, document_id, seq),
	FOREIGN KEY (tenant_id, document_id) REFERENCES pim.pi_documents
);

-- The person's chats: the public UUID, the pi conversation it names and where it lives.
CREATE TABLE pim.chats (
	tenant_id text NOT NULL,
	public_id text NOT NULL,
	conversation_id bigint NOT NULL,
	title text,
	created_at_ms bigint NOT NULL,
	updated_at_ms bigint NOT NULL,
	deleted_at_ms bigint,
	summary text,
	summary_of text,
	PRIMARY KEY (tenant_id, public_id),
	UNIQUE (tenant_id, conversation_id),
	FOREIGN KEY (tenant_id, conversation_id) REFERENCES pim.pi_conversations
);

-- Every other legacy row, as it was. source names the Durable Object that held it.
CREATE TABLE pim.legacy_rows (
	tenant_id text NOT NULL,
	source text NOT NULL,
	table_name text NOT NULL,
	pk text NOT NULL,
	row jsonb NOT NULL,
	PRIMARY KEY (tenant_id, source, table_name, pk)
);

-- Object storage index: what S3 holds, with the checksum measured at import.
CREATE TABLE pim.objects (
	bucket text NOT NULL,
	key text NOT NULL,
	tenant_id text,
	size_bytes bigint NOT NULL,
	sha256 text NOT NULL,
	content_type text,
	PRIMARY KEY (bucket, key)
);
