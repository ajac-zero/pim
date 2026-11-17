-- The person's time zone, which the Runner tells their agents (the `user_time_zone` section of the prompt, and what `current_time` answers in).
-- NULL when they never chose one: the deployment's PIM_TIME_ZONE, or UTC, applies then.
CREATE FUNCTION pim_app.runner_time_zone(p_owner text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	zone text;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT value #>> '{}' INTO zone FROM pim_app.owner_settings WHERE owner_id = p_owner AND key = 'settings.timeZone';
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN zone;
END $$;
REVOKE ALL ON FUNCTION pim_app.runner_time_zone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_time_zone(text) TO pim_runtime;
