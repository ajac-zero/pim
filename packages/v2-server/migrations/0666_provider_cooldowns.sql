-- Provider cooldowns shared by every Runner. A model that failed before it produced output (rate limit, overload, a refused credential) is skipped for a while; the cooldown
-- was in each Runner's memory, so a second Runner kept trying a model the first had just found down. Now the first writes it here and the others read it.
CREATE TABLE pim_runtime.provider_cooldowns (
	owner_id text NOT NULL,
	ref text NOT NULL,
	until timestamptz NOT NULL,
	reason text NOT NULL DEFAULT '',
	PRIMARY KEY (owner_id, ref)
);
ALTER TABLE pim_runtime.provider_cooldowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE pim_runtime.provider_cooldowns FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_isolation ON pim_runtime.provider_cooldowns USING (owner_id = public.pim_current_owner_id()) WITH CHECK (owner_id = public.pim_current_owner_id());
