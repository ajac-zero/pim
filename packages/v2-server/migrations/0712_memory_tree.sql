-- v1's memory tree (OptMem's, `src/extensions/optmem` at the tag v1-final) over V2's memories. Each scope's memories have places 0, 1, 2, … in the order they were kept (`pos`):
-- a memory moved to another scope takes the next place there and leaves its old place empty, and a forgotten one leaves its place empty. An aligned power-of-two block of
-- places is summarized in one line (`memory_summaries`): a block of up to 16 places from its memories' titles, a larger one from its two halves' summaries, by the Runner's
-- memory pass (`packages/v2-server/src/memory-tree.ts`). The prompt shows a scope's newest memories as they are and older ones in ever coarser summaries.
-- The summaries are a cache: a memory whose title changes, or that is forgotten or moved, drops every summary over its place, and the pass builds them again. One lock per owner
-- orders those drops against the pass's writes, so a summary of what a memory said before it changed is never kept.

ALTER TABLE pim_app.memories ADD COLUMN pos integer;

-- Memories kept before places are placed in the order they were kept (`m_legacy_<n>`, of one day, by n).
DO $$
DECLARE o text;
BEGIN
	FOR o IN SELECT owner_id FROM pim_app.accounts LOOP
		PERFORM set_config('pim.owner_id', o, true);
		UPDATE pim_app.memories m SET pos = r.pos
		FROM (SELECT id, (row_number() OVER (PARTITION BY scope ORDER BY created_at, length(id), id) - 1)::int AS pos FROM pim_app.memories) r
		WHERE m.id = r.id;
	END LOOP;
	PERFORM set_config('pim.owner_id', '', true);
END $$;

ALTER TABLE pim_app.memories ALTER COLUMN pos SET NOT NULL;
CREATE UNIQUE INDEX memories_places ON pim_app.memories (owner_id, scope, pos);

CREATE TABLE pim_app.memory_summaries (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	scope text NOT NULL,
	size integer NOT NULL,
	lo integer NOT NULL,
	-- Empty for a block whose places are all empty: there is nothing to show of it.
	text text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, scope, size, lo)
);
SELECT pim_app.seal_tenant('pim_app.memory_summaries');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.memory_summaries TO pim_gate;

-- The lock the places and the summaries of one owner's memory are changed under.
CREATE FUNCTION pim_app.lock_memory_tree(p_owner text) RETURNS void LANGUAGE sql AS $$
	SELECT pg_advisory_xact_lock(hashtextextended('pim_app.memory_tree ' || p_owner, 0))
$$;

-- A new memory, or one moved to another scope, takes the next place of its scope.
CREATE FUNCTION pim_app.memory_place() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' AND NEW.pos IS NOT NULL THEN RETURN NEW; END IF;
	IF TG_OP = 'UPDATE' AND NEW.scope IS NOT DISTINCT FROM OLD.scope THEN RETURN NEW; END IF;
	PERFORM pim_app.lock_memory_tree(NEW.owner_id);
	SELECT coalesce(max(pos) + 1, 0) INTO NEW.pos FROM pim_app.memories WHERE owner_id = NEW.owner_id AND scope = NEW.scope;
	RETURN NEW;
END $$;
CREATE TRIGGER memory_place BEFORE INSERT OR UPDATE OF scope ON pim_app.memories FOR EACH ROW EXECUTE FUNCTION pim_app.memory_place();

-- What a summary was made from changed: the summaries over the old place go.
CREATE FUNCTION pim_app.memory_unsummarize() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.scope IS NOT DISTINCT FROM OLD.scope AND (NEW.deleted_at IS NULL) = (OLD.deleted_at IS NULL) THEN
		RETURN NULL;
	END IF;
	PERFORM pim_app.lock_memory_tree(OLD.owner_id);
	DELETE FROM pim_app.memory_summaries WHERE owner_id = OLD.owner_id AND scope = OLD.scope AND lo <= OLD.pos AND OLD.pos < lo + size;
	RETURN NULL;
END $$;
CREATE TRIGGER memory_unsummarize AFTER UPDATE OR DELETE ON pim_app.memories FOR EACH ROW EXECUTE FUNCTION pim_app.memory_unsummarize();

