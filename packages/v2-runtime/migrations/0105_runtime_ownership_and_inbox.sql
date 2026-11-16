-- Ownership (a lease with a fencing epoch on the row that sequences commits), the due-work row that says whether a
-- partition needs an owner, and the durable inbox and signals that survive a crash.

alter table pim_runtime.partitions
	add column owner_id text,
	add column owner_epoch bigint not null default 0,
	add column lease_expires_at timestamptz;

-- Whether a partition needs a Runner. A new partition needs one; its owner declares it quiescent only with a
-- conditional write on activation_seq, so a command that arrives meanwhile always wins.
create table pim_runtime.due_work (
	tenant_id text not null,
	partition_id text not null,
	state text not null default 'needs_owner' check (state in ('needs_owner', 'quiescent')),
	next_due_at timestamptz,
	activation_seq bigint not null default 0,
	reason text,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (tenant_id, partition_id),
	foreign key (tenant_id, partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);
create index due_work_claimable on pim_runtime.due_work (state, next_due_at);

-- Work submitted to a partition by the application: a user input, a trigger firing. request_id deduplicates, and also
-- becomes pi's submission requestId, so redelivery after a crash is harmless.
create table pim_runtime.command_inbox (
	tenant_id text not null,
	partition_id text not null,
	command_id bigint generated always as identity,
	request_id text not null,
	kind text not null,
	conversation_id bigint,
	payload json not null,
	created_at timestamptz not null default clock_timestamp(),
	done_at timestamptz,
	primary key (tenant_id, partition_id, command_id),
	foreign key (tenant_id, partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);
create unique index command_inbox_by_request on pim_runtime.command_inbox (tenant_id, partition_id, request_id);
create index command_inbox_pending on pim_runtime.command_inbox (tenant_id, partition_id, command_id) where done_at is null;

-- Approval decisions and external tool completions. A patched pi-durable 1.1.0 resumeTask() on a task that has not
-- suspended yet is remembered only in memory, so a decision stays here and is re-applied at every activation until the
-- task has left the waiting state.
create table pim_runtime.durable_signals (
	tenant_id text not null,
	partition_id text not null,
	signal_id bigint generated always as identity,
	signal_key text not null,
	kind text not null check (kind in ('approval', 'tool_result', 'resume')),
	task_id bigint not null,
	call_id text,
	payload json not null,
	created_at timestamptz not null default clock_timestamp(),
	settled_at timestamptz,
	primary key (tenant_id, partition_id, signal_id),
	foreign key (tenant_id, partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);
create unique index durable_signals_by_key on pim_runtime.durable_signals (tenant_id, partition_id, signal_key);
create index durable_signals_pending on pim_runtime.durable_signals (tenant_id, partition_id, signal_id) where settled_at is null;
create index durable_signals_by_task on pim_runtime.durable_signals (tenant_id, partition_id, task_id);

-- Effects a partition asks of another (a room seat's message): delivered into the target's command_inbox.
create table pim_runtime.signal_outbox (
	tenant_id text not null,
	source_partition_id text not null,
	outbox_id bigint generated always as identity,
	operation_id text not null,
	target_conversation_id bigint not null,
	payload json not null,
	created_at timestamptz not null default clock_timestamp(),
	delivered_at timestamptz,
	primary key (tenant_id, source_partition_id, outbox_id),
	foreign key (tenant_id, source_partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);
create unique index signal_outbox_by_operation on pim_runtime.signal_outbox (tenant_id, operation_id);
create index signal_outbox_pending on pim_runtime.signal_outbox (tenant_id, source_partition_id, outbox_id) where delivered_at is null;

-- Row-level security: a connection sees one tenant, named by pim.tenant_id, unless a steward sets pim.scope to 'all'
-- to claim due work across tenants. Every query also filters by tenant explicitly; this is the second fence.
do $$
declare t text;
begin
	foreach t in array array[
		'partitions', 'tenant_id_allocators', 'id_blocks', 'record_ids', 'conversation_partitions', 'conversations',
		'entries', 'tasks', 'submissions', 'documents', 'document_revisions', 'commit_receipts', 'runtime_outbox',
		'outbox_consumers', 'due_work', 'command_inbox', 'durable_signals', 'signal_outbox'
	] loop
		execute format('alter table pim_runtime.%I enable row level security', t);
		execute format('alter table pim_runtime.%I force row level security', t);
		execute format(
			'create policy tenant_isolation on pim_runtime.%I using (tenant_id = current_setting(''pim.tenant_id'', true) or current_setting(''pim.scope'', true) = ''all'') with check (tenant_id = current_setting(''pim.tenant_id'', true) or current_setting(''pim.scope'', true) = ''all'')',
			t
		);
	end loop;
end $$;

-- An application role, when the deployment created one, may use the schema.
do $$
begin
	if exists (select 1 from pg_roles where rolname = 'pim_runtime_app') then
		grant usage on schema pim_runtime to pim_runtime_app;
		grant select, insert, update, delete on all tables in schema pim_runtime to pim_runtime_app;
		grant select, update on all sequences in schema pim_runtime to pim_runtime_app;
	end if;
end $$;
