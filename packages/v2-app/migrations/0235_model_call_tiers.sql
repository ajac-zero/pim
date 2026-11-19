-- What v1's model-call ledger kept that v2's did not: the cache tiers of a call's tokens (priced apart, and part of the day's token count) and the agent it ran as.
ALTER TABLE pim_app.model_calls ADD COLUMN cache_read_tokens bigint NOT NULL DEFAULT 0, ADD COLUMN cache_write_tokens bigint NOT NULL DEFAULT 0, ADD COLUMN agent_id text;
