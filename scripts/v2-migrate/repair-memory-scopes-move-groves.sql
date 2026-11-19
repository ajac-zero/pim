-- Optional. Groves (p_3479450c020b) wrote to `private` in v1, but since the cutover it has written to its own `agent-p_3479450c020b`. This moves those memories
-- to `private`, where v1 kept them, so they sit with the other 269 and Groves still reads them once repair-memory-scopes.sql has run. Run it after that file:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/v2-migrate/repair-memory-scopes-move-groves.sql
-- Safe to run again (it moves nothing the second time). Skip it to leave them where they are: Groves would then no longer read them.
BEGIN;
SELECT set_config('pim.owner_id', (SELECT owner_id FROM pim_app.agents WHERE id = 'p_3479450c020b'), true);
UPDATE pim_app.memories SET scope = 'private' WHERE scope = 'agent-p_3479450c020b' AND owner_id = public.pim_current_owner_id();
COMMIT;
