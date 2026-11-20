-- What Live learns of a chat from the application. A chat's title, whether it is archived or unread, its agent and its model live in
-- `pim_app.conversations`; the runtime's outbox says nothing of them, so the sidebar projection (and the live rows built from it) never knew them.
-- A change to any of them is announced here, numbered per owner without gaps in the transaction that makes it (the counter's row lock orders
-- the rows by commit, as Forge's outbox does in 0601), and Live reads the feed through the functions below, which return the chat as it is then.
CREATE TABLE pim_app.chat_feed (
	owner_id text NOT NULL,
	owner_seq bigint NOT NULL,
	chat_id uuid NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, owner_seq)
);
CREATE TABLE pim_app.chat_feed_counters (owner_id text PRIMARY KEY, last_seq bigint NOT NULL);

-- Every chat is announced once, so a chat that exists before this migration reaches the projection with its title too. The migrator owns the table
-- and, unlike the application's roles, may read it with row-level security off for the length of this statement.
ALTER TABLE pim_app.conversations NO FORCE ROW LEVEL SECURITY;
INSERT INTO pim_app.chat_feed (owner_id, owner_seq, chat_id)
	SELECT owner_id, row_number() OVER (PARTITION BY owner_id ORDER BY created_at, public_chat_id), public_chat_id FROM pim_app.conversations WHERE deleted_at IS NULL;
ALTER TABLE pim_app.conversations FORCE ROW LEVEL SECURITY;
INSERT INTO pim_app.chat_feed_counters SELECT owner_id, count(*) FROM pim_app.chat_feed GROUP BY owner_id;

SELECT pim_app.seal_tenant('pim_app.chat_feed');
SELECT pim_app.seal_tenant('pim_app.chat_feed_counters');
-- Live finds the owners that have a feed without being any owner: the counters admit a transaction that sets pim.scope to 'all', as `live_chat_heads` does.
CREATE POLICY live_scope ON pim_app.chat_feed_counters FOR SELECT USING (current_setting('pim.scope', true) = 'all');

CREATE FUNCTION pim_app.chat_feed_announce() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE previous text := coalesce(current_setting('pim.owner_id', true), ''); seq bigint;
BEGIN
	PERFORM set_config('pim.owner_id', NEW.owner_id, true);
	INSERT INTO pim_app.chat_feed_counters AS c (owner_id, last_seq) VALUES (NEW.owner_id, 1)
		ON CONFLICT (owner_id) DO UPDATE SET last_seq = c.last_seq + 1 RETURNING c.last_seq INTO seq;
	INSERT INTO pim_app.chat_feed (owner_id, owner_seq, chat_id) VALUES (NEW.owner_id, seq, NEW.public_chat_id);
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN NULL;
END $$;
CREATE TRIGGER chat_feed_insert AFTER INSERT ON pim_app.conversations FOR EACH ROW EXECUTE FUNCTION pim_app.chat_feed_announce();
CREATE TRIGGER chat_feed_update AFTER UPDATE OF title, archived_at, read_at, response_at, agent_id, model, deleted_at ON pim_app.conversations FOR EACH ROW
	WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.archived_at IS DISTINCT FROM NEW.archived_at OR OLD.read_at IS DISTINCT FROM NEW.read_at OR OLD.response_at IS DISTINCT FROM NEW.response_at
		OR OLD.agent_id IS DISTINCT FROM NEW.agent_id OR OLD.model IS DISTINCT FROM NEW.model OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
	EXECUTE FUNCTION pim_app.chat_feed_announce();

-- ---- Live's reads of the feed (run in Live, as pim_live) ----

CREATE FUNCTION pim_app.live_chat_heads() RETURNS TABLE (owner_id text, last_seq bigint)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.scope', 'all', true);
	RETURN QUERY SELECT c.owner_id, c.last_seq FROM pim_app.chat_feed_counters c ORDER BY c.owner_id;
	PERFORM set_config('pim.scope', '', true);
END $$;

-- One row per announcement, with the chat as it is now. A chat that is gone still returns its row, with no columns, so the numbering has no hole.
CREATE FUNCTION pim_app.live_chat_feed(p_owner text, p_after bigint, p_limit integer)
	RETURNS TABLE (owner_seq bigint, announced_at timestamptz, chat_id text, found boolean, deleted boolean, seat boolean, title text, unread boolean, archived boolean, model jsonb,
		created_at timestamptz, updated_at timestamptz, response_at timestamptz, agent_id text, agent_name text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	RETURN QUERY
		SELECT f.owner_seq, f.created_at, f.chat_id::text, c.public_chat_id IS NOT NULL, c.deleted_at IS NOT NULL, c.room_of IS NOT NULL, c.title,
			c.response_at IS NOT NULL AND (c.read_at IS NULL OR c.read_at < c.response_at), c.archived_at IS NOT NULL, c.model,
			c.created_at, c.updated_at, c.response_at, a.id, a.name
		FROM pim_app.chat_feed f
		LEFT JOIN pim_app.conversations c ON c.owner_id = f.owner_id AND c.public_chat_id = f.chat_id
		LEFT JOIN pim_app.agents a ON a.owner_id = f.owner_id AND a.deleted_at IS NULL
			AND a.id = coalesce(c.agent_id, (SELECT s.value #>> '{}' FROM pim_app.owner_settings s WHERE s.owner_id = f.owner_id AND s.key = 'majordomo'))
		WHERE f.owner_id = p_owner AND f.owner_seq > p_after
		ORDER BY f.owner_seq LIMIT p_limit;
	PERFORM set_config('pim.owner_id', '', true);
END $$;

CREATE FUNCTION pim_app.live_chat_oldest(p_owner text, p_after bigint) RETURNS timestamptz
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE oldest timestamptz;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT min(f.created_at) INTO oldest FROM pim_app.chat_feed f WHERE f.owner_id = p_owner AND f.owner_seq > p_after;
	PERFORM set_config('pim.owner_id', '', true);
	RETURN oldest;
END $$;

REVOKE ALL ON FUNCTION pim_app.live_chat_heads(), pim_app.live_chat_feed(text, bigint, integer), pim_app.live_chat_oldest(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.live_chat_heads(), pim_app.live_chat_feed(text, bigint, integer), pim_app.live_chat_oldest(text, bigint) TO pim_live;
