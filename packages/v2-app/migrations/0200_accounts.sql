-- The application ledger replaces the Directory, Auth and Gallery Durable Objects and the per-space pim_* tables.
-- Tenant tables carry owner_id and are sealed by row-level security keyed on the transaction-local setting pim.owner_id,
-- so a pooled connection that served one tenant can never leak that tenant's rows to the next (a missing setting matches nothing).
-- The schema, the roles and public.pim_current_owner_id() come from 0001_foundation.sql in @pim/v2-contracts.

CREATE FUNCTION pim_app.cur_lookup() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('pim.lookup', true), '') $$;

-- Seals a table to its owner. Every command is checked, and the table is forced so even its owner role obeys.
CREATE FUNCTION pim_app.seal_tenant(tbl regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
	EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
	EXECUTE format('CREATE POLICY tenant ON %s USING (owner_id = public.pim_current_owner_id()) WITH CHECK (owner_id = public.pim_current_owner_id())', tbl);
END $$;

-- Seals a table to its owner, and lets a caller holding the secret key `col` names (a token hash, a credential id) find that one row
-- before the owner is known. The key is also set per transaction, so it never outlives one.
CREATE FUNCTION pim_app.seal_lookup(tbl regclass, col text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
	EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
	EXECUTE format('CREATE POLICY sel ON %s FOR SELECT USING (owner_id = public.pim_current_owner_id() OR %I::text = pim_app.cur_lookup())', tbl, col);
	EXECUTE format('CREATE POLICY ins ON %s FOR INSERT WITH CHECK (owner_id = public.pim_current_owner_id())', tbl);
	EXECUTE format('CREATE POLICY upd ON %s FOR UPDATE USING (owner_id = public.pim_current_owner_id() OR %I::text = pim_app.cur_lookup()) WITH CHECK (owner_id = public.pim_current_owner_id() OR %I::text = pim_app.cur_lookup())', tbl, col, col);
	EXECUTE format('CREATE POLICY del ON %s FOR DELETE USING (owner_id = public.pim_current_owner_id() OR %I::text = pim_app.cur_lookup())', tbl, col);
END $$;

CREATE TABLE pim_app.accounts (
	owner_id text PRIMARY KEY CHECK (owner_id ~ '^o_[A-Za-z0-9_-]+$'),
	username text NOT NULL UNIQUE,
	role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'guest')),
	status text NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'deleting', 'deleted')),
	bot boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	activated_at timestamptz,
	pending_until timestamptz,
	status_reason text,
	status_changed_at timestamptz
);
CREATE INDEX accounts_by_status ON pim_app.accounts (status, created_at);

-- Identity facts never change: the owner id and username are immutable, an account is never removed (a deleted one stays as a tombstone),
-- and an instance never loses its last active admin, whichever code path tries it.
CREATE FUNCTION pim_app.guard_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
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

-- The active admins, readable whichever tenant is current: the guard above must see other tenants' admins, which row security hides.
CREATE VIEW pim_app.admin_roster AS SELECT owner_id FROM pim_app.accounts WHERE role = 'admin' AND status = 'active';
CREATE TRIGGER accounts_guard BEFORE UPDATE OR DELETE ON pim_app.accounts FOR EACH ROW EXECUTE FUNCTION pim_app.guard_account();

ALTER TABLE pim_app.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pim_app.accounts FORCE ROW LEVEL SECURITY;
-- An account's identity is public to the instance (people, sharing, sign-in need it); only its owner changes it.
CREATE POLICY sel ON pim_app.accounts FOR SELECT USING (true);
CREATE POLICY ins ON pim_app.accounts FOR INSERT WITH CHECK (owner_id = public.pim_current_owner_id());
CREATE POLICY upd ON pim_app.accounts FOR UPDATE USING (owner_id = public.pim_current_owner_id()) WITH CHECK (owner_id = public.pim_current_owner_id());
CREATE POLICY del ON pim_app.accounts FOR DELETE USING (owner_id = public.pim_current_owner_id());

-- A username is claimed once and never handed to anyone else, even after its account is deleted.
CREATE TABLE pim_app.usernames (
	username text PRIMARY KEY,
	owner_id text NOT NULL,
	claimed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pim_app.usernames ENABLE ROW LEVEL SECURITY;
ALTER TABLE pim_app.usernames FORCE ROW LEVEL SECURITY;
CREATE POLICY sel ON pim_app.usernames FOR SELECT USING (true);
CREATE POLICY ins ON pim_app.usernames FOR INSERT WITH CHECK (owner_id = public.pim_current_owner_id());

CREATE TABLE pim_app.invites (
	code_hash text PRIMARY KEY,
	owner_id text NOT NULL,
	note text,
	created_at timestamptz NOT NULL DEFAULT now(),
	used_by text,
	used_at timestamptz
);
SELECT pim_app.seal_lookup('pim_app.invites', 'code_hash');

-- Instance-level state with no tenant data: settings (registration open or closed, limits), registration attempts, and one-time
-- bootstrap and admin-recovery claim codes (kept as hashes; the first claim window is closed by setting).
CREATE TABLE pim_app.instance_settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE pim_app.registration_attempts (address text NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE INDEX registrations_by_address ON pim_app.registration_attempts (address, at);
CREATE TABLE pim_app.claim_codes (
	code_hash text PRIMARY KEY,
	kind text NOT NULL CHECK (kind IN ('bootstrap', 'admin_recovery')),
	owner_id text,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	used_at timestamptz
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;
