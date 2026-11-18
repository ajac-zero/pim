-- Kept versions of a note: what its live text said at moments worth keeping (the person paused or closed it, before and after an
-- agent's change, a restore), not one per Yjs update. `notes.version` stays the count of updates, for the log; `kept_version` is the
-- number people and agents see. A note made before this has none, and its current text is kept as version 1 the first time it is read.
ALTER TABLE pim_app.notes ADD COLUMN kept_version int NOT NULL DEFAULT 0;
CREATE TABLE pim_app.note_versions (
	owner_id text NOT NULL,
	note_id text NOT NULL,
	version int NOT NULL,
	text text NOT NULL,
	source text NOT NULL CHECK (source IN ('person', 'agent', 'restore')),
	restored_from int,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, note_id, version),
	FOREIGN KEY (owner_id, note_id) REFERENCES pim_app.notes (owner_id, note_id)
);
SELECT pim_app.seal_tenant('pim_app.note_versions');
