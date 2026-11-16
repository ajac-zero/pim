-- A durable receipt per commit, and the outbox of what each commit changed. Both are written in the commit's own
-- transaction, so a projection or Live consumer never sees a change that did not commit, and a Runner that lost a COMMIT
-- acknowledgement can ask whether its batch landed.

create table pim_runtime.commit_receipts (
	tenant_id text not null,
	partition_id text not null,
	batch_id uuid not null,
	commit_seq bigint not null,
	owner_id text not null,
	owner_epoch bigint not null,
	write_count integer not null,
	committed_at timestamptz not null default clock_timestamp(),
	primary key (tenant_id, partition_id, batch_id),
	foreign key (tenant_id, partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);
create unique index commit_receipts_by_seq on pim_runtime.commit_receipts (tenant_id, partition_id, commit_seq);

-- One row per commit: which records it touched (references, not bodies; consumers read the canonical tables).
create table pim_runtime.runtime_outbox (
	tenant_id text not null,
	partition_id text not null,
	seq bigint not null,
	changes text not null,
	created_at timestamptz not null default clock_timestamp(),
	primary key (tenant_id, partition_id, seq),
	foreign key (tenant_id, partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);

-- A consumer's position: the last Seq it handled in one partition.
create table pim_runtime.outbox_consumers (
	tenant_id text not null,
	partition_id text not null,
	consumer text not null,
	last_seq bigint not null default 0,
	updated_at timestamptz not null default now(),
	primary key (tenant_id, partition_id, consumer)
);
