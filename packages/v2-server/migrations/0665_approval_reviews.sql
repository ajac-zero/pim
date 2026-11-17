-- Majordomo approval reviews. Under the approval policy `majordomo` a waiting approval is read once by the person's majordomo, which approves it, denies it, or hands it back
-- to the person (`review.status` = escalated). The Runner finds the approvals to review across owners without being any owner, as the relay finds commands (0602); what it
-- claims is marked `reviewing` in the approval's arguments in the same statement, so two Runners never review one approval, and a review that was never answered (the Runner
-- died, the model hung) is escalated after `p_escalate_ms`, so a person is never left waiting on a review that is not happening.
CREATE FUNCTION pim_app.review_claim(p_limit integer, p_escalate_ms integer, p_default_policy text)
	RETURNS TABLE (owner_id text, id text, public_chat_id uuid, tool text, args jsonb)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE o text; owners text[];
BEGIN
	PERFORM set_config('pim.scope', 'all', true);
	SELECT array_agg(d.owner_id) INTO owners FROM (SELECT DISTINCT a.owner_id FROM pim_app.approvals a WHERE a.state = 'waiting'
		AND ((NOT (a.args ? 'review') AND coalesce(a.args->>'explicit', '') <> 'true') OR (a.args->'review'->>'status' = 'reviewing' AND (a.args->'review'->>'at')::timestamptz < now() - (p_escalate_ms || ' milliseconds')::interval))) d;
	PERFORM set_config('pim.scope', '', true);
	FOREACH o IN ARRAY coalesce(owners, ARRAY[]::text[]) LOOP
		PERFORM set_config('pim.owner_id', o, true);
		UPDATE pim_app.approvals a SET args = a.args || jsonb_build_object('review', jsonb_build_object('status', 'escalated', 'note', 'The review did not finish.', 'at', now()))
			WHERE a.state = 'waiting' AND a.args->'review'->>'status' = 'reviewing' AND (a.args->'review'->>'at')::timestamptz < now() - (p_escalate_ms || ' milliseconds')::interval;
		IF coalesce((SELECT s.value #>> '{}' FROM pim_app.owner_settings s WHERE s.owner_id = o AND s.key = 'settings.approvalPolicy'), p_default_policy) = 'majordomo' THEN
			RETURN QUERY
				WITH picked AS (
					UPDATE pim_app.approvals a SET args = a.args || jsonb_build_object('review', jsonb_build_object('status', 'reviewing', 'at', now()))
					WHERE a.id IN (SELECT x.id FROM pim_app.approvals x WHERE x.state = 'waiting' AND NOT (x.args ? 'review') AND coalesce(x.args->>'explicit', '') <> 'true' ORDER BY x.created_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
					RETURNING a.owner_id, a.id, a.public_chat_id, a.tool, a.args)
				SELECT p.owner_id, p.id, p.public_chat_id, p.tool, p.args FROM picked p;
		END IF;
	END LOOP;
	PERFORM set_config('pim.owner_id', '', true);
END $$;

REVOKE ALL ON FUNCTION pim_app.review_claim(integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.review_claim(integer, integer, text) TO pim_runtime;
