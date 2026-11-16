-- What Live reads of Forge. Forge's outbox rows say that a coding thread was created, changed state or was archived;
-- Live projects them, and the thread's transcript, into the coding topics and the sidebar. A projection needs a gapless
-- number per stream, which the outbox's bigserial is not (a rolled-back insert leaves a hole), so each owner's rows are
-- numbered here, in the transaction that inserts them, from a counter whose row lock orders them by commit.
ALTER TABLE pim_forge.forge_outbox ADD COLUMN owner_id text, ADD COLUMN owner_seq bigint;
CREATE TABLE pim_forge.forge_outbox_counters (owner_id text PRIMARY KEY, last_seq bigint NOT NULL);

UPDATE pim_forge.forge_outbox o SET owner_id = t.owner_id FROM pim_forge.forge_threads t WHERE t.thread_id = o.thread_id;
WITH n AS (SELECT id, row_number() OVER (PARTITION BY owner_id ORDER BY id) AS rn FROM pim_forge.forge_outbox WHERE owner_id IS NOT NULL)
UPDATE pim_forge.forge_outbox o SET owner_seq = n.rn FROM n WHERE n.id = o.id;
INSERT INTO pim_forge.forge_outbox_counters SELECT owner_id, max(owner_seq) FROM pim_forge.forge_outbox WHERE owner_id IS NOT NULL GROUP BY owner_id;
CREATE UNIQUE INDEX forge_outbox_owner_seq ON pim_forge.forge_outbox (owner_id, owner_seq) WHERE owner_id IS NOT NULL;

-- AFTER INSERT, so a row Forge's `on conflict do nothing` skips never takes a number and leaves a hole.
CREATE FUNCTION pim_forge.forge_outbox_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner text; seq bigint;
BEGIN
	SELECT t.owner_id INTO owner FROM pim_forge.forge_threads t WHERE t.thread_id = NEW.thread_id;
	IF owner IS NULL THEN RETURN NULL; END IF;
	INSERT INTO pim_forge.forge_outbox_counters AS c (owner_id, last_seq) VALUES (owner, 1)
		ON CONFLICT (owner_id) DO UPDATE SET last_seq = c.last_seq + 1 RETURNING c.last_seq INTO seq;
	UPDATE pim_forge.forge_outbox SET owner_id = owner, owner_seq = seq WHERE id = NEW.id;
	RETURN NULL;
END $$;
CREATE TRIGGER forge_outbox_number AFTER INSERT ON pim_forge.forge_outbox FOR EACH ROW EXECUTE FUNCTION pim_forge.forge_outbox_number();

-- Every transcript message is announced through the outbox too, so Live hears of it in order with the thread's state changes.
CREATE FUNCTION pim_forge.forge_event_announce() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO pim_forge.forge_outbox (topic, dedupe_key, thread_id, payload)
		VALUES ('projection', 'event:' || NEW.thread_id || ':' || NEW.seq, NEW.thread_id, jsonb_build_object('type', 'coding.event', 'threadId', NEW.thread_id, 'seq', NEW.seq))
		ON CONFLICT (dedupe_key) DO NOTHING;
	RETURN NULL;
END $$;
CREATE TRIGGER forge_event_announce AFTER INSERT ON pim_forge.forge_events FOR EACH ROW WHEN (NEW.kind = 'message') EXECUTE FUNCTION pim_forge.forge_event_announce();

-- Forge's tables carry no row-level security, so Live gets no grant on them: it reads through these three functions,
-- which return only what it projects (the numbered feed, with the thread's card and the message each row announces).
CREATE FUNCTION pim_forge.live_forge_heads() RETURNS TABLE (owner_id text, last_seq bigint)
	LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
	AS $$ SELECT c.owner_id, c.last_seq FROM pim_forge.forge_outbox_counters c ORDER BY c.owner_id $$;

CREATE FUNCTION pim_forge.live_forge_feed(p_owner text, p_after bigint, p_limit integer)
	RETURNS TABLE (owner_seq bigint, topic text, payload jsonb, created_at timestamptz, thread_id text, task text, harness text, state text, updated_at timestamptz, role text, data jsonb, event_at timestamptz)
	LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
	AS $$
		SELECT o.owner_seq, o.topic, o.payload, o.created_at, t.thread_id, t.task, t.harness, t.state, t.updated_at, e.role, e.data, e.at
		FROM pim_forge.forge_outbox o
		LEFT JOIN pim_forge.forge_threads t ON t.thread_id = o.thread_id
		LEFT JOIN pim_forge.forge_events e ON o.payload ->> 'type' = 'coding.event' AND e.thread_id = o.thread_id AND e.seq = (o.payload ->> 'seq')::bigint
		WHERE o.owner_id = p_owner AND o.owner_seq > p_after
		ORDER BY o.owner_seq LIMIT p_limit
	$$;

CREATE FUNCTION pim_forge.live_forge_oldest(p_owner text, p_after bigint) RETURNS timestamptz
	LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
	AS $$ SELECT min(o.created_at) FROM pim_forge.forge_outbox o WHERE o.owner_id = p_owner AND o.owner_seq > p_after $$;

REVOKE ALL ON FUNCTION pim_forge.live_forge_heads(), pim_forge.live_forge_feed(text, bigint, integer), pim_forge.live_forge_oldest(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_forge.live_forge_heads(), pim_forge.live_forge_feed(text, bigint, integer), pim_forge.live_forge_oldest(text, bigint) TO pim_live;
GRANT USAGE ON SCHEMA pim_forge TO pim_live;
