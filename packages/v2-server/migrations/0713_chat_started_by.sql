-- The sidebar lists a chat that an agent started for a task under the chat that started it, so a row says who started it: the chat, its agent, the task and how it stands
-- (`startedBy` in the row's summary, as the app's `Session`). `task_started_by` reads that for a chat, from the latest task made for it, and is null for a chat no task made.
-- The agent is the one the starting chat answers as, its majordomo when it has none of its own.
CREATE FUNCTION pim_app.task_started_by(p_owner text, p_chat uuid) RETURNS jsonb
	LANGUAGE sql STABLE
AS $$
	SELECT jsonb_build_object('session', t.started_by, 'agent', jsonb_build_object('id', coalesce(r.agent_id, m.value #>> '{}'), 'name', coalesce(a.name, 'An agent')), 'task', t.task_id, 'state', t.status)
	FROM pim_app.tasks t
	JOIN pim_app.conversations r ON r.owner_id = t.owner_id AND r.public_chat_id = t.started_by
	LEFT JOIN pim_app.owner_settings m ON m.owner_id = t.owner_id AND m.key = 'majordomo'
	LEFT JOIN pim_app.agents a ON a.owner_id = t.owner_id AND a.deleted_at IS NULL AND a.id = coalesce(r.agent_id, m.value #>> '{}')
	WHERE t.owner_id = p_owner AND t.task_chat = p_chat
	ORDER BY t.created_at DESC LIMIT 1
$$;

-- A task's chat is announced when its task is made and when the task's state changes, as the chat is when its title or agent changes (0711), so the row heard live says who started it.
CREATE FUNCTION pim_app.chat_feed_announce_task() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE previous text := coalesce(current_setting('pim.owner_id', true), ''); seq bigint;
BEGIN
	PERFORM set_config('pim.owner_id', NEW.owner_id, true);
	INSERT INTO pim_app.chat_feed_counters AS c (owner_id, last_seq) VALUES (NEW.owner_id, 1)
		ON CONFLICT (owner_id) DO UPDATE SET last_seq = c.last_seq + 1 RETURNING c.last_seq INTO seq;
	INSERT INTO pim_app.chat_feed (owner_id, owner_seq, chat_id) VALUES (NEW.owner_id, seq, NEW.task_chat);
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN NULL;
END $$;
CREATE TRIGGER chat_feed_task_insert AFTER INSERT ON pim_app.tasks FOR EACH ROW WHEN (NEW.task_chat IS NOT NULL) EXECUTE FUNCTION pim_app.chat_feed_announce_task();
CREATE TRIGGER chat_feed_task_update AFTER UPDATE OF status ON pim_app.tasks FOR EACH ROW
	WHEN (NEW.task_chat IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION pim_app.chat_feed_announce_task();

-- Live's read of the feed returns `started_by` too.
DROP FUNCTION pim_app.live_chat_feed(text, bigint, integer);
CREATE FUNCTION pim_app.live_chat_feed(p_owner text, p_after bigint, p_limit integer)
	RETURNS TABLE (owner_seq bigint, announced_at timestamptz, chat_id text, found boolean, deleted boolean, seat boolean, title text, unread boolean, archived boolean, model jsonb,
		created_at timestamptz, updated_at timestamptz, response_at timestamptz, agent_id text, agent_name text, started_by jsonb)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	RETURN QUERY
		SELECT f.owner_seq, f.created_at, f.chat_id::text, c.public_chat_id IS NOT NULL, c.deleted_at IS NOT NULL, c.room_of IS NOT NULL, c.title,
			c.response_at IS NOT NULL AND (c.read_at IS NULL OR c.read_at < c.response_at), c.archived_at IS NOT NULL, c.model,
			c.created_at, c.updated_at, c.response_at, a.id, a.name, pim_app.task_started_by(f.owner_id, f.chat_id)
		FROM pim_app.chat_feed f
		LEFT JOIN pim_app.conversations c ON c.owner_id = f.owner_id AND c.public_chat_id = f.chat_id
		LEFT JOIN pim_app.agents a ON a.owner_id = f.owner_id AND a.deleted_at IS NULL
			AND a.id = coalesce(c.agent_id, (SELECT s.value #>> '{}' FROM pim_app.owner_settings s WHERE s.owner_id = f.owner_id AND s.key = 'majordomo'))
		WHERE f.owner_id = p_owner AND f.owner_seq > p_after
		ORDER BY f.owner_seq LIMIT p_limit;
	PERFORM set_config('pim.owner_id', '', true);
END $$;
REVOKE ALL ON FUNCTION pim_app.live_chat_feed(text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.live_chat_feed(text, bigint, integer) TO pim_live;
