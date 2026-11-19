-- What v1's goals had that v2's lost: a goal can be paused (kept, but not among the active goals an agent is told of), and an agent records progress notes on it.
ALTER TABLE pim_app.goals DROP CONSTRAINT goals_status_check, ADD CONSTRAINT goals_status_check CHECK (status IN ('active', 'paused', 'done', 'dropped')), ADD COLUMN notes jsonb NOT NULL DEFAULT '[]';
