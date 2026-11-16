-- Stall supervision: one episode per source, so a quiet spell wakes the originating chat once and escalates once.
create table pim_forge.forge_stall_episodes (
	source text primary key,
	progress_at bigint not null,
	stage integer not null,
	woken_at bigint not null,
	hard integer not null default 0
);
