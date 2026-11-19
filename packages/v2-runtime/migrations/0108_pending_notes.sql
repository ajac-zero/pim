-- What the person should read in a chat once a recycled partition has recovered: when the watchdog stops a run that ignores its stop, the partition is given up with the run still
-- in it, and cannot write the note that says why. The note waits here, durably, and is written once the conversation is idle again, by the partition's next owner.
create table pim_runtime.pending_notes (
	owner_id text not null,
	partition_id uuid not null,
	note_key text not null,
	conversation_id bigint not null,
	entry json not null,
	created_at timestamptz not null default clock_timestamp(),
	settled_at timestamptz,
	primary key (owner_id, partition_id, note_key),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
alter table pim_runtime.pending_notes enable row level security;
alter table pim_runtime.pending_notes force row level security;
create policy owner_isolation on pim_runtime.pending_notes using (owner_id = public.pim_current_owner_id()) with check (owner_id = public.pim_current_owner_id());
