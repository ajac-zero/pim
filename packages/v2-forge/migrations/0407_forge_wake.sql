-- A worker is woken the moment there is work, rather than at its next poll: new input for a thread, a new thread, and a thread moved to provisioning (promoted from the queue).
CREATE FUNCTION pim_forge.forge_notify_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_notify('pim_forge_work', NEW.thread_id);
	RETURN NEW;
END $$;
CREATE TRIGGER forge_inbox_notify AFTER INSERT ON pim_forge.forge_inbox FOR EACH ROW EXECUTE FUNCTION pim_forge.forge_notify_work();
CREATE TRIGGER forge_threads_notify AFTER INSERT ON pim_forge.forge_threads FOR EACH ROW EXECUTE FUNCTION pim_forge.forge_notify_work();
CREATE TRIGGER forge_threads_state_notify AFTER UPDATE OF state ON pim_forge.forge_threads FOR EACH ROW WHEN (NEW.state IN ('provisioning', 'running') AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION pim_forge.forge_notify_work();
