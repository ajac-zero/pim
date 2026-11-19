-- A trigger runs one turn at a time. An occurrence that finds its trigger's last run still going waits (`pending`) and is handed to a chat when that run has ended;
-- a delivered run (`fired`) ends as `completed`, or `failed` when its command was refused, or `unknown` when nothing has said how it ended for a day. What waits is
-- bounded by the trigger's `maxPendingEvents`, and a state (a timetable, a poll) keeps only its newest waiting occurrence (the older one is `skipped`, superseded).
ALTER TABLE pim_app.trigger_runs DROP CONSTRAINT trigger_runs_phase_check;
ALTER TABLE pim_app.trigger_runs ADD CONSTRAINT trigger_runs_phase_check CHECK (phase IN ('pending', 'fired', 'delivered', 'completed', 'skipped', 'failed', 'unknown', 'test'));
-- What a waiting occurrence hands over when its turn comes (the message the chat receives), when it was handed over and ended, and the last thing that went wrong with it.
ALTER TABLE pim_app.trigger_runs ADD COLUMN payload jsonb, ADD COLUMN delivered_at timestamptz, ADD COLUMN ended_at timestamptz, ADD COLUMN last_error text;
CREATE INDEX trigger_runs_waiting ON pim_app.trigger_runs (owner_id, trigger_id, at) WHERE phase IN ('pending', 'fired');

-- How a trigger's source is doing, apart from what the person wants of it: as the computer's runtime and the connection say (`TriggerHealth`), when it last observed something,
-- how many handovers failed in a row, and when the next try is due.
ALTER TABLE pim_app.triggers ADD COLUMN health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'healthy', 'waiting_computer', 'reconnecting', 'gap', 'auth_required', 'budget_blocked', 'configuration_error')),
	ADD COLUMN health_detail text, ADD COLUMN last_observed_at timestamptz, ADD COLUMN failures integer NOT NULL DEFAULT 0, ADD COLUMN retry_after timestamptz;
