-- A chat's public link shows a sanitized copy made when the link was made or last updated (what the person read, never the model's reasoning, tool calls or
-- images), not the live chat. A link made before this has no copy and shows nothing until its owner updates it.
ALTER TABLE pim_app.shares ADD COLUMN copy jsonb, ADD COLUMN shared_at timestamptz;
