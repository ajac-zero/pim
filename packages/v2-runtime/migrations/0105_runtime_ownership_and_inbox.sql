-- Ownership (a lease with a fencing epoch on the row that sequences commits), the due-work row that says whether a
-- partition needs an owner, and the durable inbox and signals that survive a crash.

alter table pim_runtime.partitions
	add column holder_id text,
	add column epoch bigint not null default 0,
	add column lease_expires_at timestamptz;

-- Whether a partition needs a Runner. A new partition needs one; its owner declares it quiescent only with a
-- conditional write on activation_seq, so a command that arrives meanwhile always wins.
create table pim_runtime.due_work (
	owner_id text not null,
	partition_id uuid not null,
	state text not null default 'needs_owner' check (state in ('needs_owner', 'quiescent')),
	next_due_at timestamptz,
	activation_seq bigint not null default 0,
	reason text,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (owner_id, partition_id),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create index due_work_claimable on pim_runtime.due_work (state, next_due_at);

-- Work submitted to a partition (CommandSubmission in @pim/v2-contracts). command_id deduplicates a resubmission;
-- pi_request_id becomes pi's submission requestId, so redelivery after a crash is harmless.
create table pim_runtime.command_inbox (
	owner_id text not null,
	partition_id uuid not null,
	seq bigint generated always as identity,
	command_id text not null,
	conversation_id bigint,
	public_chat_id uuid,
	pi_request_id text not null,
	kind text not null,
	payload json not null,
	submitted_at timestamptz not null,
	created_at timestamptz not null default clock_timestamp(),
	done_at timestamptz,
	primary key (owner_id, partition_id, seq),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create unique index command_inbox_by_command on pim_runtime.command_inbox (owner_id, partition_id, command_id);
create index command_inbox_pending on pim_runtime.command_inbox (owner_id, partition_id, seq) where done_at is null;

-- Approval decisions and external tool completions. A patched pi-durable 1.1.0 resumeTask() on a task that has not
-- suspended yet is remembered only in memory, so a decision stays here and is re-applied at every activation until the
-- task has left the waiting state.
create table pim_runtime.durable_signals (
	owner_id text not null,
	partition_id uuid not null,
	signal_id bigint generated always as identity,
	signal_key text not null,
	kind text not null check (kind in ('approval', 'tool_result', 'resume')),
	task_id bigint not null,
	call_id text,
	payload json not null,
	created_at timestamptz not null default clock_timestamp(),
	settled_at timestamptz,
	primary key (owner_id, partition_id, signal_id),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create unique index durable_signals_by_key on pim_runtime.durable_signals (owner_id, partition_id, signal_key);
create index durable_signals_pending on pim_runtime.durable_signals (owner_id, partition_id, signal_id) where settled_at is null;
create index durable_signals_by_task on pim_runtime.durable_signals (owner_id, partition_id, task_id);

-- Effects a partition asks of another (a room seat's message): delivered into the target's command_inbox.
create table pim_runtime.signal_outbox (
	owner_id text not null,
	source_partition_id uuid not null,
	outbox_id bigint generated always as identity,
	operation_id text not null,
	target_conversation_id bigint not null,
	payload json not null,
	created_at timestamptz not null default clock_timestamp(),
	delivered_at timestamptz,
	primary key (owner_id, source_partition_id, outbox_id),
	foreign key (owner_id, source_partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create unique index signal_outbox_by_operation on pim_runtime.signal_outbox (owner_id, operation_id);
create index signal_outbox_pending on pim_runtime.signal_outbox (owner_id, source_partition_id, outbox_id) where delivered_at is null;

-- Row-level security: a transaction sees one owner's rows, named by pim.owner_id (public.pim_current_owner_id(), set with
-- SET LOCAL by withOwnerTransaction), so a pooled connection never carries it to another client. Two tables a Runner
-- claims work from across owners, partitions and due_work, also admit a transaction that sets pim.scope to 'all'. Every
-- query filters by owner explicitly as well; the policy is the second fence. Tables are written by the pim_runtime role
-- through the default privileges 0001_foundation.sql set.
do $$
declare t text;
begin
	foreach t in array array[
		'partitions', 'owner_id_allocators', 'id_blocks', 'record_ids', 'conversation_partitions', 'conversations',
		'entries', 'tasks', 'submissions', 'documents', 'document_revisions', 'commit_receipts', 'runtime_outbox',
		'outbox_consumers', 'due_work', 'command_inbox', 'durable_signals', 'signal_outbox'
	] loop
		execute format('alter table pim_runtime.%I enable row level security', t);
		execute format('alter table pim_runtime.%I force row level security', t);
		if t in ('partitions', 'due_work') then
			execute format(
				'create policy owner_isolation on pim_runtime.%I using (owner_id = public.pim_current_owner_id() or current_setting(''pim.scope'', true) = ''all'') with check (owner_id = public.pim_current_owner_id() or current_setting(''pim.scope'', true) = ''all'')',
				t
			);
		else
			execute format(
				'create policy owner_isolation on pim_runtime.%I using (owner_id = public.pim_current_owner_id()) with check (owner_id = public.pim_current_owner_id())',
				t
			);
		end if;
	end loop;
end $$;
