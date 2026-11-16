-- What the real adapters keep: harness run records and session cost, pi-durable's commit log, Amp's durable start ledger, the credential vault and Gitea.
alter table pim_forge.forge_harness_runs add column record jsonb;
alter table pim_forge.forge_harness_sessions add column cost_usd numeric(14, 6) not null default 0, add column usage jsonb;

-- A steer sent to a remote orb is its own small state machine: sending, uncertain (it may or may not have landed) or sent.
alter table pim_forge.forge_inbox drop constraint forge_inbox_status_check;
alter table pim_forge.forge_inbox add constraint forge_inbox_status_check check (status in ('pending', 'taken', 'sending', 'uncertain', 'done'));

-- AmpHttpOrbClient's durable store: the start reservation and the orb handle, so a lost answer is never started twice.
create table pim_forge.forge_amp_kv (
	key text primary key,
	value jsonb not null,
	updated_at timestamptz not null default now()
);

-- A pi coding thread's pi-durable storage, as an ordered log of the commits it accepted, replayed on open.
create table pim_forge.forge_pi_commits (
	thread_id text not null references pim_forge.forge_threads (thread_id),
	seq bigint not null,
	writes json not null,
	at timestamptz not null default now(),
	primary key (thread_id, seq)
);

-- The coding credential vault: only sealed blobs, bound to their person and harness, versioned so a stale write is refused.
create table pim_forge.forge_vault (
	owner_id text not null,
	harness text not null,
	version integer not null,
	sealed bytea,
	byte_length integer,
	updated_at timestamptz not null default now(),
	primary key (owner_id, harness)
);

-- The deployment's one Gitea account, connected by the admin, and the OAuth handshakes in flight.
create table pim_forge.forge_gitea_connection (
	singleton boolean primary key default true check (singleton),
	login text not null,
	sealed bytea not null,
	needs_reconnect boolean not null default false,
	connected_by text not null,
	updated_at timestamptz not null default now()
);
create table pim_forge.forge_gitea_oauth_state (
	state text primary key,
	owner_id text not null,
	sealed_verifier bytea not null,
	expires_at timestamptz not null
);
