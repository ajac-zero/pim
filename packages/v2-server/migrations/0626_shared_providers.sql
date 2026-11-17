-- Model providers the admin shares with everyone (config.shared = true on a provider of an active admin). Everyone's catalog offers them beside their own:
-- the Gate lists them without their keys, and a Runner reads them with the sealed key, which it opens under the admin's owner id as it was sealed. The function
-- filters for itself as well as through the policy: a definer that owns its tables is not bound by row-level security.
CREATE POLICY shared_providers ON pim_app.providers FOR SELECT USING (
	current_setting('pim.scope', true) = 'shared_providers'
	AND config->>'shared' = 'true'
	AND EXISTS (SELECT 1 FROM pim_app.accounts a WHERE a.owner_id = providers.owner_id AND a.role = 'admin' AND a.status = 'active')
);

CREATE FUNCTION pim_app.shared_providers(p_secret boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.scope', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.scope', 'shared_providers', true);
	SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'owner', owner_id, 'kind', kind, 'config', config, 'hasKey', secret IS NOT NULL, 'secret', CASE WHEN p_secret THEN secret END) ORDER BY owner_id, id), '[]'::jsonb)
		INTO result FROM pim_app.providers p
		WHERE p.config->>'shared' = 'true' AND EXISTS (SELECT 1 FROM pim_app.accounts a WHERE a.owner_id = p.owner_id AND a.role = 'admin' AND a.status = 'active');
	PERFORM set_config('pim.scope', previous, true);
	RETURN result;
END $$;

REVOKE ALL ON FUNCTION pim_app.shared_providers(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.shared_providers(boolean) TO pim_gate, pim_runtime;
