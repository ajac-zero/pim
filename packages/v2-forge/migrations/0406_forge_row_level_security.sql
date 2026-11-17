-- Defense in depth for the Gate: pim_gate reaches pim_forge for the coding API, and a query that forgot its owner must not return another person's rows.
-- A request's transaction sets pim.owner_id (db.ts scopedDb); the policies below show pim_gate only that owner's threads, vault entries and settings, and what hangs off their threads.
-- Grants, quotas and standing approvals are the admin's records, written for any owner through the Gate, so they carry no owner policy.
-- The worker and maintenance roles, which step every owner's threads, see everything. The schema owner and the SECURITY DEFINER feeds are not subject to the policies (no FORCE), so migrations and Live's functions work as before.
DO $$
DECLARE t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['forge_threads', 'forge_repo_settings', 'forge_vault'] LOOP
		EXECUTE format('ALTER TABLE pim_forge.%I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('CREATE POLICY gate_owner ON pim_forge.%I FOR ALL TO pim_gate USING (owner_id = public.pim_current_owner_id()) WITH CHECK (owner_id = public.pim_current_owner_id())', t);
		EXECUTE format('CREATE POLICY service_all ON pim_forge.%I FOR ALL TO pim_forge, pim_maintenance USING (true) WITH CHECK (true)', t);
	END LOOP;
	FOREACH t IN ARRAY ARRAY['forge_inbox', 'forge_events', 'forge_checkpoints', 'forge_diffs', 'forge_test_runs', 'forge_tool_journal', 'forge_harness_sessions', 'forge_harness_runs', 'forge_autosaves', 'forge_pi_entries', 'forge_pi_commits', 'forge_approvals', 'forge_slots', 'forge_queue'] LOOP
		EXECUTE format('ALTER TABLE pim_forge.%I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('CREATE POLICY gate_owner ON pim_forge.%I FOR ALL TO pim_gate USING (EXISTS (SELECT 1 FROM pim_forge.forge_threads th WHERE th.thread_id = %I.thread_id)) WITH CHECK (EXISTS (SELECT 1 FROM pim_forge.forge_threads th WHERE th.thread_id = %I.thread_id))', t, t, t);
		EXECUTE format('CREATE POLICY service_all ON pim_forge.%I FOR ALL TO pim_forge, pim_maintenance USING (true) WITH CHECK (true)', t);
	END LOOP;
	-- The outbox also carries rows that belong to no thread (a pool's audit record): the Gate may add and see those, and its own threads' rows.
	ALTER TABLE pim_forge.forge_outbox ENABLE ROW LEVEL SECURITY;
	CREATE POLICY gate_owner ON pim_forge.forge_outbox FOR ALL TO pim_gate USING (thread_id IS NULL OR EXISTS (SELECT 1 FROM pim_forge.forge_threads th WHERE th.thread_id = forge_outbox.thread_id)) WITH CHECK (thread_id IS NULL OR EXISTS (SELECT 1 FROM pim_forge.forge_threads th WHERE th.thread_id = forge_outbox.thread_id));
	CREATE POLICY service_all ON pim_forge.forge_outbox FOR ALL TO pim_forge, pim_maintenance USING (true) WITH CHECK (true);
END $$;
