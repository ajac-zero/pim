-- Maintenance finds the owners that have an occurrence waiting behind a running turn without being any owner, as it finds those with a time trigger (0623): the table admits a
-- transaction that sets pim.scope to 'all' to read, and handing the occurrence on goes through one owner at a time.
CREATE POLICY sweep_scope ON pim_app.trigger_runs FOR SELECT USING (current_setting('pim.scope', true) = 'all');
