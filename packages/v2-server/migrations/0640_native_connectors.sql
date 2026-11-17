-- Connectors made from the directory (native ones Pim implements itself, and the directory's MCP servers) remember which directory entry they connect, and where their
-- sign-in stands. `app_ref` is the directory's `<extension>/<app>` (`google/gmail`, `pim.apps/linear`, `custom/<id>`); a connector added by its address has none. A person has at
-- most one connection per directory entry. `auth_url` is where to send the person while `status` is 'auth_required' (the sign-in itself lives in `auth_flows`, ten minutes), and
-- `error` is why a sign-in or a connection failed, in words the person can read.
ALTER TABLE pim_app.connectors ADD COLUMN app_ref text, ADD COLUMN auth_url text, ADD COLUMN error text;
CREATE UNIQUE INDEX connectors_one_per_directory_app ON pim_app.connectors (owner_id, app_ref) WHERE app_ref IS NOT NULL;

-- What a Runner needs to offer and call an owner's connector tools: now also the native connectors (no address), with their directory entry. The sealed credential stays sealed.
CREATE OR REPLACE FUNCTION pim_app.runner_connectors(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'name', name, 'url', url, 'status', status, 'credential', credential, 'enabledTools', to_jsonb(enabled_tools), 'approval', approval, 'appRef', app_ref) ORDER BY created_at), '[]'::jsonb)
		INTO result FROM pim_app.connectors WHERE owner_id = p_owner AND (url IS NOT NULL OR kind = 'native');
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;
