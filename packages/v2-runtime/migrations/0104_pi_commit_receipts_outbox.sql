-- A durable receipt per commit, and the outbox of what each commit changed. Both are written in the commit's own
-- transaction, so a projection or Live consumer never sees a change that did not commit, and a Runner that lost a COMMIT
-- acknowledgement can ask whether its batch landed.

create table pim_runtime.commit_receipts (
	owner_id text not null,
	partition_id uuid not null,
	batch_id uuid not null,
	commit_seq bigint not null,
	holder_id text not null,
	epoch bigint not null,
	write_count integer not null,
	committed_at timestamptz not null default clock_timestamp(),
	primary key (owner_id, partition_id, batch_id),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create unique index commit_receipts_by_seq on pim_runtime.commit_receipts (owner_id, partition_id, commit_seq);

-- What each commit changed, one row per conversation it touched (RuntimeOutboxEvent in @pim/v2-contracts). commit_seq
-- is gapless per partition: a commit that rolls back does not consume one. payload holds the changed records as
-- references (consumers read the canonical tables), as JSON text.
create table pim_runtime.runtime_outbox (
	owner_id text not null,
	partition_id uuid not null,
	commit_seq bigint not null,
	ordinal integer not null,
	projection_version integer not null,
	public_chat_id uuid not null,
	conversation_id bigint not null,
	event_kind text not null,
	payload text not null,
	committed_at timestamptz not null default clock_timestamp(),
	primary key (owner_id, partition_id, commit_seq, ordinal),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);

-- A consumer's position: the last Seq it handled in one partition.
create table pim_runtime.outbox_consumers (
	owner_id text not null,
	partition_id uuid not null,
	consumer text not null,
	last_seq bigint not null default 0,
	updated_at timestamptz not null default now(),
	primary key (owner_id, partition_id, consumer)
);
