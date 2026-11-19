-- An environment whose snapshot was found not worth keeping (restoring it would take longer than setting it up again): the finding is kept per person and key for 30 days, so their next threads
-- build in place without taking a snapshot only to delete it again.
CREATE TABLE pim_forge.forge_environment_skips (
	owner_id text NOT NULL,
	key text NOT NULL,
	decided_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, key)
);
