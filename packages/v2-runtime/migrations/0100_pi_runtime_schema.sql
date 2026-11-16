-- The runtime schema: one pi-durable storage per partition (a conversation family), many partitions per owner.
-- Every table is keyed by owner_id so row-level security can fence owners from one another. The pi numeric ids
-- (conversations, entries, tasks, submissions, documents) are one owner-wide namespace; a PartitionId only says which
-- storage a record lives in.

create table pim_runtime.partitions (
	owner_id text not null,
	partition_id uuid not null,
	-- "home" holds conversation 1 (pi's root) and the root-attached optmem.nap; every other partition is a "family".
	kind text not null default 'family' check (kind in ('home', 'family')),
	-- The commit Seq the next commit takes. Seq is per partition, strictly increasing, and may have gaps.
	next_seq bigint not null default 1 check (next_seq >= 1),
	created_at timestamptz not null default now(),
	primary key (owner_id, partition_id)
);
create unique index partitions_one_home on pim_runtime.partitions (owner_id) where kind = 'home';

-- The owner-wide pi id sequence. high_water is the largest id ever leased or imported; ids 1 (the root) is reserved.
create table pim_runtime.owner_id_allocators (
	owner_id text primary key,
	high_water bigint not null default 1 check (high_water >= 1 and high_water <= 9007199254740991)
);

-- An audit trail of leased id blocks. A block is [first_id, last_id]; ids a crashed owner did not use are gaps.
create table pim_runtime.id_blocks (
	owner_id text not null,
	first_id bigint not null,
	last_id bigint not null,
	partition_id uuid,
	epoch bigint,
	leased_at timestamptz not null default now(),
	primary key (owner_id, first_id)
);

-- Which table owns a pi id, owner-wide. This is what keeps ids unique across partitions.
create table pim_runtime.record_ids (
	owner_id text not null,
	id bigint not null,
	kind text not null check (kind in ('conversation', 'entry', 'task', 'submission', 'document')),
	partition_id uuid not null,
	primary key (owner_id, id),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create index record_ids_by_partition on pim_runtime.record_ids (owner_id, partition_id);

-- Conversation -> partition. Rows are immutable and written in the transaction that creates the conversation. The
-- public chat id (a UUID) is optional and routes the same way.
create table pim_runtime.conversation_partitions (
	owner_id text not null,
	conversation_id bigint not null,
	partition_id uuid not null,
	public_chat_id uuid not null default gen_random_uuid(),
	created_at timestamptz not null default now(),
	primary key (owner_id, conversation_id),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create unique index conversation_partitions_public_chat on pim_runtime.conversation_partitions (owner_id, public_chat_id);
create index conversation_partitions_by_partition on pim_runtime.conversation_partitions (owner_id, partition_id);

create function pim_runtime.guard_conversation_partitions() returns trigger language plpgsql as $$
begin
	if tg_op = 'INSERT' then
		if new.conversation_id = 1 and not exists (
			select 1 from pim_runtime.partitions p where p.owner_id = new.owner_id and p.partition_id = new.partition_id and p.kind = 'home'
		) then
			raise exception 'conversation 1 belongs to the home partition' using errcode = '23514';
		end if;
		return new;
	end if;
	if tg_op = 'UPDATE' and (new.conversation_id <> old.conversation_id or new.partition_id <> old.partition_id or new.owner_id <> old.owner_id) then
		raise exception 'conversation_partitions rows are immutable' using errcode = '23514';
	end if;
	if tg_op = 'DELETE' then
		raise exception 'conversation_partitions rows are immutable' using errcode = '23514';
	end if;
	return new;
end $$;
create trigger conversation_partitions_guard before insert or update or delete on pim_runtime.conversation_partitions
	for each row execute function pim_runtime.guard_conversation_partitions();
