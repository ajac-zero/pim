-- Agents, skills, memories, goals, schedules, triggers, approvals, durable tool operations, providers, connectors and usage.
CREATE TABLE pim_app.agents (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	name text NOT NULL,
	instructions text NOT NULL DEFAULT '',
	model text,
	config jsonb NOT NULL DEFAULT '{}',
	created_at timestamptz NOT NULL DEFAULT now(),
	deleted_at timestamptz,
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.agents');

CREATE TABLE pim_app.skills (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	name text NOT NULL,
	description text NOT NULL DEFAULT '',
	body text NOT NULL DEFAULT '',
	files jsonb NOT NULL DEFAULT '{}',
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.skills');

-- Memory scopes: agent-<id>, everyone, or a custom shared scope.
CREATE TABLE pim_app.memories (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	scope text NOT NULL,
	title text NOT NULL,
	body text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	deleted_at timestamptz,
	PRIMARY KEY (owner_id, id)
);
CREATE INDEX memories_by_scope ON pim_app.memories (owner_id, scope) WHERE deleted_at IS NULL;
SELECT pim_app.seal_tenant('pim_app.memories');

CREATE TABLE pim_app.goals (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	title text NOT NULL,
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dropped')),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.goals');
CREATE TABLE pim_app.goal_steps (
	goal_id text NOT NULL,
	owner_id text NOT NULL,
	position integer NOT NULL,
	title text NOT NULL,
	done boolean NOT NULL DEFAULT false,
	PRIMARY KEY (owner_id, goal_id, position),
	FOREIGN KEY (owner_id, goal_id) REFERENCES pim_app.goals (owner_id, id) ON DELETE CASCADE
);
SELECT pim_app.seal_tenant('pim_app.goal_steps');

-- A schedule fires by cron, at one time, or after a delay, into a new chat or the same chat. next_run_at is the next occurrence
-- not yet handled; occurrences missed while the system was down are recorded, not replayed.
CREATE TABLE pim_app.schedules (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	agent_id text,
	kind text NOT NULL CHECK (kind IN ('cron', 'at', 'delay')),
	spec text NOT NULL,
	every_ms bigint,
	target text NOT NULL DEFAULT 'new_chat' CHECK (target IN ('new_chat', 'same_chat')),
	chat_id uuid,
	prompt text NOT NULL,
	next_run_at timestamptz,
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
CREATE INDEX schedules_due ON pim_app.schedules (next_run_at) WHERE enabled;
SELECT pim_app.seal_tenant('pim_app.schedules');
CREATE TABLE pim_app.schedule_runs (
	owner_id text NOT NULL,
	schedule_id text NOT NULL,
	occurrence timestamptz NOT NULL,
	outcome text NOT NULL CHECK (outcome IN ('fired', 'missed')),
	command_id text,
	recorded_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, schedule_id, occurrence)
);
SELECT pim_app.seal_tenant('pim_app.schedule_runs');

-- Connector event watches and computer file/poll/stream/process triggers; computer triggers need a computer grant (capability 'compute').
CREATE TABLE pim_app.triggers (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	agent_id text,
	source text NOT NULL CHECK (source IN ('connector', 'computer_file', 'computer_poll', 'computer_stream', 'computer_process')),
	spec jsonb NOT NULL,
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.triggers');

CREATE TABLE pim_app.approvals (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	public_chat_id uuid,
	tool text NOT NULL,
	args jsonb NOT NULL DEFAULT '{}',
	state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'approved', 'denied', 'timed_out_denied', 'timed_out_approved')),
	timeout_policy text NOT NULL DEFAULT 'deny' CHECK (timeout_policy IN ('deny', 'approve')),
	expires_at timestamptz,
	decided_by text,
	decided_at timestamptz,
	via_standing_grant text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.approvals');

-- Durable tool operations (the ExternalOperationRecord contract). An operation whose outcome cannot be known is never run again
-- blind: it waits for reconciliation. `idempotent` says whether the provider honours idempotency_key, which is what makes a retry safe.
CREATE TABLE pim_app.external_operations (
	operation_id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	partition_id uuid NOT NULL,
	task_id text NOT NULL,
	tool_name text NOT NULL,
	capability text NOT NULL,
	idempotency_key text NOT NULL,
	idempotent boolean NOT NULL DEFAULT false,
	state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled', 'cancel_uncertain', 'needs_reconciliation')),
	receipt jsonb,
	early_signal jsonb,
	deadline_at timestamptz,
	attempts integer NOT NULL DEFAULT 0,
	error text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, operation_id)
);
SELECT pim_app.seal_tenant('pim_app.external_operations');

CREATE TABLE pim_app.providers (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	kind text NOT NULL,
	config jsonb NOT NULL DEFAULT '{}',
	secret text,
	fallback_order integer,
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.providers');

CREATE TABLE pim_app.connectors (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	kind text NOT NULL CHECK (kind IN ('builtin', 'native', 'custom_mcp')),
	name text NOT NULL,
	credential text,
	discovered_tools jsonb NOT NULL DEFAULT '[]',
	enabled_tools text[] NOT NULL DEFAULT '{}',
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.connectors');

CREATE TABLE pim_app.model_calls (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	run_kind text NOT NULL DEFAULT 'chat' CHECK (run_kind IN ('chat', 'background', 'coding_thread')),
	public_chat_id uuid,
	provider text,
	model text,
	input_tokens bigint NOT NULL DEFAULT 0,
	output_tokens bigint NOT NULL DEFAULT 0,
	cost_microusd bigint NOT NULL DEFAULT 0,
	at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
CREATE INDEX model_calls_by_time ON pim_app.model_calls (owner_id, at);
SELECT pim_app.seal_tenant('pim_app.model_calls');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;

-- Which owners have a schedule due, so a scheduler tick finds work without reading across tenants. It holds an owner id and a time, nothing else.
CREATE TABLE pim_app.schedule_wakeups (owner_id text PRIMARY KEY, next_at timestamptz NOT NULL);
CREATE INDEX wakeups_by_time ON pim_app.schedule_wakeups (next_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.schedule_wakeups TO pim_gate;
