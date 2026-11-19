-- A trigger whose spec was changed, or that was paused or enabled, starts its condition over (v1's new generation): what the condition remembered between observations
-- (`condition_state`, 0680) is not kept across the change, so an edited threshold or a pause never inherits an old edge. Done where the column is, whichever way the trigger was changed.
CREATE FUNCTION pim_app.trigger_starts_over() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.spec IS DISTINCT FROM OLD.spec OR (NEW.lifecycle IN ('enabled', 'paused') AND NEW.lifecycle IS DISTINCT FROM OLD.lifecycle) THEN
		NEW.condition_state := NULL;
	END IF;
	RETURN NEW;
END $$;
CREATE TRIGGER trigger_starts_over BEFORE UPDATE ON pim_app.triggers FOR EACH ROW EXECUTE FUNCTION pim_app.trigger_starts_over();
