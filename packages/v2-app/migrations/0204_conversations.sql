-- Conversations, rooms, delegation tasks and the command ledger. A partition is one pi-durable storage (a conversation family);
-- the numeric pi ConversationId is only unique inside its tenant-wide sequence, so the public chat id (a UUID) is the application's key.
CREATE TABLE pim_app.partitions (
	partition_id uuid PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	home boolean NOT NULL DEFAULT false,
	next_conversation_id bigint NOT NULL DEFAULT 2,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_home_partition ON pim_app.partitions (owner_id) WHERE home;
SELECT pim_app.seal_tenant('pim_app.partitions');

CREATE TABLE pim_app.conversations (
	public_chat_id uuid PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	partition_id uuid NOT NULL REFERENCES pim_app.partitions (partition_id),
	conversation_id bigint NOT NULL,
	agent_id text,
	title text,
	kind text NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'group', 'task', 'trigger', 'review', 'visit')),
	room_mode text,
	summary text,
	summary_of uuid,
	forked_from uuid REFERENCES pim_app.conversations (public_chat_id),
	continued_from uuid REFERENCES pim_app.conversations (public_chat_id),
	continued_to uuid REFERENCES pim_app.conversations (public_chat_id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	archived_at timestamptz,
	deleted_at timestamptz,
	UNIQUE (owner_id, partition_id, conversation_id)
);
CREATE INDEX conversations_by_owner ON pim_app.conversations (owner_id, updated_at DESC) WHERE deleted_at IS NULL;
SELECT pim_app.seal_tenant('pim_app.conversations');

CREATE TABLE pim_app.room_members (
	public_chat_id uuid NOT NULL REFERENCES pim_app.conversations (public_chat_id),
	owner_id text NOT NULL,
	member text NOT NULL,
	role text NOT NULL DEFAULT 'agent',
	PRIMARY KEY (public_chat_id, member)
);
SELECT pim_app.seal_tenant('pim_app.room_members');

CREATE TABLE pim_app.tasks (
	task_id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	started_by uuid NOT NULL REFERENCES pim_app.conversations (public_chat_id),
	task_chat uuid REFERENCES pim_app.conversations (public_chat_id),
	origin_principal jsonb NOT NULL,
	title text NOT NULL,
	status text NOT NULL DEFAULT 'working' CHECK (status IN ('working', 'auth-required', 'completed', 'failed', 'canceled')),
	result text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT pim_app.seal_tenant('pim_app.tasks');

-- A "[Task update]" is delivered to the starting chat at most once per task state.
CREATE TABLE pim_app.task_update_deliveries (
	task_id text NOT NULL REFERENCES pim_app.tasks (task_id),
	owner_id text NOT NULL,
	status text NOT NULL,
	command_id text NOT NULL,
	PRIMARY KEY (task_id, status)
);
SELECT pim_app.seal_tenant('pim_app.task_update_deliveries');

-- Fast admission: a command is accepted by writing here in one short transaction, then the Runner works it off the inbox.
-- piRequestId is stable across redelivery so the runtime's own idempotency key never changes.
CREATE TABLE pim_app.accepted_commands (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	command_id text NOT NULL,
	-- The first seven are the runtime's CommandKind; fork, unarchive and delegate are application operations that only change metadata here.
	kind text NOT NULL CHECK (kind IN ('user_message', 'approval_decision', 'task_wake', 'trigger_fire', 'coding_wake', 'compaction_handoff', 'abort', 'fork', 'unarchive', 'delegate')),
	public_chat_id uuid REFERENCES pim_app.conversations (public_chat_id),
	pi_request_id text NOT NULL,
	payload jsonb NOT NULL,
	state text NOT NULL DEFAULT 'inbox_accepted' CHECK (state IN ('inbox_accepted', 'runtime_committed', 'rejected')),
	accepted_at timestamptz NOT NULL DEFAULT now(),
	committed_at timestamptz,
	PRIMARY KEY (owner_id, command_id)
);
CREATE INDEX commands_by_chat ON pim_app.accepted_commands (public_chat_id, accepted_at);
SELECT pim_app.seal_tenant('pim_app.accepted_commands');

CREATE TABLE pim_app.command_inbox (
	seq bigserial PRIMARY KEY,
	owner_id text NOT NULL,
	command_id text NOT NULL,
	partition_id uuid,
	available_at timestamptz NOT NULL DEFAULT now(),
	claimed_by text,
	claimed_until timestamptz,
	FOREIGN KEY (owner_id, command_id) REFERENCES pim_app.accepted_commands (owner_id, command_id),
	UNIQUE (owner_id, command_id)
);
SELECT pim_app.seal_tenant('pim_app.command_inbox');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA pim_app TO pim_gate;
