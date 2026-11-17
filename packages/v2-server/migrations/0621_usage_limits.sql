-- Per-space limits and what a person used today. Limits come from the deployment (PIM_LIMIT_*) and the admin's override for one person
-- (owner_settings 'limits'); the admin's own space has none. Runs and tool calls are counted per UTC day here; model requests and tokens
-- are counted from pim_app.model_calls.
CREATE TABLE pim_app.usage_days (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	day date NOT NULL,
	runs integer NOT NULL DEFAULT 0,
	tool_calls integer NOT NULL DEFAULT 0,
	PRIMARY KEY (owner_id, day)
);
SELECT pim_app.seal_tenant('pim_app.usage_days');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.usage_days TO pim_gate;

-- A Runner counts a tool call of its owner and learns whether the day's allowance still has room. `p_default` is the deployment's limit
-- (null: none); the owner's override and the admin's exemption are read here, since a Runner has no grant on pim_app.
CREATE FUNCTION pim_app.runner_count_tool_call(p_owner text, p_default bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	is_admin boolean;
	override jsonb;
	allowed bigint;
	used integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT role = 'admin' INTO is_admin FROM pim_app.accounts WHERE owner_id = p_owner;
	SELECT value INTO override FROM pim_app.owner_settings WHERE owner_id = p_owner AND key = 'limits';
	IF override IS NOT NULL AND override ? 'dailyToolCalls' THEN allowed := (override ->> 'dailyToolCalls')::bigint; ELSE allowed := p_default; END IF;
	IF coalesce(is_admin, false) THEN allowed := NULL; END IF;
	INSERT INTO pim_app.usage_days (owner_id, day, tool_calls) VALUES (p_owner, (now() AT TIME ZONE 'UTC')::date, 1)
		ON CONFLICT (owner_id, day) DO UPDATE SET tool_calls = pim_app.usage_days.tool_calls + 1 RETURNING tool_calls INTO used;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN allowed IS NULL OR used <= allowed;
END $$;
REVOKE ALL ON FUNCTION pim_app.runner_count_tool_call(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_count_tool_call(text, bigint) TO pim_runtime;
