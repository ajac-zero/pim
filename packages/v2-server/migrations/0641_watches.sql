-- Watches: an agent's standing request to hear of one event type of a connected connector (`watch_connector_event`). The watch itself is a trigger (`source = 'connector_event'`); this
-- is its subscription with the connector's MCP server, which delivers each event by a signed webhook (Standard Webhooks, the draft MCP Events extension) to
-- `/mcp/events/<owner>/<event_key>`. `secret` is the webhook signing secret, sealed under the key ring; `provider_id` is what the server answered `events/subscribe` with (every delivery names it);
-- `renew_before` is when the server's grant runs out, and `status` is 'pending' until the server took it, 'active' after, 'ended' once it refused, was stopped, or ended it.
CREATE TABLE pim_app.watch_subscriptions (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	trigger_id text NOT NULL,
	connector_id text NOT NULL,
	event text NOT NULL,
	arguments jsonb NOT NULL DEFAULT '{}',
	secret text NOT NULL,
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'ended')),
	provider_id text,
	renew_before timestamptz,
	last_error text,
	last_event_at timestamptz,
	cursor text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, trigger_id)
);
CREATE INDEX watch_subscriptions_by_connector ON pim_app.watch_subscriptions (owner_id, connector_id);
SELECT pim_app.seal_tenant('pim_app.watch_subscriptions');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.watch_subscriptions TO pim_gate;
-- The maintenance role renews grants that are running out, across owners (as it finds approval timeouts: 0603); its table privileges are the schema's defaults (0001).
CREATE POLICY sweep_scope ON pim_app.watch_subscriptions FOR SELECT USING (current_setting('pim.scope', true) = 'all');
