-- Coding authorization: apart from whatever lets a person chat with a normal agent.
create table pim_forge.forge_grants (
	grant_id bigserial primary key,
	-- A user, a tenant, or an agent standing in for one.
	subject_type text not null check (subject_type in ('user', 'tenant', 'agent')),
	subject_id text not null,
	permission text not null check (permission in ('coding:start', 'coding:steer', 'coding:abort', 'coding:push', 'coding:pr', 'coding:merge')),
	-- Repositories the grant covers, as `owner/name`, `owner/*` or `*`; null means the deployment's allowed repos.
	repos text[],
	-- Pools the grant may place threads on; null means any enabled pool.
	pools text[],
	-- A permission is not an approval: when set, the action also needs a person's yes.
	requires_approval boolean not null default false,
	-- A standing grant is an explicit, named policy (such as an agent that may push pim/* and merge), not a route accident.
	standing boolean not null default false,
	granted_by text not null,
	granted_at timestamptz not null default now(),
	revoked_at timestamptz
);
create index forge_grants_subject on pim_forge.forge_grants (subject_type, subject_id) where revoked_at is null;

create table pim_forge.forge_quotas (
	subject_type text not null check (subject_type in ('user', 'tenant', 'deployment')),
	subject_id text not null,
	max_concurrent integer,
	compute_minutes numeric,
	usd numeric,
	primary key (subject_type, subject_id)
);

-- What Forge needs of an account to cut off credentials: suspension is Gate's fact, mirrored here.
create table pim_forge.forge_owners (
	owner_id text primary key,
	tenant_id text,
	suspended_at timestamptz
);

-- Pending human approvals for actions a grant marks requires_approval.
create table pim_forge.forge_approvals (
	approval_id text primary key,
	thread_id text not null references pim_forge.forge_threads (thread_id),
	action text not null,
	payload jsonb not null default '{}',
	status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
	decided_by text,
	created_at timestamptz not null default now()
);
