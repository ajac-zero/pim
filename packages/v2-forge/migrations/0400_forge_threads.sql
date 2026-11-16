-- Forge's coding threads: what CodingThreadDO's SQLite kept per thread, as fenced PostgreSQL rows.
create schema if not exists pim_forge;

create table pim_forge.forge_threads (
	thread_id text primary key check (length(thread_id) <= 128),
	owner_id text not null,
	-- The idempotency key of the start: codingThreadId(owner_id, start_operation) is thread_id.
	start_operation text not null,
	harness text not null check (harness in ('pi', 'claude-code', 'codex', 'mistral-vibe', 'amp')),
	state text not null check (state in ('provisioning', 'queued', 'idle', 'running', 'waiting_input', 'failed', 'archived')),
	state_reason text,
	state_detail text,
	task text not null,
	repo text not null,
	ref text,
	branch text,
	base_sha text,
	last_pushed_sha text,
	pull_request jsonb,
	chat_id text,
	created_by text not null,
	workspace_ref jsonb,
	placement jsonb,
	orb jsonb,
	-- What was recorded before a compute provider or the Amp API was called: reconcile by it, never relaunch.
	provisioning jsonb,
	budget_usd numeric(14, 6),
	spent_usd numeric(14, 6) not null default 0,
	limits jsonb,
	profile jsonb,
	resolved_profile jsonb,
	consecutive_interrupts integer not null default 0,
	last_seen_at timestamptz,
	-- Broker (pimgit_) and gateway (pimgw_) tokens are valid only while they carry this nonce and the thread is live.
	gateway_nonce text not null,
	-- The lease: at most one Forge worker steps a thread, and every write names the epoch it was granted.
	lease_holder text,
	lease_epoch bigint not null default 0,
	lease_expires_at timestamptz,
	-- Cancellation is three facts, not one.
	cancel_state text not null default 'none' check (cancel_state in ('none', 'requested', 'cancelled', 'uncertain')),
	archived_at timestamptz,
	compute_torn_down_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (owner_id, start_operation)
);
create index forge_threads_owner on pim_forge.forge_threads (owner_id, created_at desc);
create index forge_threads_orb on pim_forge.forge_threads ((orb ->> 'threadId')) where orb is not null;
create index forge_threads_state on pim_forge.forge_threads (state) where state in ('provisioning', 'queued', 'running');

create table pim_forge.forge_inbox (
	seq bigserial primary key,
	thread_id text not null references pim_forge.forge_threads (thread_id),
	operation_id text not null,
	kind text not null,
	payload jsonb not null default '{}',
	status text not null default 'pending' check (status in ('pending', 'taken', 'done')),
	created_at timestamptz not null default now(),
	unique (thread_id, operation_id)
);

create table pim_forge.forge_events (
	thread_id text not null references pim_forge.forge_threads (thread_id),
	seq bigint not null,
	kind text not null,
	role text,
	data jsonb not null default '{}',
	cost_usd numeric(14, 6) not null default 0,
	tokens_in bigint not null default 0,
	tokens_out bigint not null default 0,
	-- A remote or CLI cursor (an Amp message id, a vendor event id); a replay of it is dropped.
	source_cursor text,
	at timestamptz not null default now(),
	primary key (thread_id, seq)
);
create unique index forge_events_cursor on pim_forge.forge_events (thread_id, source_cursor) where source_cursor is not null;

create table pim_forge.forge_checkpoints (
	thread_id text not null references pim_forge.forge_threads (thread_id),
	seq bigint not null,
	sha text not null,
	label text,
	at timestamptz not null default now(),
	primary key (thread_id, seq)
);

create table pim_forge.forge_diffs (
	thread_id text not null references pim_forge.forge_threads (thread_id),
	seq bigint not null,
	source text not null check (source in ('workspace', 'orb')),
	unpushed_orb boolean not null default false,
	diff text not null,
	files jsonb not null default '[]',
	at timestamptz not null default now(),
	primary key (thread_id, seq)
);

create table pim_forge.forge_test_runs (
	thread_id text not null references pim_forge.forge_threads (thread_id),
	seq bigint not null,
	command text not null,
	exit_code integer,
	output text not null default '',
	at timestamptz not null default now(),
	primary key (thread_id, seq)
);

create table pim_forge.forge_tool_journal (
	thread_id text not null references pim_forge.forge_threads (thread_id),
	call_id text not null,
	tool text not null,
	args jsonb not null default '{}',
	result jsonb,
	at timestamptz not null default now(),
	primary key (thread_id, call_id)
);

create table pim_forge.forge_harness_sessions (
	thread_id text not null references pim_forge.forge_threads (thread_id),
	harness text not null,
	session_id text not null,
	restarts integer not null default 0,
	updated_at timestamptz not null default now(),
	primary key (thread_id, harness)
);

create table pim_forge.forge_harness_runs (
	run_id bigserial primary key,
	thread_id text not null references pim_forge.forge_threads (thread_id),
	operation_id text not null,
	harness text not null,
	status text not null check (status in ('running', 'completed', 'failed', 'interrupted', 'cancelled')),
	resumes integer not null default 0,
	started_at timestamptz not null default now(),
	ended_at timestamptz,
	unique (thread_id, operation_id)
);

create table pim_forge.forge_autosaves (
	thread_id text primary key references pim_forge.forge_threads (thread_id),
	head_sha text not null,
	-- The git bundle lives in Objects (S3); only its key and size are rows.
	object_key text not null,
	bytes bigint not null,
	at timestamptz not null default now()
);

create table pim_forge.forge_repo_settings (
	owner_id text not null,
	repo text not null,
	setup_script text not null check (length(setup_script) <= 65536),
	updated_at timestamptz not null default now(),
	primary key (owner_id, repo)
);

-- The transactional outbox: Live projections, wakes of the originating chat and cost-ledger records.
create table pim_forge.forge_outbox (
	id bigserial primary key,
	topic text not null check (topic in ('projection', 'wake', 'cost_ledger')),
	dedupe_key text not null unique,
	thread_id text,
	payload jsonb not null,
	created_at timestamptz not null default now(),
	delivered_at timestamptz
);

-- A pi coding thread's own pi-durable partition, apart from every normal agent's.
create table pim_forge.forge_pi_entries (
	thread_id text not null references pim_forge.forge_threads (thread_id),
	seq bigint not null,
	entry jsonb not null,
	primary key (thread_id, seq)
);
