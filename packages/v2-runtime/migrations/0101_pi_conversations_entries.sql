-- Conversations and entries. The record column keeps the exact JSON text pi wrote (text, so key order and lone surrogates survive, which json and jsonb refuse);
-- the other columns exist for the scans pi asks for.

create table pim_runtime.conversations (
	owner_id text not null,
	partition_id uuid not null,
	id bigint not null,
	parent_conversation_id bigint,
	parent_at bigint,
	owner_conversation_id bigint,
	owner_task_id bigint,
	record text not null,
	primary key (owner_id, id),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create index conversations_by_partition on pim_runtime.conversations (owner_id, partition_id, id);
create index conversations_by_owner_task on pim_runtime.conversations (owner_id, partition_id, owner_task_id, id) where owner_task_id is not null;
create index conversations_by_owner_conversation on pim_runtime.conversations (owner_id, partition_id, owner_conversation_id, id) where owner_conversation_id is not null;

create table pim_runtime.entries (
	owner_id text not null,
	partition_id uuid not null,
	id bigint not null,
	conversation_id bigint not null,
	head bigint,
	commit_seq bigint not null,
	record text not null,
	primary key (owner_id, id),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
create index entries_by_conversation on pim_runtime.entries (owner_id, conversation_id, id);
create index entries_head_markers on pim_runtime.entries (owner_id, conversation_id, id) where head is not null;
