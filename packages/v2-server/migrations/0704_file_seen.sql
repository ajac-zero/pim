-- The files each chat's agent has seen, as a hash and (while small) their text, so the next message the person sends can tell the agent which of them changed since (v1's pim_file_seen).
-- Twenty at most per chat: the Runner keeps the most recently seen. A deleted chat takes its rows with it.
CREATE TABLE pim_app.file_seen (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	chat_id uuid NOT NULL REFERENCES pim_app.conversations (public_chat_id) ON DELETE CASCADE,
	path text NOT NULL,
	sha256 text NOT NULL,
	text text,
	seen_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, chat_id, path)
);
SELECT pim_app.seal_tenant('pim_app.file_seen');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.file_seen TO pim_gate;
