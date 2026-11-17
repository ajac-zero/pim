-- What the web app's chat surfaces keep that the Gate had nowhere to put: a person's named memory scopes (Work, Family) and what a ```ui block of a message
-- holds as they change it. Both are the person's own rows, sealed to their owner.
CREATE TABLE pim_app.memory_scopes (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	key text NOT NULL,
	name text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, key)
);
SELECT pim_app.seal_tenant('pim_app.memory_scopes');

CREATE TABLE pim_app.ui_states (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	message_id text NOT NULL,
	block text NOT NULL,
	version integer NOT NULL,
	state jsonb NOT NULL,
	submitted boolean NOT NULL DEFAULT false,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, message_id, block)
);
SELECT pim_app.seal_tenant('pim_app.ui_states');

GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.memory_scopes, pim_app.ui_states TO pim_gate;
