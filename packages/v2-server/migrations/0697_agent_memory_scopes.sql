-- What an agent reads of the person's memory: its own scope (config.memoryScope, `agent-<id>` unless a migrated space says otherwise, as its majordomo's is `private`),
-- the named scopes it was given (config.memoryScopes, keys of pim_app.memory_scopes) and `everyone`. Only the memories line of runner_context changes.
CREATE OR REPLACE FUNCTION pim_app.runner_context(p_owner text, p_chat uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	agent_row pim_app.agents%ROWTYPE;
	result jsonb;
	chat_model jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	IF p_chat IS NOT NULL THEN
		SELECT a.* INTO agent_row FROM pim_app.conversations c JOIN pim_app.agents a ON a.owner_id = c.owner_id AND a.id = c.agent_id
		WHERE c.owner_id = p_owner AND c.public_chat_id = p_chat AND a.deleted_at IS NULL;
		SELECT jsonb_build_object('provider', regexp_replace(c.model->>'provider', '^own:', ''), 'id', c.model->>'id') INTO chat_model
		FROM pim_app.conversations c WHERE c.owner_id = p_owner AND c.public_chat_id = p_chat AND c.model IS NOT NULL;
	END IF;
	-- A chat started without choosing an agent answers as the person's majordomo (owner_settings.majordomo, named by the web app's compatibility routes).
	IF agent_row.id IS NULL THEN
		SELECT a.* INTO agent_row FROM pim_app.owner_settings s JOIN pim_app.agents a ON a.owner_id = s.owner_id AND a.id = s.value #>> '{}'
		WHERE s.owner_id = p_owner AND s.key = 'majordomo' AND a.deleted_at IS NULL;
	END IF;
	result := jsonb_build_object(
		'username', (SELECT username FROM pim_app.accounts WHERE owner_id = p_owner),
		'agent', CASE WHEN agent_row.id IS NULL THEN NULL ELSE jsonb_build_object('id', agent_row.id, 'name', agent_row.name, 'instructions', agent_row.instructions, 'config', agent_row.config) END,
		'skills', coalesce((SELECT jsonb_agg(jsonb_build_object('name', s.name, 'description', s.description) ORDER BY s.name) FROM pim_app.skills s
			WHERE s.owner_id = p_owner AND agent_row.id IS NOT NULL AND agent_row.config->'skills' ? s.name), '[]'::jsonb),
		'goals', coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'steps', coalesce((SELECT jsonb_agg(jsonb_build_object('title', st.title, 'done', st.done) ORDER BY st.position)
			FROM pim_app.goal_steps st WHERE st.owner_id = g.owner_id AND st.goal_id = g.id), '[]'::jsonb)) ORDER BY g.created_at) FROM pim_app.goals g WHERE g.owner_id = p_owner AND g.status = 'active'), '[]'::jsonb),
		'memories', coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'scope', m.scope, 'title', m.title) ORDER BY m.updated_at DESC) FROM (
			SELECT * FROM pim_app.memories WHERE owner_id = p_owner AND deleted_at IS NULL AND (scope = 'everyone' OR scope = coalesce(agent_row.config->>'memoryScope', 'agent-' || coalesce(agent_row.id, '')) OR coalesce(agent_row.config->'memoryScopes', '[]'::jsonb) ? scope) ORDER BY updated_at DESC LIMIT 100) m), '[]'::jsonb),
		'contacts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'about', left(a.instructions, 160)) ORDER BY a.name) FROM pim_app.agents a
			WHERE a.owner_id = p_owner AND a.deleted_at IS NULL AND agent_row.id IS NOT NULL AND (agent_row.config->'contacts' ? a.id OR agent_row.config->'delegates' ? a.id)), '[]'::jsonb),
		'chat_model', chat_model,
		'fallbacks', coalesce((SELECT value FROM pim_app.owner_settings WHERE owner_id = p_owner AND key = 'model_fallbacks'), '[]'::jsonb)
	);
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;
