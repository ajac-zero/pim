-- A bot is what its author shared of an agent when they last shared it, not the agent as it is now: the agent and its contacts as they were (`snapshot`) and when
-- (`shared_at`). A guest's copy follows the bot on the guest's next request when `shared_at` has moved past the one the copy last followed.
ALTER TABLE pim_app.bots ADD COLUMN shared_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE pim_app.bots ADD COLUMN snapshot jsonb;
UPDATE pim_app.bots SET shared_at = created_at;
