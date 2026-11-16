-- Tasks and submissions. pi 1.1.0 task states are pending, running, waiting, completing and terminal; a terminal task's
-- outcome (completed, failed, aborted, orphaned or faulted) is in outcome_status. A suspended task is "waiting" with an
-- empty `on`.

create table pim_runtime.tasks (
	tenant_id text not null,
	partition_id text not null,
	id bigint not null,
	conversation_id bigint not null,
	-- kind and request_id hold ident()-encoded strings, so any JavaScript string (a lone surrogate included) is stored losslessly.
	kind text not null,
	status text not null check (status in ('pending', 'running', 'waiting', 'completing', 'terminal')),
	outcome_status text,
	abort_requested boolean not null,
	background boolean not null,
	record text not null,
	primary key (tenant_id, id),
	foreign key (tenant_id, partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);
create index tasks_by_status on pim_runtime.tasks (tenant_id, partition_id, status, id);
create index tasks_by_conversation on pim_runtime.tasks (tenant_id, partition_id, conversation_id, id);
create index tasks_by_kind on pim_runtime.tasks (tenant_id, partition_id, kind, id);

create table pim_runtime.submissions (
	tenant_id text not null,
	partition_id text not null,
	id bigint not null,
	conversation_id bigint not null,
	status text not null check (status in ('queued', 'placed', 'done', 'unanswered')),
	request_id text,
	record text not null,
	primary key (tenant_id, id),
	foreign key (tenant_id, partition_id) references pim_runtime.partitions (tenant_id, partition_id)
);
create index submissions_by_status on pim_runtime.submissions (tenant_id, partition_id, status, id);
create index submissions_by_conversation on pim_runtime.submissions (tenant_id, partition_id, conversation_id, id);
create unique index submissions_by_request on pim_runtime.submissions (tenant_id, conversation_id, request_id) where request_id is not null;
