-- A chat whose run is held because a subscription's usage limit is used up (the ChatGPT plan) goes on by itself once the limit resets, as v1's did: the Runner that held it leaves a
-- row here for the time the limit ends, and the maintenance role asks the chat's partition to try again then. A row is for one hold; a run the person retried, or that went on
-- some other way, is no longer held when its time comes, and the retry changes nothing.
CREATE TABLE pim_app.held_retries (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	id text NOT NULL,
	public_chat_id uuid NOT NULL,
	resume_at timestamptz NOT NULL,
	reason text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	done_at timestamptz,
	PRIMARY KEY (owner_id, id)
);
CREATE INDEX held_retries_due ON pim_app.held_retries (resume_at) WHERE done_at IS NULL;
SELECT pim_app.seal_tenant('pim_app.held_retries');
-- As approvals (0603): maintenance finds the retries that are due across owners by setting pim.scope to 'all' to read, and writes one owner at a time.
CREATE POLICY sweep_scope ON pim_app.held_retries FOR SELECT USING (current_setting('pim.scope', true) = 'all');
