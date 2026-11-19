-- The messages queued behind a chat's running turn, as the runtime's inbox holds them: the chat's view shows them and lets the person change them.
-- They ride the chat's row here and not its summary, so the sidebar page does not carry their text.
ALTER TABLE pim_projection.sidebar_session_projection ADD COLUMN queue jsonb NOT NULL DEFAULT '[]'::jsonb;
