-- A connector's tools are listed again each time a Runner works with them, and a tool the server has changed since it was discovered has a new definition digest. The Runner
-- hands the digests it saw to this function, which brings the ones kept in `discovered_tools` up to date (nothing is written when they already match), so the permissions screen
-- compares a person's choice with the tool as it is now. It touches only the digests of tools already discovered; a permission row keeps the digest it was chosen under.
CREATE FUNCTION pim_app.runner_refresh_tool_digests(p_owner text, p_id text, p_digests jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	changed integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	UPDATE pim_app.connectors c SET discovered_tools = n.tools
	FROM (
		SELECT coalesce(jsonb_agg(CASE WHEN d.definition IS NULL THEN t.tool ELSE t.tool || jsonb_build_object('definition', d.definition) END ORDER BY t.ord), '[]'::jsonb) AS tools
		FROM jsonb_array_elements((SELECT discovered_tools FROM pim_app.connectors WHERE owner_id = p_owner AND id = p_id)) WITH ORDINALITY AS t(tool, ord)
		LEFT JOIN jsonb_to_recordset(p_digests) AS d(name text, definition text) ON d.name = t.tool->>'name'
	) n
	WHERE c.owner_id = p_owner AND c.id = p_id AND c.discovered_tools IS DISTINCT FROM n.tools;
	GET DIAGNOSTICS changed = ROW_COUNT;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN changed > 0;
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_refresh_tool_digests(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_refresh_tool_digests(text, text, jsonb) TO pim_runtime;
