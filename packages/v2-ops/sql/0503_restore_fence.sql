-- A restored database must not let a Runner start until the post-restore safety pass has run. Runners read the newest
-- row of this table at boot and refuse to claim work unless its state is 'reconciled' (or the table is empty).
CREATE TABLE pim.ops_restore (
	restore_id text PRIMARY KEY,
	restored_at timestamptz NOT NULL DEFAULT now(),
	backup_id text,
	target_time timestamptz,
	state text NOT NULL CHECK (state IN ('restored', 'reconciled')),
	summary jsonb
);
