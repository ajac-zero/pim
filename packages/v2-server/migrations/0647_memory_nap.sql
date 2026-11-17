-- The memory nap: while nobody is in a chat, a Runner reads what was said since it last napped there and keeps what is worth remembering as a memory (v1's optmem nap, which
-- compressed a chat's memories into a tree; here the memory is a flat list, so the nap is the part that turns chats into memories).
-- `chat_naps` says how far each chat has been napped: `napped_at` is the chat's `updated_at` the nap saw, so a chat that moved on meanwhile naps again, and `memory_id` is the
-- memory it wrote (one per chat, rewritten each time, so a nap that is repeated or raced by another Runner writes the same row).

CREATE TABLE pim_app.chat_naps (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	public_chat_id uuid NOT NULL REFERENCES pim_app.conversations (public_chat_id),
	napped_at timestamptz NOT NULL,
	memory_id text,
	PRIMARY KEY (owner_id, public_chat_id)
);
SELECT pim_app.seal_tenant('pim_app.chat_naps');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.chat_naps TO pim_gate;

-- The one read across owners the nap needs, narrow like `relay_claim`: chats that have been quiet for `p_idle_seconds` and have moved since their last nap, oldest first. Chats made for
-- a task, a trigger, a review or a visit, a room's seats, and archived or deleted chats have nothing to nap on.
CREATE POLICY nap_scope ON pim_app.conversations FOR SELECT USING (current_setting('pim.scope', true) = 'all');
CREATE POLICY nap_scope ON pim_app.chat_naps FOR SELECT USING (current_setting('pim.scope', true) = 'all');

CREATE FUNCTION pim_app.nap_candidates(p_idle_seconds integer, p_limit integer)
	RETURNS TABLE (owner_id text, public_chat_id uuid, title text, agent_id text, updated_at timestamptz)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.scope', 'all', true);
	RETURN QUERY
		SELECT c.owner_id, c.public_chat_id, c.title, c.agent_id, c.updated_at
		FROM pim_app.conversations c LEFT JOIN pim_app.chat_naps n ON n.owner_id = c.owner_id AND n.public_chat_id = c.public_chat_id
		WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND c.room_of IS NULL AND c.kind IN ('normal', 'group')
		  AND c.updated_at < now() - (p_idle_seconds || ' seconds')::interval AND (n.napped_at IS NULL OR n.napped_at < c.updated_at)
		ORDER BY c.updated_at LIMIT p_limit;
	PERFORM set_config('pim.scope', '', true);
END $$;

REVOKE ALL ON FUNCTION pim_app.nap_candidates(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.nap_candidates(integer, integer) TO pim_runtime;

-- The utility model a person chose in Settings (the memory nap runs on it unless the deployment names a memory model): the one setting besides `model` a Runner may read.
CREATE FUNCTION pim_app.runner_utility_model(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT value INTO result FROM pim_app.owner_settings WHERE owner_id = p_owner AND key = 'model_utility';
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_utility_model(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_utility_model(text) TO pim_runtime;
