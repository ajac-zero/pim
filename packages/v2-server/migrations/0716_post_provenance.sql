-- What an agent says in a group chat reaches the host chat, and the other agents, as a message that starts "[From Name]". The models behind it are worked out where it was written and
-- ride in the accepted command that delivers it (`payload.provenance`), never in its text, which the agents read. Live projects the message from the entry that results, so it asks for
-- the command by way of the submission that placed the entry (`pim_runtime.submissions`, whose request id is the command's `pi_request_id`). The function answers that one command's provenance
-- and nothing else of either table, as the owner it is given, so Live needs no access to them.
CREATE FUNCTION pim_app.live_post_provenance(p_owner text, p_conversation bigint, p_entry bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	found jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT c.payload -> 'provenance' INTO found
	FROM pim_runtime.submissions s
	JOIN pim_app.accepted_commands c ON c.owner_id = s.owner_id AND 'w:' || c.pi_request_id = s.request_id
	WHERE s.owner_id = p_owner AND s.conversation_id = p_conversation AND substring(s.record FROM '"entry":([0-9]+)') = p_entry::text AND c.payload ? 'provenance'
	LIMIT 1;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN found;
END $$;
REVOKE ALL ON FUNCTION pim_app.live_post_provenance(text, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.live_post_provenance(text, bigint, bigint) TO pim_live;
