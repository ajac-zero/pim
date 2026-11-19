-- A tool permission is tied to the tool as it was when the person chose it: a digest of the connector's description, inputs and annotations. A connector that changes a tool the
-- person let run gets it asked about again in their own Pim (On becomes Ask), and taken from a circle's guests or an agent's switch, until they choose anew. A row with no digest
-- (made before it was kept, or carried from v1) is trusted as it stands. Pim's own tools are kept here too, under the empty connector `app`.
ALTER TABLE pim_app.tool_permissions ADD COLUMN definition text;

CREATE OR REPLACE FUNCTION pim_app.runner_tool_permissions(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT coalesce(jsonb_agg(jsonb_build_object('audience', audience, 'app', app, 'tool', tool, 'permission', permission, 'definition', definition)), '[]'::jsonb) INTO result FROM pim_app.tool_permissions WHERE owner_id = p_owner;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;