-- The one read across owners the memory pass needs, narrow like `nap_candidates`: owners with a scope where a block that can be built has no summary yet. A scope of n places
-- has floor(n/2) + floor(n/4) + … blocks.
CREATE POLICY tree_scope ON pim_app.memories FOR SELECT USING (current_setting('pim.scope', true) = 'all');
CREATE POLICY tree_scope ON pim_app.memory_summaries FOR SELECT USING (current_setting('pim.scope', true) = 'all');

CREATE FUNCTION pim_app.memory_tree_owners(p_limit integer) RETURNS TABLE (owner_id text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.scope', 'all', true);
	RETURN QUERY
		SELECT s.owner_id FROM (SELECT m.owner_id, m.scope, max(m.pos) + 1 AS n FROM pim_app.memories m GROUP BY m.owner_id, m.scope) s
		WHERE (SELECT sum(s.n >> k) FROM generate_series(1, 30) k) > (SELECT count(*) FROM pim_app.memory_summaries t WHERE t.owner_id = s.owner_id AND t.scope = s.scope)
		GROUP BY s.owner_id ORDER BY min(s.owner_id) LIMIT p_limit;
	PERFORM set_config('pim.scope', '', true);
END $$;

REVOKE ALL ON FUNCTION pim_app.memory_tree_owners(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.memory_tree_owners(integer) TO pim_runtime;

-- What an agent's memory shows, for the Runner: how many places each scope has (`p_scopes`, or every scope where it is null, as the majordomo reads them)...
CREATE FUNCTION pim_app.runner_memory_sizes(p_owner text, p_scopes text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT coalesce(jsonb_object_agg(scope, n), '{}'::jsonb) INTO result
	FROM (SELECT scope, max(pos) + 1 AS n FROM pim_app.memories WHERE owner_id = p_owner AND (p_scopes IS NULL OR scope = ANY (p_scopes)) GROUP BY scope) s;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

-- ...and the blocks of places it asks for (`[{scope, lo, hi}]`): a place's memory, or a block's summary, where a block not summarized yet shows its halves, down to places.
-- Empty places and the summaries of blocks with nothing in them are left out.
CREATE FUNCTION pim_app.runner_memory_blocks(p_owner text, p_blocks jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	WITH RECURSIVE wanted (scope, lo, hi) AS (
		SELECT b->>'scope', (b->>'lo')::int, (b->>'hi')::int FROM jsonb_array_elements(p_blocks) b
		UNION ALL
		SELECT w.scope, h.lo, h.hi FROM wanted w CROSS JOIN LATERAL (VALUES (w.lo, (w.lo + w.hi) / 2), ((w.lo + w.hi) / 2, w.hi)) h (lo, hi)
		WHERE w.hi - w.lo > 1 AND NOT EXISTS (SELECT 1 FROM pim_app.memory_summaries s WHERE s.owner_id = p_owner AND s.scope = w.scope AND s.size = w.hi - w.lo AND s.lo = w.lo)
	)
	SELECT coalesce(jsonb_agg(jsonb_build_object('scope', w.scope, 'lo', w.lo, 'hi', w.hi, 'id', m.id, 'text', coalesce(m.title, s.text)) ORDER BY w.scope, w.lo), '[]'::jsonb) INTO result
	FROM wanted w
	LEFT JOIN pim_app.memory_summaries s ON w.hi - w.lo > 1 AND s.owner_id = p_owner AND s.scope = w.scope AND s.size = w.hi - w.lo AND s.lo = w.lo
	LEFT JOIN pim_app.memories m ON w.hi - w.lo = 1 AND m.owner_id = p_owner AND m.scope = w.scope AND m.pos = w.lo AND m.deleted_at IS NULL
	WHERE m.id IS NOT NULL OR (s.text IS NOT NULL AND s.text <> '');
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_memory_sizes(text, text[]), pim_app.runner_memory_blocks(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_memory_sizes(text, text[]), pim_app.runner_memory_blocks(text, jsonb) TO pim_runtime;
