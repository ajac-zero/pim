-- What an open app should hear of at once: a notification, an approval filed or decided, a setting changed, a task handed out or settled, a visit. Every writer, in whichever
-- process (the Runner files approvals and tasks, maintenance makes notifications, the Gate does the rest), says so the same way: a NOTIFY naming the owner, the kind and
-- the row. The Gate listens, reads the row as its owner, and tells that owner's Live sockets (`notice-bridge.ts`). The notice carries no state of its own, and a lost one is
-- caught by the app reloading what it shows when its socket reconnects.
CREATE FUNCTION pim_app.notify_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
	row_ jsonb := to_jsonb(COALESCE(NEW, OLD));
	kind_ text := TG_ARGV[0];
	id_ text := row_ ->> TG_ARGV[1];
BEGIN
	-- Only a person's own settings (not the model's or the majordomo's bookkeeping) are a "settings" change.
	IF kind_ = 'settings' AND (row_ ->> 'key') NOT LIKE 'settings.%' THEN
		RETURN NULL;
	END IF;
	PERFORM pg_notify('pim_notice', json_build_object('owner', row_ ->> 'owner_id', 'kind', kind_, 'id', id_, 'key', txid_current()::text || ':' || TG_TABLE_NAME || ':' || COALESCE(id_, ''))::text);
	RETURN NULL;
END;
$$;

CREATE TRIGGER notice_approvals AFTER INSERT OR UPDATE OF state ON pim_app.approvals FOR EACH ROW EXECUTE FUNCTION pim_app.notify_notice('approval', 'id');
CREATE TRIGGER notice_notifications AFTER INSERT ON pim_app.notifications FOR EACH ROW EXECUTE FUNCTION pim_app.notify_notice('notification', 'id');
CREATE TRIGGER notice_tasks AFTER INSERT OR UPDATE OF status ON pim_app.tasks FOR EACH ROW EXECUTE FUNCTION pim_app.notify_notice('tasks', 'started_by');
CREATE TRIGGER notice_settings AFTER INSERT OR UPDATE OR DELETE ON pim_app.owner_settings FOR EACH ROW EXECUTE FUNCTION pim_app.notify_notice('settings', 'key');
CREATE TRIGGER notice_visits AFTER INSERT OR DELETE ON pim_app.visits FOR EACH ROW EXECUTE FUNCTION pim_app.notify_notice('visits', 'id');
