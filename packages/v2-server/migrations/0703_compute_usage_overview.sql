-- The admin's Compute screen: everyone's sandbox minutes this month, by provider and by person. The compute ledger is held per person (row-level security), so the deployment-wide totals are read
-- through this definer function alone, which returns sums and nothing of any thread. The Gate calls it for an admin.
CREATE FUNCTION pim_forge.compute_usage_overview(p_since timestamptz) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pim_forge, pg_temp AS $$
	WITH u AS (
		SELECT owner_id, provider, extract(epoch FROM (coalesce(ended_at, now()) - began_at)) / 60 AS minutes, ended_at IS NULL AS running
		FROM pim_forge.forge_compute_usage WHERE began_at >= p_since
	)
	SELECT jsonb_build_object(
		'byProvider', coalesce((SELECT jsonb_agg(jsonb_build_object('provider', provider, 'minutes', minutes, 'running', running) ORDER BY provider) FROM (SELECT provider, sum(minutes) AS minutes, count(*) FILTER (WHERE running)::int AS running FROM u GROUP BY provider) p), '[]'::jsonb),
		'top', coalesce((SELECT jsonb_agg(jsonb_build_object('ownerId', owner_id, 'minutes', minutes, 'running', running) ORDER BY minutes DESC) FROM (SELECT owner_id, sum(minutes) AS minutes, count(*) FILTER (WHERE running)::int AS running FROM u GROUP BY owner_id ORDER BY sum(minutes) DESC LIMIT 10) t), '[]'::jsonb)
	)
$$;
REVOKE ALL ON FUNCTION pim_forge.compute_usage_overview(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_forge.compute_usage_overview(timestamptz) TO pim_gate;
