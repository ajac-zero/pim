-- Triggers that run on the person's computer (poll, stream, process): a grant is for one source's exact configuration on one computer, and the space keeps its
-- epoch and desired revision with that computer's runtime (computer/triggers-runtime.ts, docs/triggers-runtime.md) so a reconnect resumes it.
ALTER TABLE pim_app.trigger_computer_grants ADD COLUMN config_hash text, ADD COLUMN grant_ref text;
-- What a trigger's condition remembers between observations (its edge, and what `changed`, `stable_for` and `hysteresis` hold).
ALTER TABLE pim_app.triggers ADD COLUMN condition_state jsonb;

CREATE TABLE pim_app.trigger_computer_runtimes (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	runtime_id text NOT NULL,
	server_epoch integer NOT NULL,
	desired_revision integer NOT NULL DEFAULT 0,
	desired_digest text,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, runtime_id)
);
SELECT pim_app.seal_tenant('pim_app.trigger_computer_runtimes');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.trigger_computer_runtimes TO pim_gate;
