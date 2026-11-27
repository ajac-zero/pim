-- A person compacts a chat on demand: the runtime summarizes the older part of its context, in the chat's partition like any other command.
ALTER TABLE pim_app.accepted_commands DROP CONSTRAINT accepted_commands_kind_check;
ALTER TABLE pim_app.accepted_commands ADD CONSTRAINT accepted_commands_kind_check
	CHECK (kind IN ('user_message', 'approval_decision', 'task_wake', 'trigger_fire', 'coding_wake', 'compaction_handoff', 'abort', 'fork', 'queue_change', 'retry_from', 'compact', 'unarchive', 'delegate'));
