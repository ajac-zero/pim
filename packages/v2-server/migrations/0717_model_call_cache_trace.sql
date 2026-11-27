-- What a model request looked like to the provider's prompt cache, as keyed hashes and counts and nothing of its content (`packages/v2-server/src/request-fingerprint.ts`): kept with every model call,
-- a fast successful one too, so two consecutive calls of a chat can be compared to find where their shared prefix ends and whether a cache breakpoint an earlier call wrote lies on the later one.
-- The Runner sends it in the call's detail (`p_detail -> 'cacheTrace'`), so the function keeps its signature.
ALTER TABLE pim_app.model_calls ADD COLUMN cache_trace jsonb;

CREATE OR REPLACE FUNCTION pim_app.record_model_call(p_owner text, p_id text, p_run_kind text, p_chat uuid, p_provider text, p_model text, p_input bigint, p_output bigint, p_cost bigint,
	p_cache_read bigint DEFAULT 0, p_cache_write bigint DEFAULT 0, p_agent text DEFAULT NULL, p_detail jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	inserted integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	INSERT INTO pim_app.model_calls (id, owner_id, run_kind, public_chat_id, provider, model, input_tokens, output_tokens, cost_microusd, cache_read_tokens, cache_write_tokens, agent_id,
		stop_reason, latency_ms, error, request, turn_index, tool_count, prompt_bytes, cache_trace)
	VALUES (p_id, p_owner, p_run_kind, p_chat, p_provider, p_model, greatest(p_input, 0), greatest(p_output, 0), greatest(p_cost, 0), greatest(coalesce(p_cache_read, 0), 0), greatest(coalesce(p_cache_write, 0), 0), p_agent,
		left(p_detail ->> 'stopReason', 40), (p_detail ->> 'latencyMs')::integer, left(p_detail ->> 'error', 4000), p_detail -> 'request', (p_detail ->> 'turnIndex')::integer, (p_detail ->> 'toolCount')::integer, (p_detail ->> 'promptBytes')::integer,
		p_detail -> 'cacheTrace')
	ON CONFLICT DO NOTHING;
	GET DIAGNOSTICS inserted = ROW_COUNT;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN inserted > 0;
END $$;
