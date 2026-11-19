-- The notifier (maintenance) finds the schedules that fired across owners, to tell each person once that a scheduled task ran. As with approvals (0603): reading across owners
-- needs `pim.scope` set to 'all'; it writes one owner at a time.
CREATE POLICY notify_scope ON pim_app.schedule_runs FOR SELECT USING (current_setting('pim.scope', true) = 'all');
