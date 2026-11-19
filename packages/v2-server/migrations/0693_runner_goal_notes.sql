-- The latest progress note of each active goal, which the `active_goals` section of the prompt shows under the goal's steps, as v1 did.
CREATE FUNCTION pim_app.runner_goal_notes(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT coalesce(jsonb_object_agg(g.id, g.notes -> -1 ->> 'text'), '{}'::jsonb) INTO result
	FROM pim_app.goals g WHERE g.owner_id = p_owner AND g.status = 'active' AND jsonb_array_length(g.notes) > 0;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;
REVOKE ALL ON FUNCTION pim_app.runner_goal_notes(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_goal_notes(text) TO pim_runtime;
