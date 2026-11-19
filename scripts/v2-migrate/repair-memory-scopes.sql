-- Repairs the memory scopes of a space migrated from v1 before the importer carried them (v2-server's migration-bridge). Run it once with psql as a role
-- that may write pim_app (the superuser works): psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/v2-migrate/repair-memory-scopes.sql
-- It is safe to run again. It names the three scopes the person made in v1 and sets what each agent reads, as v1 had it:
--   Groves (p_3479450c020b, the majordomo) keeps its own scope under the name `private`; every other agent keeps `agent-<id>`;
--   Radia and Linus read Infrastructure, Richard and Wendy read Career, Jens reads Minecraft; the others read no named scope.
-- Every agent also reads `everyone`, and Groves, the majordomo, reads every scope (migration 0698). The code that reads these settings (migration 0697) must be deployed for them to take effect.
-- It does not move any memory: for Groves's memories written since the cutover, see repair-memory-scopes-move-groves.sql.
BEGIN;

-- The space is the one Groves belongs to; its rows are sealed to it.
SELECT set_config('pim.owner_id', (SELECT owner_id FROM pim_app.agents WHERE id = 'p_3479450c020b'), true);

INSERT INTO pim_app.memory_scopes (owner_id, key, name, created_at)
SELECT public.pim_current_owner_id(), v.key, v.name, to_timestamp(1792659314999 / 1000.0)
FROM (VALUES ('s_d6af915a11c2', 'Career'), ('s_0976f80dd473', 'Minecraft'), ('s_71ec001ec118', 'Infrastructure')) AS v (key, name)
ON CONFLICT (owner_id, key) DO UPDATE SET name = EXCLUDED.name;

-- Every agent of the space starts with no named scope and its default own scope; the lists below then give what v1 had.
UPDATE pim_app.agents a
SET config = (a.config - 'memoryScope')
	|| jsonb_build_object('memoryScopes', coalesce((
		SELECT jsonb_agg(s.scope) FROM (VALUES
			('p_044a25e062cf', 's_71ec001ec118'), ('p_e8bd8aaf2900', 's_71ec001ec118'),
			('p_6de02e765733', 's_d6af915a11c2'), ('p_f75b6be775e7', 's_d6af915a11c2'),
			('p_66296fd4483c', 's_0976f80dd473')
		) AS s (agent, scope) WHERE s.agent = a.id), '[]'::jsonb))
	|| CASE WHEN a.id = 'p_3479450c020b' THEN '{"memoryScope": "private"}'::jsonb ELSE '{}'::jsonb END
WHERE a.deleted_at IS NULL AND a.owner_id = public.pim_current_owner_id();

COMMIT;

-- What it left, for a look:
--   SELECT id, name, config->>'memoryScope' AS own, config->'memoryScopes' AS named FROM pim_app.agents WHERE deleted_at IS NULL ORDER BY created_at;
