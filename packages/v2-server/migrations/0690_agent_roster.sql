-- The agents an agent knows of, for its prompt and for `delegate`: every agent of the person with what it is for (the roster), and those the chat's agent may hand a task to.
-- The majordomo hands tasks to every other agent; any other agent, to its contacts and delegates. Never to the majordomo, never to an agent already on the chain of tasks that
-- led to this chat (so work never goes round in a circle), and to no one at all once the chain is `p_max_depth` tasks long, as in v1. A visit and an approval's review hand none.
-- A chat with no agent of its own is answered by the majordomo (`pim_app.majordomo_id()`). An agent migrated from v1 keeps its role and description under config.legacy.
CREATE FUNCTION pim_app.runner_agents(p_owner text, p_chat uuid, p_max_depth integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	major text;
	self_id text;
	v_kind text;
	top_kind text;
	v_agent text;
	chain text[] := ARRAY[]::text[];
	cur uuid := p_chat;
	hop integer := 0;
	roster jsonb;
	delegates jsonb;
	asked_by text;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	major := pim_app.majordomo_id();
	self_id := major;
	WHILE cur IS NOT NULL AND hop < 20 LOOP
		SELECT c.agent_id, c.kind INTO v_agent, v_kind FROM pim_app.conversations c WHERE c.owner_id = p_owner AND c.public_chat_id = cur;
		IF hop = 0 THEN
			self_id := coalesce(v_agent, major);
			top_kind := v_kind;
		END IF;
		chain := chain || coalesce(v_agent, major, '');
		SELECT t.started_by INTO cur FROM pim_app.tasks t WHERE t.owner_id = p_owner AND t.task_chat = cur ORDER BY t.created_at DESC LIMIT 1;
		hop := hop + 1;
	END LOOP;
	-- The agent that handed this chat its task, when it is a task's chat.
	SELECT a.name INTO asked_by FROM pim_app.tasks t JOIN pim_app.conversations r ON r.owner_id = t.owner_id AND r.public_chat_id = t.started_by
		JOIN pim_app.agents a ON a.owner_id = t.owner_id AND a.id = coalesce(r.agent_id, major) WHERE t.owner_id = p_owner AND t.task_chat = p_chat ORDER BY t.created_at DESC LIMIT 1;
	SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'role', coalesce(a.role, a.config->'legacy'->>'role', a.name),
			'description', coalesce(nullif(a.description, ''), a.config->'legacy'->>'description', ''), 'majordomo', a.id = major) ORDER BY a.created_at), '[]'::jsonb)
		INTO roster FROM pim_app.agents a WHERE a.owner_id = p_owner AND a.deleted_at IS NULL;
	IF top_kind IN ('visit', 'review') OR cardinality(chain) > p_max_depth THEN
		delegates := '[]'::jsonb;
	ELSE
		SELECT coalesce(jsonb_agg(r ORDER BY r->>'name'), '[]'::jsonb) INTO delegates
		FROM jsonb_array_elements(roster) r
		JOIN pim_app.agents a ON a.owner_id = p_owner AND a.id = r->>'id'
		WHERE (r->>'id') IS DISTINCT FROM major AND NOT ((r->>'id') = ANY(chain))
			AND (self_id IS NOT DISTINCT FROM major OR EXISTS (SELECT 1 FROM pim_app.agents me WHERE me.owner_id = p_owner AND me.id = self_id AND (me.config->'contacts' ? a.id OR me.config->'delegates' ? a.id)));
	END IF;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN jsonb_build_object('self', self_id, 'majordomo', self_id IS NOT DISTINCT FROM major, 'agents', roster, 'delegates', delegates, 'startedBy', asked_by);
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_agents(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_agents(text, uuid, integer) TO pim_runtime;
