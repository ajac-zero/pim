-- The admin's Compute screen counts a stretch toward each month it ran in, by when it ran (as a person's own report does), so one that crosses midnight on the 1st is split between the two.
-- `p_since` is the first instant of the month asked for.
CREATE OR REPLACE FUNCTION pim_forge.compute_usage_overview(p_since timestamptz) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pim_forge, pg_temp AS $$
	WITH u AS (
		SELECT owner_id, provider, extract(epoch FROM (least(coalesce(ended_at, now()), p_since + interval '1 month') - greatest(began_at, p_since))) / 60 AS minutes, ended_at IS NULL AS running
		FROM pim_forge.forge_compute_usage WHERE began_at < p_since + interval '1 month' AND coalesce(ended_at, now()) > p_since
	)
	SELECT jsonb_build_object(
		'byProvider', coalesce((SELECT jsonb_agg(jsonb_build_object('provider', provider, 'minutes', minutes, 'running', running) ORDER BY provider) FROM (SELECT provider, sum(minutes) AS minutes, count(*) FILTER (WHERE running)::int AS running FROM u GROUP BY provider) p), '[]'::jsonb),
		'top', coalesce((SELECT jsonb_agg(jsonb_build_object('ownerId', owner_id, 'minutes', minutes, 'running', running) ORDER BY minutes DESC) FROM (SELECT owner_id, sum(minutes) AS minutes, count(*) FILTER (WHERE running)::int AS running FROM u GROUP BY owner_id ORDER BY sum(minutes) DESC LIMIT 10) t), '[]'::jsonb)
	)
$$;
