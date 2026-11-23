-- A connector's tools are set for each agent alone, Off until chosen, as Off, Ask or On: nothing about them is set for the whole account any more (not the connector's list of
-- enabled tools, its approval policy, nor the person's own choice, which an agent's switch could only narrow). So that no agent loses a tool it had, what each agent could do
-- is written down as its own choice: for every agent that lists a connector, each tool that was On or Ask for it, as the old rules decided (the person's choice, else the
-- connector's default for an enabled tool that is not destructive; a tool its connector changed since the choice, or that the agent's own switch turned off, is off).
-- The person's own rows for connector tools are then gone. Rows for Pim's own tools (an empty `app`), circles and bots stay as they are.
CREATE TEMP TABLE agent_connector_permissions ON COMMIT DROP AS
SELECT o.owner_id, o.agent_id, o.app, o.tool, o.definition,
	CASE WHEN o.agent_permission = 'off' OR o.agent_changed THEN 'off' WHEN o.owner_changed THEN 'ask' ELSE coalesce(o.owner_permission, o.fallback) END AS permission
FROM (
	SELECT c.owner_id, a.id AS agent_id, c.id AS app, t.value ->> 'name' AS tool, t.value ->> 'definition' AS definition,
		owner_row.permission AS owner_permission, agent_row.permission AS agent_permission,
		CASE WHEN (t.value ->> 'name') = ANY (c.enabled_tools) AND coalesce(t.value -> 'annotations' ->> 'destructiveHint', 'false') <> 'true' THEN CASE WHEN c.approval = 'all' THEN 'ask' ELSE 'on' END ELSE 'off' END AS fallback,
		coalesce(owner_row.permission = 'on' AND owner_row.definition IS NOT NULL AND t.value ->> 'definition' IS NOT NULL AND owner_row.definition <> t.value ->> 'definition', false) AS owner_changed,
		coalesce(agent_row.permission <> 'off' AND agent_row.definition IS NOT NULL AND t.value ->> 'definition' IS NOT NULL AND agent_row.definition <> t.value ->> 'definition', false) AS agent_changed
	FROM pim_app.connectors c
	JOIN pim_app.agents a ON a.owner_id = c.owner_id AND a.deleted_at IS NULL
		AND (a.config -> 'apps' ? c.id OR a.config -> 'apps' ? c.name OR (c.app_ref IS NOT NULL AND a.config -> 'apps' ? c.app_ref))
	CROSS JOIN LATERAL jsonb_array_elements(c.discovered_tools) AS t (value)
	LEFT JOIN pim_app.tool_permissions owner_row ON owner_row.owner_id = c.owner_id AND owner_row.audience = 'owner' AND owner_row.app = c.id AND owner_row.tool = t.value ->> 'name'
	LEFT JOIN pim_app.tool_permissions agent_row ON agent_row.owner_id = c.owner_id AND agent_row.audience = 'agent:' || a.id AND agent_row.app = c.id AND agent_row.tool = t.value ->> 'name'
	WHERE c.url IS NOT NULL OR c.kind = 'native'
) o;

DELETE FROM pim_app.tool_permissions WHERE app <> '' AND (audience = 'owner' OR audience LIKE 'agent:%');

INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission, definition)
SELECT owner_id, 'agent:' || agent_id, app, tool, permission, definition FROM agent_connector_permissions WHERE permission <> 'off';
