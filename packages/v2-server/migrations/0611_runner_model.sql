-- The model a person chose for agents that have none of their own (Settings, Models): the Runner reads it, with nothing else of the owner's settings.
CREATE FUNCTION pim_app.runner_model(p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT value INTO result FROM pim_app.owner_settings WHERE owner_id = p_owner AND key = 'model';
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_model(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_model(text) TO pim_runtime;
