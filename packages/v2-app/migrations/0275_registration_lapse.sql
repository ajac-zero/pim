-- A registration nobody made a passkey for lapses after a day and gives its username, its invite and its place back (v1's Directory did the same).
-- So an account that is still `pending` may be removed, and with it its username; every other account is still a tombstone at most. An invite whose
-- account is gone counts as unused again.
CREATE OR REPLACE FUNCTION pim_app.guard_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.status = 'pending' THEN RETURN OLD; END IF;
		RAISE EXCEPTION 'accounts are tombstoned, never removed' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.owner_id <> OLD.owner_id OR NEW.username <> OLD.username THEN
		RAISE EXCEPTION 'owner id and username are immutable' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.role = 'admin' AND OLD.status = 'active' AND (NEW.role <> 'admin' OR NEW.status <> 'active') THEN
		-- Two admins stepping down at once must not both pass the check.
		PERFORM pg_advisory_xact_lock(hashtext('pim_app.admin_roster'));
	END IF;
	IF OLD.role = 'admin' AND OLD.status = 'active' AND (NEW.role <> 'admin' OR NEW.status <> 'active')
		AND NOT EXISTS (SELECT 1 FROM pim_app.admin_roster WHERE owner_id <> OLD.owner_id) THEN
		RAISE EXCEPTION 'last admin cannot be demoted, suspended or deleted' USING ERRCODE = 'P0002';
	END IF;
	RETURN NEW;
END $$;

CREATE POLICY del ON pim_app.usernames FOR DELETE USING (owner_id = public.pim_current_owner_id());
