-- Tool calls with effects outside the database (ExternalOperationRecord in @pim/v2-contracts), kept so a crash is
-- reconciled instead of repeated. early_signal holds a decision or result that arrived before the task parked; the
-- store also writes it as a durable signal, which the owner re-applies at every activation until the task has left waiting.

create table pim_runtime.external_operations (
	owner_id text not null,
	operation_id text not null,
	partition_id uuid not null,
	task_id text not null,
	tool_name text not null,
	capability text not null,
	idempotency_key text not null,
	state text not null default 'pending' check (state in ('pending', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled', 'cancel_uncertain', 'needs_reconciliation')),
	receipt json,
	early_signal json,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	primary key (owner_id, operation_id),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create unique index external_operations_by_key on pim_runtime.external_operations (owner_id, idempotency_key);
create index external_operations_open on pim_runtime.external_operations (owner_id, partition_id, state) where state not in ('completed', 'failed', 'cancelled');

alter table pim_runtime.external_operations enable row level security;
alter table pim_runtime.external_operations force row level security;
create policy owner_isolation on pim_runtime.external_operations
	using (owner_id = public.pim_current_owner_id()) with check (owner_id = public.pim_current_owner_id());
