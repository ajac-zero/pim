-- What an admin reads to see why a chat was slow or a model call failed: the model-call ledger keeps how each call ended, how long it took, the provider's error and where its time went (the columns
-- are in the application's migration 0214), and an event log keeps the last 200 things per person that only the process logs heard before.
-- A call with the detail a Runner knows of it (`p_detail`: stopReason, latencyMs, error, request, turnIndex, toolCount, promptBytes), and with no tokens when it failed: a failed call is a row too.
DROP FUNCTION pim_app.record_model_call(text, text, text, uuid, text, text, bigint, bigint, bigint, bigint, bigint, text);
CREATE FUNCTION pim_app.record_model_call(p_owner text, p_id text, p_run_kind text, p_chat uuid, p_provider text, p_model text, p_input bigint, p_output bigint, p_cost bigint,
	p_cache_read bigint DEFAULT 0, p_cache_write bigint DEFAULT 0, p_agent text DEFAULT NULL, p_detail jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	inserted integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	INSERT INTO pim_app.model_calls (id, owner_id, run_kind, public_chat_id, provider, model, input_tokens, output_tokens, cost_microusd, cache_read_tokens, cache_write_tokens, agent_id,
		stop_reason, latency_ms, error, request, turn_index, tool_count, prompt_bytes)
	VALUES (p_id, p_owner, p_run_kind, p_chat, p_provider, p_model, greatest(p_input, 0), greatest(p_output, 0), greatest(p_cost, 0), greatest(coalesce(p_cache_read, 0), 0), greatest(coalesce(p_cache_write, 0), 0), p_agent,
		left(p_detail ->> 'stopReason', 40), (p_detail ->> 'latencyMs')::integer, left(p_detail ->> 'error', 4000), p_detail -> 'request', (p_detail ->> 'turnIndex')::integer, (p_detail ->> 'toolCount')::integer, (p_detail ->> 'promptBytes')::integer)
	ON CONFLICT DO NOTHING;
	GET DIAGNOSTICS inserted = ROW_COUNT;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN inserted > 0;
END $$;
REVOKE ALL ON FUNCTION pim_app.record_model_call(text, text, text, uuid, text, text, bigint, bigint, bigint, bigint, bigint, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.record_model_call(text, text, text, uuid, text, text, bigint, bigint, bigint, bigint, bigint, text, jsonb) TO pim_runtime;

CREATE TABLE pim_app.diagnostic_events (
	id bigserial PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	at timestamptz NOT NULL DEFAULT now(),
	kind text NOT NULL,
	detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX diagnostic_events_by_owner ON pim_app.diagnostic_events (owner_id, id DESC);
SELECT pim_app.seal_tenant('pim_app.diagnostic_events');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.diagnostic_events TO pim_gate;
GRANT USAGE, SELECT ON SEQUENCE pim_app.diagnostic_events_id_seq TO pim_gate;

-- A Runner or the Gate keeps an event of a person's space, and the log keeps the last 200 of them: older ones go as new ones come.
CREATE FUNCTION pim_app.record_diagnostic_event(p_owner text, p_kind text, p_detail jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	INSERT INTO pim_app.diagnostic_events (owner_id, kind, detail) VALUES (p_owner, left(p_kind, 60), coalesce(p_detail, '{}'));
	DELETE FROM pim_app.diagnostic_events WHERE owner_id = p_owner AND id <= (SELECT max(id) FROM pim_app.diagnostic_events WHERE owner_id = p_owner) - 200;
	PERFORM set_config('pim.owner_id', previous, true);
END $$;
REVOKE ALL ON FUNCTION pim_app.record_diagnostic_event(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.record_diagnostic_event(text, text, jsonb) TO pim_runtime, pim_gate;

-- The models of a person that are cooling down after a failure, which the Runners keep in pim_runtime and the Gate cannot read: what the admin's diagnostics show.
CREATE FUNCTION pim_app.owner_provider_cooldowns(p_owner text) RETURNS TABLE (ref text, until timestamptz, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pim_runtime, pg_temp AS $$
	SELECT c.ref, c.until, c.reason FROM pim_runtime.provider_cooldowns c WHERE c.owner_id = p_owner ORDER BY c.until DESC
$$;
REVOKE ALL ON FUNCTION pim_app.owner_provider_cooldowns(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.owner_provider_cooldowns(text) TO pim_gate;
