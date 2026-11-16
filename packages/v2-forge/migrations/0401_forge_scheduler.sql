-- The pool and slot scheduler CodingSchedulerDO kept in one DO per space, as deployment-wide rows.
create table pim_forge.forge_pools (
	pool_id text primary key,
	provider text not null,
	size integer not null check (size between 1 and 1000),
	priority integer not null default 0,
	enabled boolean not null default true
);

create table pim_forge.forge_slots (
	thread_id text primary key references pim_forge.forge_threads (thread_id),
	pool_id text not null references pim_forge.forge_pools (pool_id),
	owner_id text not null,
	acquired_at timestamptz not null default now(),
	-- Set while the held workspace has nothing to do; the slot is released after the idle grace.
	idle_since timestamptz
);
create index forge_slots_pool on pim_forge.forge_slots (pool_id);

create table pim_forge.forge_queue (
	thread_id text primary key references pim_forge.forge_threads (thread_id),
	pool_id text not null references pim_forge.forge_pools (pool_id),
	owner_id text not null,
	enqueued_at timestamptz not null default now(),
	deadline_at timestamptz not null,
	requeued boolean not null default false,
	seq bigserial
);
create index forge_queue_pool on pim_forge.forge_queue (pool_id, seq);

create table pim_forge.forge_pool_breakers (
	pool_id text primary key references pim_forge.forge_pools (pool_id),
	failures integer not null default 0,
	retry_at timestamptz,
	probe text
);

-- One login refresh at a time per person and harness, so rotating tokens are never clobbered.
create table pim_forge.forge_login_locks (
	owner_id text not null,
	harness text not null,
	holder text not null,
	expires_at timestamptz not null,
	primary key (owner_id, harness)
);

-- One environment build per key; the others wait for its snapshot.
create table pim_forge.forge_env_builds (
	env_key text primary key,
	holder text not null,
	expires_at timestamptz not null
);

create table pim_forge.forge_compute_usage (
	id bigserial primary key,
	owner_id text not null,
	thread_id text not null,
	provider text not null,
	began_at timestamptz not null default now(),
	ended_at timestamptz,
	reason text
);
create index forge_compute_usage_owner on pim_forge.forge_compute_usage (owner_id, began_at);
