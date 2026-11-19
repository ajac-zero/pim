-- The connectors an agent works with: the list on the agent that answers a chat (a chat with no agent of its own is answered by the majordomo; a task's chat by the agent the task
-- was handed to). The Runner offers, lets an agent call and lets it watch only the connectors on this list, as in v1. `agent` is null when the person has no agent at all.
CREATE FUNCTION pim_app.runner_chat_apps(p_owner text, p_chat uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	chosen text;
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT c.agent_id INTO chosen FROM pim_app.conversations c JOIN pim_app.agents a ON a.owner_id = c.owner_id AND a.id = c.agent_id AND a.deleted_at IS NULL
		WHERE p_chat IS NOT NULL AND c.owner_id = p_owner AND c.public_chat_id = p_chat;
	chosen := coalesce(chosen, pim_app.majordomo_id());
	SELECT jsonb_build_object('agent', a.id, 'apps', coalesce(a.config->'apps', '[]'::jsonb)) INTO result FROM pim_app.agents a WHERE a.owner_id = p_owner AND a.id = chosen AND a.deleted_at IS NULL;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN coalesce(result, jsonb_build_object('agent', NULL, 'apps', '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION pim_app.runner_chat_apps(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_chat_apps(text, uuid) TO pim_runtime;

-- A connector's OAuth sign-in is renewed by one caller at a time and written only over the credential that caller read: a person who connected it again meanwhile keeps the
-- new one, and a rotating refresh token is never used twice. A grant the service refused for good (revoked, expired) clears the credential and says the connector needs signing
-- in again (`status` 'auth_required' without an `auth_url`, and `error`); `signin_lost_at` is when, so the person is told once (`notifier.ts`).
ALTER TABLE pim_app.connectors ADD COLUMN signin_lost_at timestamptz;
CREATE POLICY notify_scope ON pim_app.connectors FOR SELECT USING (current_setting('pim.scope', true) = 'all');

CREATE FUNCTION pim_app.runner_connector_credential(p_owner text, p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT jsonb_build_object('credential', credential) INTO result FROM pim_app.connectors WHERE owner_id = p_owner AND id = p_id;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

CREATE FUNCTION pim_app.runner_replace_connector_credential(p_owner text, p_id text, p_expected text, p_sealed text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	changed integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	UPDATE pim_app.connectors SET credential = p_sealed, status = 'connected', auth_url = NULL, error = NULL WHERE owner_id = p_owner AND id = p_id AND credential = p_expected;
	GET DIAGNOSTICS changed = ROW_COUNT;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN changed > 0;
END $$;

CREATE FUNCTION pim_app.runner_connector_signin_lost(p_owner text, p_id text, p_expected text, p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	changed integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	UPDATE pim_app.connectors SET credential = NULL, status = 'auth_required', auth_url = NULL, error = p_error, signin_lost_at = now() WHERE owner_id = p_owner AND id = p_id AND credential = p_expected;
	GET DIAGNOSTICS changed = ROW_COUNT;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN changed > 0;
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_connector_credential(text, text), pim_app.runner_replace_connector_credential(text, text, text, text), pim_app.runner_connector_signin_lost(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_connector_credential(text, text), pim_app.runner_replace_connector_credential(text, text, text, text), pim_app.runner_connector_signin_lost(text, text, text, text) TO pim_runtime;
