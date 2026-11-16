-- Maintenance finds work across owners without being any owner: approvals whose timeout has passed. As with the command inbox (0602), the table admits a
-- transaction that sets pim.scope to 'all' to read, and writes still go through one owner at a time.
CREATE POLICY sweep_scope ON pim_app.approvals FOR SELECT USING (current_setting('pim.scope', true) = 'all');
