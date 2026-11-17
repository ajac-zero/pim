-- Notifications and Web Push. A notification is what the bell lists: an approval waiting, an agent mentioning the person. A push is a message to the
-- person's devices that a delivery pass sends and keeps trying until it is sent or dropped, so a restart loses none; its row is kept as the record that the
-- message was made, which is also what keeps the same event from being announced twice (the id is derived from the event: `approval-<id>`, `reply-<chat>-<ms>`).
-- All of it is made from rows already committed (an approval row, a reply the runtime committed); nothing is notified about before it is.
CREATE TABLE pim_app.notifications (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	kind text NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'mention', 'scheduled')),
	public_chat_id uuid,
	title text NOT NULL,
	body text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	read_at timestamptz,
	PRIMARY KEY (owner_id, id)
);
CREATE INDEX notifications_by_owner ON pim_app.notifications (owner_id, created_at DESC);
SELECT pim_app.seal_tenant('pim_app.notifications');

-- One row per browser that turned notifications on.
CREATE TABLE pim_app.push_subscriptions (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	endpoint text NOT NULL,
	p256dh text NOT NULL,
	auth text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, endpoint)
);
SELECT pim_app.seal_tenant('pim_app.push_subscriptions');

-- A message to send to every device of the owner. `reply` rows are an agent's answer: they are sent only if the chat is still unread and not at work again
-- when `send_after` comes, and, unless the person asked for every message, only when they had said something to the agent (`asked`). `alert` rows are sent as they are.
CREATE TABLE pim_app.push_queue (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	kind text NOT NULL CHECK (kind IN ('alert', 'reply')),
	public_chat_id uuid,
	title text NOT NULL,
	body text NOT NULL DEFAULT '',
	asked boolean NOT NULL DEFAULT false,
	state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'dropped')),
	send_after timestamptz NOT NULL DEFAULT now(),
	attempts integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
CREATE INDEX push_queue_pending ON pim_app.push_queue (send_after) WHERE state = 'pending';
SELECT pim_app.seal_tenant('pim_app.push_queue');

-- The latest reply of a chat that has been looked at for notifying, so each reply is read once.
ALTER TABLE pim_app.conversations ADD COLUMN notified_response_at timestamptz;

-- As approvals (0603): maintenance finds work across owners by setting pim.scope to 'all' to read, and writes one owner at a time.
CREATE POLICY notify_scope ON pim_app.conversations FOR SELECT USING (current_setting('pim.scope', true) = 'all');
CREATE POLICY notify_scope ON pim_app.notifications FOR SELECT USING (current_setting('pim.scope', true) = 'all');
CREATE POLICY notify_scope ON pim_app.push_queue FOR SELECT USING (current_setting('pim.scope', true) = 'all');

GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.notifications, pim_app.push_subscriptions, pim_app.push_queue TO pim_gate, pim_maintenance;
