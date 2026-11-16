-- What lets the processes that own different schemas work together without sharing a login. Each process connects as
-- its own role (pim_gate, pim_runtime, pim_live, ...), none a superuser or BYPASSRLS; these SECURITY DEFINER functions are
-- the only doors between them, each returning only what its caller needs.

-- ---- Gate to the runtime: the command relay (runs in the Runner, as pim_runtime) ----

-- The Runner finds owners with queued commands without being any owner: the inbox admits a transaction that sets pim.scope to 'all'.
CREATE POLICY relay_scope ON pim_app.command_inbox FOR SELECT USING (current_setting('pim.scope', true) = 'all');

CREATE FUNCTION pim_app.relay_claim(p_runner text, p_limit integer, p_lease_ms integer)
	RETURNS TABLE (owner_id text, command_id text, kind text, public_chat_id uuid, pi_request_id text, payload jsonb, accepted_at timestamptz, partition_id uuid, provisional_conversation_id bigint)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE o text; owners text[];
BEGIN
	PERFORM set_config('pim.scope', 'all', true);
	SELECT array_agg(d.owner_id) INTO owners FROM (SELECT DISTINCT i.owner_id FROM pim_app.command_inbox i WHERE i.available_at <= now() AND (i.claimed_until IS NULL OR i.claimed_until < now()) LIMIT p_limit) d;
	PERFORM set_config('pim.scope', '', true);
	FOREACH o IN ARRAY coalesce(owners, ARRAY[]::text[]) LOOP
		PERFORM set_config('pim.owner_id', o, true);
		RETURN QUERY
			WITH picked AS (
				UPDATE pim_app.command_inbox i SET claimed_by = p_runner, claimed_until = now() + (p_lease_ms || ' milliseconds')::interval
				WHERE i.seq IN (SELECT x.seq FROM pim_app.command_inbox x WHERE x.available_at <= now() AND (x.claimed_until IS NULL OR x.claimed_until < now()) ORDER BY x.seq LIMIT p_limit FOR UPDATE SKIP LOCKED)
				RETURNING i.seq, i.command_id)
			SELECT c.owner_id, c.command_id, c.kind, c.public_chat_id, c.pi_request_id, c.payload, c.accepted_at, v.partition_id, v.conversation_id
			FROM picked p JOIN pim_app.accepted_commands c ON c.command_id = p.command_id
			JOIN pim_app.conversations v ON v.public_chat_id = c.public_chat_id ORDER BY p.seq;
	END LOOP;
	PERFORM set_config('pim.owner_id', '', true);
END $$;

-- The runtime has the command durably in its own inbox and pi has taken it: the application's ledger says so and drops it from its inbox.
CREATE FUNCTION pim_app.relay_committed(p_owner text, p_command_id text) RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	UPDATE pim_app.accepted_commands SET state = 'runtime_committed', committed_at = now() WHERE command_id = p_command_id AND owner_id = p_owner AND state = 'inbox_accepted';
	DELETE FROM pim_app.command_inbox WHERE command_id = p_command_id AND owner_id = p_owner;
	PERFORM set_config('pim.owner_id', '', true);
END $$;

-- Not yet deliverable (the chat's conversation does not exist in the runtime yet): back into the queue at once.
CREATE FUNCTION pim_app.relay_release(p_owner text, p_command_id text) RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	UPDATE pim_app.command_inbox SET claimed_by = NULL, claimed_until = NULL WHERE command_id = p_command_id AND owner_id = p_owner;
	PERFORM set_config('pim.owner_id', '', true);
END $$;

-- ---- Gate to Live: who a connection is, and whether it still may be (runs in Live, as pim_live) ----

-- `p_kind` is what the bearer's prefix says: 'session' (pims_), 'token' (pim_) or 'consumer' (any other).
CREATE FUNCTION pim_app.live_authenticate(p_hash text, p_kind text)
	RETURNS TABLE (kind text, owner_id text, id text, scopes text[], role text, status text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE f_kind text; f_owner text; f_id text; f_scopes text[];
BEGIN
	PERFORM set_config('pim.lookup', p_hash, true);
	IF p_kind = 'session' THEN
		SELECT 'session', s.owner_id, s.id, ARRAY[]::text[] INTO f_kind, f_owner, f_id, f_scopes FROM pim_app.browser_sessions s WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now();
	ELSIF p_kind = 'token' THEN
		SELECT 'token', t.owner_id, t.id, t.scopes INTO f_kind, f_owner, f_id, f_scopes FROM pim_app.api_tokens t WHERE t.token_hash = p_hash AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now());
	ELSE
		SELECT 'token', t.owner_id, t.id, t.scopes INTO f_kind, f_owner, f_id, f_scopes FROM pim_app.token_consumers t WHERE t.token_hash = p_hash AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now());
	END IF;
	PERFORM set_config('pim.lookup', '', true);
	IF f_owner IS NULL THEN RETURN; END IF;
	PERFORM set_config('pim.owner_id', f_owner, true);
	RETURN QUERY SELECT f_kind, f_owner, f_id, f_scopes, a.role, a.status FROM pim_app.accounts a WHERE a.owner_id = f_owner;
	PERFORM set_config('pim.owner_id', '', true);
END $$;

-- Whether a credential's owner is alive and the credential neither revoked nor expired: asked again while a socket stays open.
CREATE FUNCTION pim_app.live_valid(p_kind text, p_owner text, p_id text) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE alive boolean; ok boolean;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT a.status = 'active' INTO alive FROM pim_app.accounts a WHERE a.owner_id = p_owner;
	IF p_kind = 'user' THEN
		SELECT EXISTS (SELECT 1 FROM pim_app.browser_sessions s WHERE s.id = p_id AND s.owner_id = p_owner AND s.revoked_at IS NULL AND s.expires_at > now()) INTO ok;
	ELSE
		SELECT EXISTS (SELECT 1 FROM pim_app.api_tokens t WHERE t.id = p_id AND t.owner_id = p_owner AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()))
			OR EXISTS (SELECT 1 FROM pim_app.token_consumers t WHERE t.id = p_id AND t.owner_id = p_owner AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())) INTO ok;
	END IF;
	PERFORM set_config('pim.owner_id', '', true);
	RETURN coalesce(alive, false) AND coalesce(ok, false);
END $$;

REVOKE ALL ON FUNCTION pim_app.relay_claim(text, integer, integer), pim_app.relay_committed(text, text), pim_app.relay_release(text, text), pim_app.live_authenticate(text, text), pim_app.live_valid(text, text, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA pim_app TO pim_runtime, pim_live;
GRANT EXECUTE ON FUNCTION pim_app.relay_claim(text, integer, integer), pim_app.relay_committed(text, text), pim_app.relay_release(text, text) TO pim_runtime;
GRANT EXECUTE ON FUNCTION pim_app.live_authenticate(text, text), pim_app.live_valid(text, text, text) TO pim_live;

-- ---- The Gate serves what Live projects and Forge's HTTP API ----

-- Snapshots read the projections as one owner (their row-level policy applies to pim_gate too).
GRANT SELECT ON pim_projection.chat_transcript_projection, pim_projection.sidebar_session_projection, pim_projection.coding_thread_projection, pim_projection.live_event_log TO pim_gate;
GRANT USAGE ON SCHEMA pim_projection TO pim_gate;

-- Forge's HTTP handlers run in the Gate, over Forge's tables, which carry no row-level security (every query names its owner).
GRANT USAGE ON SCHEMA pim_forge TO pim_gate;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_forge TO pim_gate;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pim_forge TO pim_gate;
