-- Maintenance finds the owners that have a time trigger switched on without being any owner, as it finds approvals that timed out (0603): the
-- table admits a transaction that sets pim.scope to 'all' to read, and firing still goes through one owner at a time.
CREATE POLICY sweep_scope ON pim_app.triggers FOR SELECT USING (current_setting('pim.scope', true) = 'all');
