-- Document incarnations and their base/delta revisions (Chord tracked state).

create table pim_runtime.documents (
	owner_id text not null,
	partition_id uuid not null,
	id bigint not null,
	-- kind and doc_key hold ident()-encoded strings (see the runtime's ident()).
	kind text not null,
	doc_key text,
	scope_kind text not null check (scope_kind in ('session', 'conversation', 'task')),
	scope_id bigint,
	history text check (history in ('latest', 'rewindable')),
	fork text,
	created_at bigint not null,
	retired_at bigint,
	-- The DocumentCreate pi supplied, without createdAt and retiredAt, which are columns.
	record text not null,
	primary key (owner_id, id),
	foreign key (owner_id, partition_id) references pim_runtime.partitions (owner_id, partition_id)
);
-- At most one live incarnation per logical address.
create unique index documents_one_current on pim_runtime.documents
	(owner_id, partition_id, kind, scope_kind, coalesce(scope_id, 0), (doc_key is not null), coalesce(doc_key, ''))
	where retired_at is null;
create index documents_by_address on pim_runtime.documents
	(owner_id, partition_id, kind, scope_kind, coalesce(scope_id, 0), (doc_key is not null), coalesce(doc_key, ''), created_at);
create index documents_by_scope on pim_runtime.documents (owner_id, partition_id, scope_kind, coalesce(scope_id, 0), id);

create table pim_runtime.document_revisions (
	owner_id text not null,
	partition_id uuid not null,
	document_id bigint not null,
	seq bigint not null,
	kind text not null check (kind in ('base', 'delta')),
	version integer not null,
	content text not null,
	primary key (owner_id, document_id, seq),
	foreign key (owner_id, document_id) references pim_runtime.documents (owner_id, id)
);
