-- The longest a person's sandbox workspace may run (a session), and when each running stretch of the compute ledger must end: the session limit or the month's minutes left, whichever is less.
alter table pim_forge.forge_quotas add column max_session_minutes integer;
alter table pim_forge.forge_compute_usage add column cap_at timestamptz;
create index forge_compute_usage_open on pim_forge.forge_compute_usage (thread_id) where ended_at is null;
