-- What a circle member's visit knows of the host, as v1's host sent it as a brief: the host's time zone and the host's memory in the scopes the circle may read, read again at
-- every turn so a paused circle, a removed member or a scope taken back stops showing at once. Both answer NULL for a chat that is no visit. The visitor's own Runner asks;
-- it reads nothing else of the host's, and never a scope the circle was not given.
CREATE FUNCTION pim_app.runner_visit_brief(p_owner text, p_chat uuid, p_lines integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	host text;
	host_name text;
	circle pim_app.circles%ROWTYPE;
	zone text;
	scopes text[];
	remembered jsonb := NULL;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT l.host_owner INTO host FROM pim_app.visit_links l WHERE l.owner_id = p_owner AND l.chat = p_chat;
	IF host IS NULL THEN
		PERFORM set_config('pim.owner_id', previous, true);
		RETURN NULL;
	END IF;
	PERFORM set_config('pim.owner_id', host, true);
	SELECT username INTO host_name FROM pim_app.accounts WHERE owner_id = host AND status = 'active' AND role <> 'guest';
	SELECT * INTO circle FROM pim_app.circles c WHERE c.owner_id = host AND p_owner = ANY (c.members);
	IF host_name IS NULL OR circle.id IS NULL OR NOT circle.enabled THEN
		PERFORM set_config('pim.owner_id', previous, true);
		RETURN jsonb_build_object('host', host_name, 'available', false);
	END IF;
	SELECT value #>> '{}' INTO zone FROM pim_app.owner_settings WHERE owner_id = host AND key = 'settings.timeZone';
	scopes := circle.memory_scopes;
	IF cardinality(scopes) > 0 THEN
		remembered := coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'scope', m.scope, 'title', m.title) ORDER BY m.updated_at DESC)
			FROM (SELECT * FROM pim_app.memories WHERE owner_id = host AND deleted_at IS NULL AND scope = ANY (scopes) ORDER BY updated_at DESC LIMIT greatest(p_lines, 1)) m), '[]'::jsonb);
	END IF;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN jsonb_build_object('host', host_name, 'circle', circle.name, 'available', true, 'timeZone', zone, 'scopes', to_jsonb(scopes), 'memory', remembered);
END $$;

-- The host's memories in the circle's scopes that match a case-insensitive regular expression over titles and text, newest first, for the visit's `recall`.
CREATE FUNCTION pim_app.runner_visit_recall(p_owner text, p_chat uuid, p_pattern text, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	host text;
	scopes text[];
	found jsonb;
	total integer;
BEGIN
	PERFORM set_config('statement_timeout', '1000ms', true);
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT l.host_owner INTO host FROM pim_app.visit_links l WHERE l.owner_id = p_owner AND l.chat = p_chat;
	IF host IS NULL THEN
		PERFORM set_config('pim.owner_id', previous, true);
		RETURN NULL;
	END IF;
	PERFORM set_config('pim.owner_id', host, true);
	SELECT c.memory_scopes INTO scopes FROM pim_app.circles c JOIN pim_app.accounts a ON a.owner_id = c.owner_id
	WHERE c.owner_id = host AND p_owner = ANY (c.members) AND c.enabled AND a.status = 'active' AND a.role <> 'guest';
	IF scopes IS NULL OR cardinality(scopes) = 0 THEN
		PERFORM set_config('pim.owner_id', previous, true);
		RETURN jsonb_build_object('matches', '[]'::jsonb, 'total', 0);
	END IF;
	SELECT count(*) INTO total FROM pim_app.memories WHERE owner_id = host AND deleted_at IS NULL AND scope = ANY (scopes) AND (title ~* p_pattern OR body ~* p_pattern);
	SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'scope', m.scope, 'title', m.title) ORDER BY m.updated_at DESC), '[]'::jsonb) INTO found
	FROM (SELECT * FROM pim_app.memories WHERE owner_id = host AND deleted_at IS NULL AND scope = ANY (scopes) AND (title ~* p_pattern OR body ~* p_pattern) ORDER BY updated_at DESC LIMIT greatest(p_limit, 1)) m;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN jsonb_build_object('matches', found, 'total', total);
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_visit_brief(text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION pim_app.runner_visit_recall(text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_visit_brief(text, uuid, integer) TO pim_runtime;
GRANT EXECUTE ON FUNCTION pim_app.runner_visit_recall(text, uuid, text, integer) TO pim_runtime;
