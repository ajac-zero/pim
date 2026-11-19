-- What v1's model-call ledger kept that v2's did not, written by a Runner (the columns are in the application's migration 0235): the cache tiers of a call's tokens and the agent it ran
-- as, with the chat it was for, and a per-request meter for the daily limits. A request is counted in `usage_days.model_requests` when it is sent, under the day's row lock, so two requests at once cannot both take the last one;
-- tokens are known only once a request ends, so they are read from the ledger, and requests already under way can take the day past its token limit (the next request is refused).
-- A request is counted here when it is sent, which is what the daily request limit is checked against.
ALTER TABLE pim_app.usage_days ADD COLUMN model_requests integer NOT NULL DEFAULT 0;

DROP FUNCTION pim_app.record_model_call(text, text, text, uuid, text, text, bigint, bigint, bigint);
CREATE FUNCTION pim_app.record_model_call(p_owner text, p_id text, p_run_kind text, p_chat uuid, p_provider text, p_model text, p_input bigint, p_output bigint, p_cost bigint,
	p_cache_read bigint DEFAULT 0, p_cache_write bigint DEFAULT 0, p_agent text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	inserted integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	INSERT INTO pim_app.model_calls (id, owner_id, run_kind, public_chat_id, provider, model, input_tokens, output_tokens, cost_microusd, cache_read_tokens, cache_write_tokens, agent_id)
	VALUES (p_id, p_owner, p_run_kind, p_chat, p_provider, p_model, greatest(p_input, 0), greatest(p_output, 0), greatest(p_cost, 0), greatest(coalesce(p_cache_read, 0), 0), greatest(coalesce(p_cache_write, 0), 0), p_agent) ON CONFLICT DO NOTHING;
	GET DIAGNOSTICS inserted = ROW_COUNT;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN inserted > 0;
END $$;
REVOKE ALL ON FUNCTION pim_app.record_model_call(text, text, text, uuid, text, text, bigint, bigint, bigint, bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.record_model_call(text, text, text, uuid, text, text, bigint, bigint, bigint, bigint, bigint, text) TO pim_runtime;

-- A Runner is about to send a model request of its owner: null when it may go (and it is counted), else the limit that is used up, as the sentence the person reads.
-- `p_default_*` are the deployment's limits (null: none); the owner's override and the admin's exemption are read here, since a Runner has no grant on pim_app. Tokens count
-- only models the deployment pays for, the person's own providers and plan not (as in `Quota`).
CREATE FUNCTION pim_app.runner_reserve_model_request(p_owner text, p_provider text, p_default_tokens bigint, p_default_requests bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	is_admin boolean;
	override jsonb;
	max_tokens bigint := p_default_tokens;
	max_requests bigint := p_default_requests;
	today date := (now() AT TIME ZONE 'UTC')::date;
	used_tokens bigint;
	used_requests integer;
	refusal text;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT role = 'admin' INTO is_admin FROM pim_app.accounts WHERE owner_id = p_owner;
	SELECT value INTO override FROM pim_app.owner_settings WHERE owner_id = p_owner AND key = 'limits';
	IF override IS NOT NULL AND override ? 'dailyTokens' THEN max_tokens := (override ->> 'dailyTokens')::bigint; END IF;
	IF override IS NOT NULL AND override ? 'dailyModelRequests' THEN max_requests := (override ->> 'dailyModelRequests')::bigint; END IF;
	IF coalesce(is_admin, false) OR (max_tokens IS NULL AND max_requests IS NULL) THEN
		PERFORM set_config('pim.owner_id', previous, true);
		RETURN NULL;
	END IF;
	-- Taking the day's row serializes the owner's requests, so the count below is exact.
	INSERT INTO pim_app.usage_days (owner_id, day) VALUES (p_owner, today) ON CONFLICT (owner_id, day) DO NOTHING;
	SELECT model_requests INTO used_requests FROM pim_app.usage_days WHERE owner_id = p_owner AND day = today FOR UPDATE;
	IF max_requests IS NOT NULL AND used_requests >= max_requests THEN
		refusal := max_requests || ' model requests a day. It resets at midnight UTC.';
	ELSIF max_tokens IS NOT NULL AND p_provider NOT LIKE 'own:%' AND p_provider <> 'chatgpt' THEN
		SELECT coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) INTO used_tokens FROM pim_app.model_calls
		WHERE owner_id = p_owner AND at >= today::timestamp AT TIME ZONE 'UTC' AND coalesce(provider, '') NOT LIKE 'own:%' AND coalesce(provider, '') <> 'chatgpt';
		IF used_tokens >= max_tokens THEN refusal := max_tokens || ' tokens a day. It resets at midnight UTC.'; END IF;
	END IF;
	IF refusal IS NULL THEN UPDATE pim_app.usage_days SET model_requests = model_requests + 1 WHERE owner_id = p_owner AND day = today; END IF;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN refusal;
END $$;
REVOKE ALL ON FUNCTION pim_app.runner_reserve_model_request(text, text, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_reserve_model_request(text, text, bigint, bigint) TO pim_runtime;
