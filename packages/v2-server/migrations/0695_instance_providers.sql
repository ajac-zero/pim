-- Model providers the deployment's admin shared with everyone (the old Pim's "shared" providers), kept as the deployment's own rather than copied into each person's
-- space: a person's own providers can be pointed anywhere, and a copy would let them send the admin's key to an address of their choosing. Nothing but the migration's
-- promotion writes here and nothing reads the table directly; a Runner takes the rows with the definer function below, and the key stays sealed under the deployment's
-- key ring (context `provider:_instance/<id>`). A shared provider is named `shared:<id>` in the catalog, as the old Pim named it, so the models agents and chats name still resolve.
CREATE TABLE pim_app.instance_providers (
	id text PRIMARY KEY,
	kind text NOT NULL,
	config jsonb NOT NULL DEFAULT '{}',
	secret text,
	created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON pim_app.instance_providers FROM pim_gate;

CREATE OR REPLACE FUNCTION pim_app.runner_providers(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT coalesce(jsonb_agg(row ORDER BY row->>'id'), '[]'::jsonb) INTO result FROM (
		SELECT jsonb_build_object('id', id, 'kind', kind, 'config', config, 'secret', secret) AS row FROM pim_app.providers WHERE owner_id = p_owner
		UNION ALL
		SELECT jsonb_build_object('id', 'shared:' || id, 'kind', kind, 'config', config, 'secret', secret, 'shared', true) FROM pim_app.instance_providers
	) all_rows;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

-- What the web app needs to offer a shared provider's models: its name and models, never its key or address.
CREATE FUNCTION pim_app.instance_provider_models() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
	SELECT coalesce(jsonb_agg(jsonb_build_object('id', 'shared:' || id, 'name', coalesce(config->>'name', id), 'models', coalesce(config->'models', '[]'::jsonb)) ORDER BY id), '[]'::jsonb) FROM pim_app.instance_providers
$$;
REVOKE ALL ON FUNCTION pim_app.instance_provider_models() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.instance_provider_models() TO pim_gate;
