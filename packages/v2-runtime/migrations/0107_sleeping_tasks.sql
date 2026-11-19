-- pi 1.5.2 records timed waits as sleeping tasks, separately from tasks waiting for children or an outside signal.
alter table pim_runtime.tasks drop constraint tasks_status_check;
alter table pim_runtime.tasks add constraint tasks_status_check
	check (status in ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal'));
