-- What a Runner needs from the application without being given its tables. The Runner connects as pim_runtime, which has no grant on pim_app: an agent's
-- configuration, the context its prompt is built from, the owner's providers (their keys stay sealed; the Runner opens them with the deployment's keys) and the cost
-- ledger are reached through these functions, each of which names one owner and reads or writes only that owner's rows.

CREATE FUNCTION pim_app.runner_context(p_owner text, p_chat uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	agent_row pim_app.agents%ROWTYPE;
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	IF p_chat IS NOT NULL THEN
		SELECT a.* INTO agent_row FROM pim_app.conversations c JOIN pim_app.agents a ON a.owner_id = c.owner_id AND a.id = c.agent_id
		WHERE c.owner_id = p_owner AND c.public_chat_id = p_chat AND a.deleted_at IS NULL;
	END IF;
	result := jsonb_build_object(
		'username', (SELECT username FROM pim_app.accounts WHERE owner_id = p_owner),
		'agent', CASE WHEN agent_row.id IS NULL THEN NULL ELSE jsonb_build_object('id', agent_row.id, 'name', agent_row.name, 'instructions', agent_row.instructions, 'config', agent_row.config) END,
		'skills', coalesce((SELECT jsonb_agg(jsonb_build_object('name', s.name, 'description', s.description) ORDER BY s.name) FROM pim_app.skills s
			WHERE s.owner_id = p_owner AND agent_row.id IS NOT NULL AND agent_row.config->'skills' ? s.name), '[]'::jsonb),
		'goals', coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'steps', coalesce((SELECT jsonb_agg(jsonb_build_object('title', st.title, 'done', st.done) ORDER BY st.position)
			FROM pim_app.goal_steps st WHERE st.owner_id = g.owner_id AND st.goal_id = g.id), '[]'::jsonb)) ORDER BY g.created_at) FROM pim_app.goals g WHERE g.owner_id = p_owner AND g.status = 'active'), '[]'::jsonb),
		'memories', coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'scope', m.scope, 'title', m.title) ORDER BY m.updated_at DESC) FROM (
			SELECT * FROM pim_app.memories WHERE owner_id = p_owner AND deleted_at IS NULL AND (scope = 'everyone' OR scope = 'agent-' || coalesce(agent_row.id, '')) ORDER BY updated_at DESC LIMIT 100) m), '[]'::jsonb),
		'contacts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'about', left(a.instructions, 160)) ORDER BY a.name) FROM pim_app.agents a
			WHERE a.owner_id = p_owner AND a.deleted_at IS NULL AND agent_row.id IS NOT NULL AND (agent_row.config->'contacts' ? a.id OR agent_row.config->'delegates' ? a.id)), '[]'::jsonb),
		'fallbacks', coalesce((SELECT value FROM pim_app.owner_settings WHERE owner_id = p_owner AND key = 'model_fallbacks'), '[]'::jsonb)
	);
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

CREATE FUNCTION pim_app.runner_providers(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'config', config, 'secret', secret) ORDER BY id), '[]'::jsonb) INTO result FROM pim_app.providers WHERE owner_id = p_owner;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

-- One model call into the owner's cost ledger; a call recorded twice counts once.
CREATE FUNCTION pim_app.record_model_call(p_owner text, p_id text, p_run_kind text, p_chat uuid, p_provider text, p_model text, p_input bigint, p_output bigint, p_cost bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	inserted integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	INSERT INTO pim_app.model_calls (id, owner_id, run_kind, public_chat_id, provider, model, input_tokens, output_tokens, cost_microusd)
	VALUES (p_id, p_owner, p_run_kind, p_chat, p_provider, p_model, greatest(p_input, 0), greatest(p_output, 0), greatest(p_cost, 0)) ON CONFLICT DO NOTHING;
	GET DIAGNOSTICS inserted = ROW_COUNT;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN inserted > 0;
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_context(text, uuid), pim_app.runner_providers(text), pim_app.record_model_call(text, text, text, uuid, text, text, bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_context(text, uuid), pim_app.runner_providers(text), pim_app.record_model_call(text, text, text, uuid, text, text, bigint, bigint, bigint) TO pim_runtime;
