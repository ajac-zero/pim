-- The runtime schema: one pi-durable storage per partition (a conversation family), many partitions per tenant.
-- Every table is keyed by tenant_id so row-level security can fence tenants from one another. The pi numeric ids
-- (conversations, entries, tasks, submissions, documents) are one tenant-wide namespace; a PartitionId only says which
-- storage a record lives in.

create schema if not exists pim_runtime;

create table pim_runtime.partitions (
	tenant_id text not null,
	partition_id text not null,
	-- "home" holds conversation 1 (pi's root) and the root-attached optmem.nap; every other partition is a "family".
	kind text not null default 'family' check (kind in ('home', 'family')),
	-- The commit Seq the next commit takes. Seq is per partition, strictly increasing, and may have gaps.
	next_seq bigint not null default 1 check (next_seq >= 1),
	created_at timestamptz not null default now(),
	primary key (tenant_id, partition_id)
);
create unique index partitions_one_home on pim_runtime.partitions (tenant_id) where kind = 'home';

-- The tenant-wide pi id sequence. high_water is the largest id ever leased or imported; ids 1 (the root) is reserved.
create table pim_runtime.tenant_id_allocators (
	tenant_id text primary key,
	high_water bigint not null default 1 check (high_water >= 1 and high_water <= 9007199254740991)
);

-- An audit trail of leased id blocks. A block is [first_id, last_id]; ids a crashed owner did not use are gaps.
create table pim_runtime.id_blocks (
	tenant_id text not null,
	first_id bigint not null,
	last_id bigint not null,
	partition_id text,
	owner_epoch bigint,
	leased_at timestamptz not null default now(),
	primary key (tenant_id, first_id)
);

-- Which table owns a pi id, tenant-wide. This is what keeps ids unique across partitions.
create table pim_runtime.record_ids (
	tenant_id text not null,
	id bigint not null,
	kind text not null check (kind in ('conversation', 'entry', 'task', 'submission', 'document')),
	partition_id text not null,
	primary key (tenant_id, id),
	foreign key (tenant_id, partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);
create index record_ids_by_partition on pim_runtime.record_ids (tenant_id, partition_id);

-- Conversation -> partition. Rows are immutable and written in the transaction that creates the conversation. The
-- public chat id (a UUID) is optional and routes the same way.
create table pim_runtime.conversation_partitions (
	tenant_id text not null,
	conversation_id bigint not null,
	partition_id text not null,
	public_chat_id uuid,
	created_at timestamptz not null default now(),
	primary key (tenant_id, conversation_id),
	foreign key (tenant_id, partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);
create unique index conversation_partitions_public_chat on pim_runtime.conversation_partitions (tenant_id, public_chat_id) where public_chat_id is not null;
create index conversation_partitions_by_partition on pim_runtime.conversation_partitions (tenant_id, partition_id);

create function pim_runtime.guard_conversation_partitions() returns trigger language plpgsql as $$
begin
	if tg_op = 'INSERT' then
		if new.conversation_id = 1 and not exists (
			select 1 from pim_runtime.partitions p where p.tenant_id = new.tenant_id and p.partition_id = new.partition_id and p.kind = 'home'
		) then
			raise exception 'conversation 1 belongs to the home partition' using errcode = '23514';
		end if;
		return new;
	end if;
	if tg_op = 'UPDATE' and (new.conversation_id <> old.conversation_id or new.partition_id <> old.partition_id or new.tenant_id <> old.tenant_id) then
		raise exception 'conversation_partitions rows are immutable' using errcode = '23514';
	end if;
	if tg_op = 'DELETE' then
		raise exception 'conversation_partitions rows are immutable' using errcode = '23514';
	end if;
	return new;
end $$;
create trigger conversation_partitions_guard before insert or update or delete on pim_runtime.conversation_partitions
	for each row execute function pim_runtime.guard_conversation_partitions();
