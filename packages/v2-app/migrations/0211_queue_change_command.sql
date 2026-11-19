-- A person edits, cancels or steers a message queued behind their chat's running turn: the runtime applies it in the chat's partition like any other command.
ALTER TABLE pim_app.accepted_commands DROP CONSTRAINT accepted_commands_kind_check;
ALTER TABLE pim_app.accepted_commands ADD CONSTRAINT accepted_commands_kind_check
	CHECK (kind IN ('user_message', 'approval_decision', 'task_wake', 'trigger_fire', 'coding_wake', 'compaction_handoff', 'abort', 'fork', 'queue_change', 'unarchive', 'delegate'));
