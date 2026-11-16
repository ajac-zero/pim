-- Operations-owned tables: the migration ledger lives in pim.ops_migrations (made by the runner itself);
-- these are the cutover record, the external-operation ledger the restore pass and the importer write to,
-- the due-work table the Runner reads schedules from, and the adopted remote coding threads.
CREATE SCHEMA IF NOT EXISTS pim;

CREATE TABLE pim.ops_cutover (
	cutover_id text PRIMARY KEY,
	cutover_at_ms bigint NOT NULL,
	state text NOT NULL CHECK (state IN ('importing', 'imported', 'verified', 'activated', 'rolled_back', 'failed')),
	source_manifest_sha256 text NOT NULL,
	report jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every effect outside the database that a Runner may perform or has performed. A row in
-- needs_reconciliation is never executed again by a Runner: a person or a provider-specific
-- reconciler resolves it to reconciled, succeeded or failed.
CREATE TABLE pim.external_operations (
	id text PRIMARY KEY,
	tenant_id text NOT NULL,
	partition_id text,
	kind text NOT NULL,
	idempotency_key text NOT NULL,
	status text NOT NULL CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed', 'needs_reconciliation', 'reconciled')),
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	origin text NOT NULL,
	reason text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX external_operations_by_status ON pim.external_operations (status, tenant_id);

-- Schedules and queued firings. A Runner may fire only rows whose next_due_at is in the future of the
-- cutover; skip_before_ms is the cutover time, and every occurrence at or before it is recorded in
-- missed instead of being fired.
CREATE TABLE pim.due_work (
	tenant_id text NOT NULL,
	kind text NOT NULL,
	key text NOT NULL,
	state text NOT NULL CHECK (state IN ('armed', 'done', 'recompute', 'dropped')),
	next_due_at_ms bigint,
	skip_before_ms bigint NOT NULL,
	missed jsonb NOT NULL DEFAULT '[]'::jsonb,
	spec jsonb,
	PRIMARY KEY (tenant_id, kind, key)
);
CREATE INDEX due_work_by_due ON pim.due_work (next_due_at_ms) WHERE state = 'armed';

-- Remote coding sessions that run in a provider's cloud: adopted by their remote id, never started again.
CREATE TABLE pim.remote_threads (
	tenant_id text NOT NULL,
	thread_id text NOT NULL,
	provider text NOT NULL,
	remote_id text NOT NULL,
	adoption text NOT NULL CHECK (adoption IN ('adopt', 'cancelled', 'unknown')),
	state text,
	last_event_at_ms bigint,
	started_operation_id text,
	PRIMARY KEY (tenant_id, thread_id)
);
