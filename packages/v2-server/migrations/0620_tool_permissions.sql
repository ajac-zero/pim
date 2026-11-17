-- What a person lets an agent do with a connector's tools: Off, Ask first, or On. A row is a choice; without one the connector's approval policy decides
-- (a read-only tool runs, any other asks). `audience` is 'owner' for the person's own choice, or 'agent:<id>' for one agent's switch (only on or off).
-- `app` is the connector's id. "Always approve" on an approval is a standing approval (pim_app.standing_approvals), not a row here.
CREATE TABLE pim_app.tool_permissions (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	audience text NOT NULL DEFAULT 'owner',
	app text NOT NULL,
	tool text NOT NULL,
	permission text NOT NULL CHECK (permission IN ('off', 'ask', 'on')),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, audience, app, tool)
);
SELECT pim_app.seal_tenant('pim_app.tool_permissions');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.tool_permissions TO pim_gate;

-- Which of a connector's tools ask first by default: those that do not declare themselves read-only (writes), every tool (all), or none.
ALTER TABLE pim_app.connectors ADD COLUMN approval text NOT NULL DEFAULT 'writes' CHECK (approval IN ('writes', 'all', 'none'));

-- What a Runner needs to offer and call an owner's connector tools. The sealed credential stays sealed: the Runner opens it with the deployment's keys.
CREATE FUNCTION pim_app.runner_connectors(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'name', name, 'url', url, 'status', status, 'credential', credential, 'enabledTools', to_jsonb(enabled_tools), 'approval', approval) ORDER BY created_at), '[]'::jsonb)
		INTO result FROM pim_app.connectors WHERE owner_id = p_owner AND url IS NOT NULL;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

CREATE FUNCTION pim_app.runner_tool_permissions(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT coalesce(jsonb_agg(jsonb_build_object('audience', audience, 'app', app, 'tool', tool, 'permission', permission)), '[]'::jsonb) INTO result FROM pim_app.tool_permissions WHERE owner_id = p_owner;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

-- A refreshed credential, sealed by the Runner, replaces the one it was given; only for a connector that has one.
CREATE FUNCTION pim_app.runner_set_connector_credential(p_owner text, p_id text, p_sealed text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	changed integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	UPDATE pim_app.connectors SET credential = p_sealed, status = 'connected' WHERE owner_id = p_owner AND id = p_id AND credential IS NOT NULL;
	GET DIAGNOSTICS changed = ROW_COUNT;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN changed > 0;
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_connectors(text), pim_app.runner_tool_permissions(text), pim_app.runner_set_connector_credential(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_connectors(text), pim_app.runner_tool_permissions(text), pim_app.runner_set_connector_credential(text, text, text) TO pim_runtime;
