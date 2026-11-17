-- Guests of shared bots, what a circle may use, visits, and the application's own rate limits.

-- A guest joined through a bot's public link: their account has role 'guest', and this row says which bot and whose (the host's) it is, and which agent is
-- their copy of it. The guest's chats run in their own space; the bot's tools run in the host's, through the Guests service.
CREATE TABLE pim_app.guest_bots (
	owner_id text PRIMARY KEY REFERENCES pim_app.accounts (owner_id),
	bot_id text NOT NULL,
	host_owner text NOT NULL REFERENCES pim_app.accounts (owner_id),
	agent_id text,
	shared_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now()
);
SELECT pim_app.seal_tenant('pim_app.guest_bots');

-- What a host's guests did, by day (the limit on calls a guest may make) and as a log the host reads (kept to the last 500 rows by the service).
CREATE TABLE pim_app.guest_calls (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	guest text NOT NULL,
	day date NOT NULL,
	calls integer NOT NULL DEFAULT 0,
	messages integer NOT NULL DEFAULT 0,
	PRIMARY KEY (owner_id, guest, day)
);
SELECT pim_app.seal_tenant('pim_app.guest_calls');

CREATE TABLE pim_app.guest_activity (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	id bigserial,
	at timestamptz NOT NULL DEFAULT now(),
	guest text NOT NULL,
	username text NOT NULL,
	audience text NOT NULL,
	tool text NOT NULL,
	outcome text NOT NULL CHECK (outcome IN ('ran', 'asked', 'refused')),
	summary text NOT NULL DEFAULT '',
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.guest_activity');

-- Circles: they can be paused, may let their members read named memory scopes, and remember when each member came in.
ALTER TABLE pim_app.circles
	ADD COLUMN enabled boolean NOT NULL DEFAULT true,
	ADD COLUMN memory_scopes text[] NOT NULL DEFAULT '{}',
	ADD COLUMN members_at jsonb NOT NULL DEFAULT '{}',
	ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- A circle member's conversation with a host's space: a chat in the member's own space, whose tools reach the host's through the circle's permissions.
CREATE TABLE pim_app.visit_links (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	host_owner text NOT NULL REFERENCES pim_app.accounts (owner_id),
	chat uuid NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, host_owner)
);
SELECT pim_app.seal_tenant('pim_app.visit_links');
CREATE INDEX visit_links_by_chat ON pim_app.visit_links (owner_id, chat);

-- The application's own limits (per address for sign-in and public addresses, per owner for the API): a window and what has hit it. A name is the limit's,
-- a key is a digest of the address or the owner, so the table holds nothing that names a person.
CREATE TABLE pim_app.rate_limits (
	name text NOT NULL,
	key text NOT NULL,
	window_ends timestamptz NOT NULL,
	hits integer NOT NULL,
	PRIMARY KEY (name, key)
);
CREATE INDEX rate_limits_by_end ON pim_app.rate_limits (window_ends);

GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.guest_bots, pim_app.guest_calls, pim_app.guest_activity, pim_app.visit_links, pim_app.rate_limits TO pim_gate;
GRANT USAGE ON SEQUENCE pim_app.guest_activity_id_seq TO pim_gate;
