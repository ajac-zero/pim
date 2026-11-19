-- What the cost report and an admin's diagnostics draw from the model-call ledger besides tokens: how a call ended, how long it took, the provider's error and where its time went, the size of what was asked,
-- and the coding thread a call was for. A call is recorded even when it failed, with no tokens.
ALTER TABLE pim_app.model_calls
	ADD COLUMN stop_reason text,
	ADD COLUMN latency_ms integer,
	ADD COLUMN error text,
	ADD COLUMN request jsonb,
	ADD COLUMN turn_index integer,
	ADD COLUMN tool_count integer,
	ADD COLUMN prompt_bytes integer,
	ADD COLUMN thread_id text;
ALTER TABLE pim_app.model_calls DROP CONSTRAINT model_calls_run_kind_check;
ALTER TABLE pim_app.model_calls ADD CONSTRAINT model_calls_run_kind_check CHECK (run_kind IN ('chat', 'background', 'coding_thread', 'scheduled', 'trigger', 'task'));
CREATE INDEX model_calls_by_thread ON pim_app.model_calls (owner_id, thread_id) WHERE thread_id IS NOT NULL;

