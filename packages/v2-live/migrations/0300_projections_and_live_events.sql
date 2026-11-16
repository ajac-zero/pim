-- Rebuildable read models and the replayable live event log (Workstream 3, migrations 0300-0399).
-- Everything here is derived from committed runtime and Forge truth (`runtime_outbox`), keyed by
-- (partition_id, commit_seq, projection_version). Dropping or truncating any table in this schema and
-- replaying the outbox yields the same views; the projector only reads the outbox, so a rebuild never
-- runs a tool or calls a model.

CREATE SCHEMA IF NOT EXISTS pim_projection;

-- One row per message of a chat or coding thread, as `projectEntries` (@pim/shared/transcript) shows it.
CREATE TABLE pim_projection.chat_transcript_projection (
	tenant_id text NOT NULL,
	stream_kind text NOT NULL CHECK (stream_kind IN ('chat', 'coding')),
	chat_id text NOT NULL,
	entry_id text NOT NULL,
	position bigint NOT NULL,
	partial boolean NOT NULL DEFAULT false,
	message jsonb NOT NULL,
	ui_state jsonb NOT NULL DEFAULT '{}'::jsonb,
	partition_id text NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	PRIMARY KEY (tenant_id, stream_kind, chat_id, entry_id)
);
CREATE INDEX chat_transcript_projection_order ON pim_projection.chat_transcript_projection (tenant_id, stream_kind, chat_id, position);

-- The compact summary a sidebar row shows: title, busy/stalled badges, unread, order.
CREATE TABLE pim_projection.sidebar_session_projection (
	tenant_id text NOT NULL,
	chat_id text NOT NULL,
	title text,
	busy boolean NOT NULL DEFAULT false,
	unread boolean NOT NULL DEFAULT false,
	stalled boolean NOT NULL DEFAULT false,
	updated_at bigint NOT NULL DEFAULT 0,
	summary jsonb NOT NULL DEFAULT '{}'::jsonb,
	partition_id text NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	PRIMARY KEY (tenant_id, chat_id)
);
CREATE INDEX sidebar_session_projection_order ON pim_projection.sidebar_session_projection (tenant_id, updated_at DESC, chat_id);

CREATE TABLE pim_projection.coding_thread_projection (
	tenant_id text NOT NULL,
	thread_id text NOT NULL,
	title text,
	harness text,
	state text NOT NULL DEFAULT 'idle',
	running boolean NOT NULL DEFAULT false,
	unread boolean NOT NULL DEFAULT false,
	updated_at bigint NOT NULL DEFAULT 0,
	summary jsonb NOT NULL DEFAULT '{}'::jsonb,
	partition_id text NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	PRIMARY KEY (tenant_id, thread_id)
);
CREATE INDEX coding_thread_projection_order ON pim_projection.coding_thread_projection (tenant_id, updated_at DESC, thread_id);

-- What a Live client replays: per stream, a dense, strictly increasing stream_seq. The seq is allocated
-- from live_stream_heads under that row's lock, held until the projection transaction commits, so rows
-- become visible in seq order and a reader that sees seq N has seen every seq below it.
CREATE TABLE pim_projection.live_stream_heads (
	tenant_id text NOT NULL,
	stream_key text NOT NULL,
	head_seq bigint NOT NULL,
	PRIMARY KEY (tenant_id, stream_key)
);

CREATE TABLE pim_projection.live_event_log (
	tenant_id text NOT NULL,
	stream_key text NOT NULL,
	stream_seq bigint NOT NULL,
	partition_id text NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	-- Set on in-flight progress (a partial message, a tool's stdout): a slow client may skip all but the latest.
	replaceable_key text,
	event_kind text NOT NULL,
	payload jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, stream_key, stream_seq)
);
CREATE INDEX live_event_log_created ON pim_projection.live_event_log (created_at);

-- The idempotency key of a projected commit.
CREATE TABLE pim_projection.projection_applied (
	partition_id text NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	applied_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (partition_id, commit_seq, projection_version)
);

CREATE TABLE pim_projection.projection_watermarks (
	partition_id text NOT NULL,
	projection_version integer NOT NULL,
	projected_seq bigint NOT NULL DEFAULT 0,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (partition_id, projection_version)
);
