-- A person retries from one of their messages: the runtime takes the chat back to just after it and asks the model again, in the chat's partition like any other command.
ALTER TABLE pim_app.accepted_commands DROP CONSTRAINT accepted_commands_kind_check;
ALTER TABLE pim_app.accepted_commands ADD CONSTRAINT accepted_commands_kind_check
	CHECK (kind IN ('user_message', 'approval_decision', 'task_wake', 'trigger_fire', 'coding_wake', 'compaction_handoff', 'abort', 'fork', 'queue_change', 'retry_from', 'unarchive', 'delegate'));
