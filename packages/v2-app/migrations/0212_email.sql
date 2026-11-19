-- Email to the person. Each person confirms one address in Settings with a code Pim emails there, and Pim emails only that address. A code waits for 30 minutes
-- and five wrong tries; `emails_sent` is the record of what Pim sent (a message by its id, so a replayed tool call sends nothing twice; a code has no chat), which
-- is also what the daily limits count.
CREATE TABLE pim_app.email_addresses (
	owner_id text PRIMARY KEY REFERENCES pim_app.accounts (owner_id),
	address text NOT NULL,
	confirmed_at timestamptz NOT NULL DEFAULT now()
);
SELECT pim_app.seal_tenant('pim_app.email_addresses');

CREATE TABLE pim_app.email_pending (
	owner_id text PRIMARY KEY REFERENCES pim_app.accounts (owner_id),
	address text NOT NULL,
	digest text NOT NULL,
	expires_at timestamptz NOT NULL,
	attempts integer NOT NULL DEFAULT 0
);
SELECT pim_app.seal_tenant('pim_app.email_pending');

CREATE TABLE pim_app.emails_sent (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	id text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('code', 'message')),
	public_chat_id uuid,
	subject text NOT NULL,
	sent_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
CREATE INDEX emails_sent_by_day ON pim_app.emails_sent (owner_id, kind, sent_at);
SELECT pim_app.seal_tenant('pim_app.emails_sent');
