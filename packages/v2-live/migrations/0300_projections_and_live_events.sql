-- Rebuildable read models and the replayable live event log (Workstream 3, migration band 0300-0399, schema pim_projection).
-- Everything here is derived from committed runtime truth (`pim_runtime.runtime_outbox`), keyed by
-- (partition_id, commit_seq, projection_version). Deleting an owner's rows and replaying the outbox yields the
-- same views; the projector only reads the outbox, so a rebuild never runs a tool or calls a model.
--
-- Every table carries `owner_id` and a row-level security policy on `pim_current_owner_id()` (0001_foundation),
-- so a connection that set another owner (or none) sees none of the rows, whatever it asks for.

CREATE TABLE pim_projection.chat_transcript_projection (
	owner_id text NOT NULL,
	stream_kind text NOT NULL CHECK (stream_kind IN ('chat', 'coding')),
	chat_id text NOT NULL,
	entry_id text NOT NULL,
	position bigint NOT NULL,
	partial boolean NOT NULL DEFAULT false,
	message jsonb NOT NULL,
	ui_state jsonb NOT NULL DEFAULT '{}'::jsonb,
	partition_id uuid NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	PRIMARY KEY (owner_id, stream_kind, chat_id, entry_id)
);
CREATE INDEX chat_transcript_projection_order ON pim_projection.chat_transcript_projection (owner_id, stream_kind, chat_id, position);

CREATE TABLE pim_projection.sidebar_session_projection (
	owner_id text NOT NULL,
	chat_id text NOT NULL,
	title text,
	busy boolean NOT NULL DEFAULT false,
	unread boolean NOT NULL DEFAULT false,
	stalled boolean NOT NULL DEFAULT false,
	updated_at bigint NOT NULL DEFAULT 0,
	summary jsonb NOT NULL DEFAULT '{}'::jsonb,
	partition_id uuid NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	PRIMARY KEY (owner_id, chat_id)
);
CREATE INDEX sidebar_session_projection_order ON pim_projection.sidebar_session_projection (owner_id, updated_at DESC, chat_id);

CREATE TABLE pim_projection.coding_thread_projection (
	owner_id text NOT NULL,
	thread_id text NOT NULL,
	title text,
	harness text,
	state text NOT NULL DEFAULT 'idle',
	running boolean NOT NULL DEFAULT false,
	unread boolean NOT NULL DEFAULT false,
	updated_at bigint NOT NULL DEFAULT 0,
	summary jsonb NOT NULL DEFAULT '{}'::jsonb,
	partition_id uuid NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	PRIMARY KEY (owner_id, thread_id)
);
CREATE INDEX coding_thread_projection_order ON pim_projection.coding_thread_projection (owner_id, updated_at DESC, thread_id);

-- What a Live client replays. `stream_seq` is dense per (owner, topic) and private to Live: it is how a gap is
-- detected. What travels to clients is the cursor `partition_id:projection_version:commit_seq`, which names
-- exactly one row of a topic (a commit projects to at most one row per topic). The seq is allocated from
-- live_stream_heads under that row's lock, held until the projection transaction commits, so rows become
-- visible in seq order: a reader that sees seq N has seen every seq below it.
CREATE TABLE pim_projection.live_stream_heads (
	owner_id text NOT NULL,
	topic text NOT NULL,
	head_seq bigint NOT NULL,
	PRIMARY KEY (owner_id, topic)
);

CREATE TABLE pim_projection.live_event_log (
	owner_id text NOT NULL,
	topic text NOT NULL,
	stream_seq bigint NOT NULL,
	partition_id uuid NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	-- Set on in-flight progress (a partial message): a slow client may skip all but the latest.
	replaceable_key text,
	event_kind text NOT NULL,
	payload jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, topic, stream_seq)
);
CREATE UNIQUE INDEX live_event_log_cursor ON pim_projection.live_event_log (owner_id, topic, partition_id, projection_version, commit_seq);
CREATE INDEX live_event_log_created ON pim_projection.live_event_log (created_at);

-- The idempotency key of a projected commit.
CREATE TABLE pim_projection.projection_applied (
	owner_id text NOT NULL,
	partition_id uuid NOT NULL,
	commit_seq bigint NOT NULL,
	projection_version integer NOT NULL,
	applied_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (partition_id, commit_seq, projection_version)
);

CREATE TABLE pim_projection.projection_watermarks (
	owner_id text NOT NULL,
	partition_id uuid NOT NULL,
	projection_version integer NOT NULL,
	projected_seq bigint NOT NULL DEFAULT 0,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (partition_id, projection_version)
);

DO $$
DECLARE t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['chat_transcript_projection', 'sidebar_session_projection', 'coding_thread_projection', 'live_stream_heads', 'live_event_log', 'projection_applied', 'projection_watermarks'] LOOP
		EXECUTE format('ALTER TABLE pim_projection.%I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('ALTER TABLE pim_projection.%I FORCE ROW LEVEL SECURITY', t);
		EXECUTE format('CREATE POLICY owner_rows ON pim_projection.%I USING (owner_id = public.pim_current_owner_id()) WITH CHECK (owner_id = public.pim_current_owner_id())', t);
	END LOOP;
END $$;
