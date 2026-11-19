-- Tasks agents hand each other end when their agent's run does: the Runner finds the tasks still at work across owners without being any owner, as it finds approvals to
-- review (0665), looks at how the run of each task's chat settled, and tells the application (`task-settler.ts`). A delegate call that waits is woken by the application when
-- its tasks are done; when the call itself was stopped meanwhile, the Runner finds the batch here and has its answers delivered as an update instead.
CREATE POLICY settle_scope ON pim_app.tasks FOR SELECT USING (current_setting('pim.scope', true) = 'all');
CREATE POLICY settle_scope ON pim_app.conversations FOR SELECT USING (current_setting('pim.scope', true) = 'all');

-- The tasks at work, with the chat and pi request whose settling ends each, and whether the agent still waits for tasks of its own. (Where the chat's conversation is the runtime's directory says: the application's id for it is provisional.)
CREATE FUNCTION pim_app.tasks_open(p_limit integer)
	RETURNS TABLE (owner_id text, task_id text, task_chat uuid, wake_request text, waits_on_tasks boolean)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.scope', 'all', true);
	RETURN QUERY
		SELECT t.owner_id, t.task_id, t.task_chat, t.wake_request,
			EXISTS (SELECT 1 FROM pim_app.tasks k WHERE k.owner_id = t.owner_id AND k.started_by = t.task_chat AND k.status IN ('working', 'auth-required'))
		FROM pim_app.tasks t JOIN pim_app.conversations c ON c.owner_id = t.owner_id AND c.public_chat_id = t.task_chat
		WHERE t.status IN ('working', 'auth-required') AND t.wake_request IS NOT NULL AND c.deleted_at IS NULL
		ORDER BY t.updated_at LIMIT p_limit;
	PERFORM set_config('pim.scope', '', true);
END $$;

-- The delegate calls that wait for batches whose tasks are all done, with the pi task of each call.
CREATE FUNCTION pim_app.task_waits_open(p_limit integer)
	RETURNS TABLE (owner_id text, batch text, waiter_task bigint)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.scope', 'all', true);
	RETURN QUERY
		SELECT DISTINCT t.owner_id, t.batch, t.waiter_task FROM pim_app.tasks t
		WHERE t.waits AND t.waiter_task IS NOT NULL AND t.status IN ('completed', 'failed', 'canceled')
			AND NOT EXISTS (SELECT 1 FROM pim_app.tasks k WHERE k.owner_id = t.owner_id AND k.batch = t.batch AND k.status IN ('working', 'auth-required'))
		LIMIT p_limit;
	PERFORM set_config('pim.scope', '', true);
END $$;

REVOKE ALL ON FUNCTION pim_app.tasks_open(integer), pim_app.task_waits_open(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.tasks_open(integer), pim_app.task_waits_open(integer) TO pim_runtime;
