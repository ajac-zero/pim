-- What an app keeps and is allowed through `window.pim` (the web app's bridge).
-- `app_data` is text under keys, kept across an app's versions. `app_key` names the app as the row's owner knows it: the app's id for the owner's own app
-- (scope 'own' is what the owner keeps for themselves, 'shared' what everyone using the app sees), `<host owner id>/<id>` for another person's app shared with
-- them and `gallery/<published id>` for a published one (scope 'own', in the viewer's space). Shared rows live in the app owner's space only.
CREATE TABLE pim_app.app_data (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	app_key text NOT NULL,
	scope text NOT NULL CHECK (scope IN ('own', 'shared')),
	key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
	value text NOT NULL,
	size integer NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, app_key, scope, key)
);
SELECT pim_app.seal_tenant('pim_app.app_data');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.app_data TO pim_gate;

-- What a person let one version of an app use (`model`, or `tool:<connector>/<tool>`), keyed by the version's digest: a new version, which is new code, asks again.
CREATE TABLE pim_app.app_grants (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	app_key text NOT NULL,
	sha256 text NOT NULL,
	capability text NOT NULL,
	granted_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, app_key, sha256, capability)
);
SELECT pim_app.seal_tenant('pim_app.app_grants');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.app_grants TO pim_gate;

-- Deleting an app deletes what it kept and what was granted to it.
CREATE FUNCTION pim_app.forget_app_data() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM pim_app.app_data WHERE owner_id = OLD.owner_id AND app_key = OLD.id;
	DELETE FROM pim_app.app_grants WHERE owner_id = OLD.owner_id AND app_key = OLD.id;
	RETURN OLD;
END $$;
CREATE TRIGGER artifacts_forget_data AFTER DELETE ON pim_app.artifacts FOR EACH ROW EXECUTE FUNCTION pim_app.forget_app_data();
