-- Group chats (rooms). A room is its host chat plus a seat for each other agent: a conversation of its own, so the agent works as itself, with its own instructions, memory
-- and tools, hidden from the chat list (`room_of` names the room it sits in). What the person says goes into every seat and what an agent sends goes into the host chat as
-- "[From Name]" (v1's `src/rooms.ts`). `seat_chat_id` is the seat of a member; a Runner learns who is in the room it speaks in through `runner_room` and nothing else.

ALTER TABLE pim_app.conversations ADD COLUMN room_of uuid REFERENCES pim_app.conversations (public_chat_id);
ALTER TABLE pim_app.room_members ADD COLUMN seat_chat_id uuid REFERENCES pim_app.conversations (public_chat_id);

-- For a chat that is a room's host or one of its seats: who is in the room, how they take turns, and which one this chat is. Null for any other chat.
CREATE FUNCTION pim_app.runner_room(p_owner text, p_chat uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	chat pim_app.conversations%ROWTYPE;
	host_chat uuid;
	result jsonb;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT * INTO chat FROM pim_app.conversations WHERE owner_id = p_owner AND public_chat_id = p_chat AND deleted_at IS NULL;
	host_chat := coalesce(chat.room_of, CASE WHEN EXISTS (SELECT 1 FROM pim_app.room_members WHERE public_chat_id = p_chat) THEN p_chat END);
	IF host_chat IS NOT NULL THEN
		SELECT jsonb_build_object(
			'role', CASE WHEN chat.room_of IS NULL THEN 'host' ELSE 'seat' END,
			'mode', coalesce(h.room_mode, 'mentions'),
			'host', (SELECT jsonb_build_object('id', a.id, 'name', a.name) FROM pim_app.agents a WHERE a.owner_id = p_owner AND a.id = h.agent_id),
			'members', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY m.member) FROM pim_app.room_members m JOIN pim_app.agents a ON a.owner_id = p_owner AND a.id = m.member WHERE m.public_chat_id = host_chat), '[]'::jsonb))
		INTO result FROM pim_app.conversations h WHERE h.owner_id = p_owner AND h.public_chat_id = host_chat;
	END IF;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_room(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_room(text, uuid) TO pim_runtime;
