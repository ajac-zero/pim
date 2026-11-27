-- A coding thread's cost was recorded in the ledger without the chat that started it, so the chat's cost meter, which reads the ledger by chat, left it out. Rows already recorded take the chat of
-- their thread (and its harness as their provider, as new rows do); a thread with no chat, or whose chat id is not a Pim chat's, stays as it was.
UPDATE pim_app.model_calls m
SET public_chat_id = t.chat_id::uuid, provider = coalesce(m.provider, t.harness)
FROM pim_forge.forge_threads t
WHERE m.run_kind = 'coding_thread' AND m.public_chat_id IS NULL AND m.thread_id = t.thread_id AND m.owner_id = t.owner_id
	AND t.chat_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
