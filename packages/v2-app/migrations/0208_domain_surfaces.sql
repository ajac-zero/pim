-- What the agent, connector, usage, trigger, app and sharing services need beyond 0205 and 0206.

CREATE TABLE pim_app.owner_settings (
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	key text NOT NULL,
	value jsonb NOT NULL,
	PRIMARY KEY (owner_id, key)
);
SELECT pim_app.seal_tenant('pim_app.owner_settings');

-- Agents keep their model, fallbacks, skills, connectors, contacts and delegates in config; the fields people see are columns.
ALTER TABLE pim_app.agents ADD COLUMN emoji text, ADD COLUMN color text, ADD COLUMN icon_key text,
	ADD COLUMN adopted_from text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- The instance's default agent: what a new person may adopt (a template an admin marks as the default for everyone).
ALTER TABLE pim_app.templates ADD COLUMN default_for_everyone boolean NOT NULL DEFAULT false;

ALTER TABLE pim_app.skills ADD COLUMN version integer NOT NULL DEFAULT 1, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX skills_by_name ON pim_app.skills (owner_id, name);
CREATE TABLE pim_app.skill_versions (
	owner_id text NOT NULL,
	skill_id text NOT NULL,
	version integer NOT NULL,
	body text NOT NULL,
	files jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, skill_id, version),
	FOREIGN KEY (owner_id, skill_id) REFERENCES pim_app.skills (owner_id, id) ON DELETE CASCADE
);
SELECT pim_app.seal_tenant('pim_app.skill_versions');

-- A chat's read state and last delivered reply drive "unread".
ALTER TABLE pim_app.conversations ADD COLUMN response_at timestamptz, ADD COLUMN read_at timestamptz;

-- Connectors: where the server is, the secret that signs its webhooks, and the path key its events arrive on.
ALTER TABLE pim_app.connectors ADD COLUMN url text, ADD COLUMN event_key text UNIQUE, ADD COLUMN event_secret text,
	ADD COLUMN status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'auth_required', 'connected')),
	ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE pim_app.connector_events (
	id bigserial PRIMARY KEY,
	owner_id text NOT NULL,
	connector_id text NOT NULL,
	delivery_id text,
	payload jsonb NOT NULL,
	received_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (owner_id, connector_id, delivery_id)
);
SELECT pim_app.seal_tenant('pim_app.connector_events');
-- The webhook path carries only a random key: it finds the connector before its owner is known (as a lookup), and the HMAC proves the sender.
CREATE POLICY by_event_key ON pim_app.connectors FOR SELECT USING (event_key = pim_app.cur_lookup());

-- Triggers: the lifecycle, the chat that made one, its runs, and the computer grant a computer trigger needs.
ALTER TABLE pim_app.triggers ADD COLUMN lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'enabled', 'paused', 'ended', 'deleted')),
	ADD COLUMN title text NOT NULL DEFAULT '', ADD COLUMN origin_chat text NOT NULL DEFAULT 'api', ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE pim_app.trigger_runs (
	id text NOT NULL,
	owner_id text NOT NULL,
	trigger_id text NOT NULL,
	phase text NOT NULL CHECK (phase IN ('fired', 'delivered', 'skipped', 'failed', 'test')),
	command_id text,
	detail jsonb NOT NULL DEFAULT '{}',
	at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
CREATE INDEX trigger_runs_by_trigger ON pim_app.trigger_runs (owner_id, trigger_id, at DESC);
SELECT pim_app.seal_tenant('pim_app.trigger_runs');
CREATE TABLE pim_app.trigger_computer_grants (
	owner_id text NOT NULL,
	trigger_id text NOT NULL,
	computer_id text NOT NULL,
	granted_by text NOT NULL,
	granted_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz,
	PRIMARY KEY (owner_id, trigger_id, computer_id)
);
SELECT pim_app.seal_tenant('pim_app.trigger_computer_grants');

-- Apps: what kind, the files of each version, who may open it, and how a backend app is reached.
ALTER TABLE pim_app.artifacts ADD COLUMN kind text NOT NULL DEFAULT 'html' CHECK (kind IN ('html', 'jsx', 'backend')),
	ADD COLUMN label text UNIQUE, ADD COLUMN hosted_token text, ADD COLUMN circles text[] NOT NULL DEFAULT '{}',
	ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE pim_app.artifact_versions ADD COLUMN files jsonb NOT NULL DEFAULT '{}', ADD COLUMN message text NOT NULL DEFAULT '';

-- Sharing: a chat's public link, and the profile people see at /people/<username>.
ALTER TABLE pim_app.shares ADD COLUMN link text UNIQUE;
CREATE TABLE pim_app.profiles (
	owner_id text PRIMARY KEY REFERENCES pim_app.accounts (owner_id),
	display_name text NOT NULL DEFAULT '',
	bio text NOT NULL DEFAULT '',
	published boolean NOT NULL DEFAULT false,
	updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pim_app.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pim_app.profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY own ON pim_app.profiles USING (owner_id = public.pim_current_owner_id()) WITH CHECK (owner_id = public.pim_current_owner_id());
CREATE POLICY listed ON pim_app.profiles FOR SELECT USING (published);

-- Public templates, bots and published artifacts are shared on purpose.
CREATE POLICY listed ON pim_app.bots FOR SELECT USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA pim_app TO pim_gate;

-- Triggers: sources are @pim/triggers' kinds, and a time trigger remembers the last firing it admitted.
ALTER TABLE pim_app.triggers DROP CONSTRAINT triggers_source_check;
ALTER TABLE pim_app.triggers ADD CONSTRAINT triggers_source_check CHECK (source IN ('time', 'connector_event', 'poll', 'stream', 'process', 'file')),
	ADD COLUMN watermark bigint, ADD COLUMN enabled_at timestamptz;

-- Hosted-app access tokens are short-lived flows too; an app is also reachable by its own label, found before its owner is known.
ALTER TABLE pim_app.auth_flows DROP CONSTRAINT auth_flows_kind_check;
ALTER TABLE pim_app.auth_flows ADD CONSTRAINT auth_flows_kind_check CHECK (kind IN ('challenge', 'oauth', 'consent', 'code', 'hosted', 'hosted_enter'));
CREATE POLICY by_label ON pim_app.artifacts FOR SELECT USING (label = pim_app.cur_lookup());
CREATE POLICY by_label_versions ON pim_app.artifact_versions FOR SELECT USING (EXISTS (SELECT 1 FROM pim_app.artifacts a WHERE a.owner_id = artifact_versions.owner_id AND a.id = artifact_versions.artifact_id AND a.label = pim_app.cur_lookup()));

-- Sharing: what is shared with a circle's members is readable by them, and only read. Circle members see the circle, its shares and the shared apps.
CREATE POLICY member_view ON pim_app.circles FOR SELECT USING (public.pim_current_owner_id() = ANY (members));
CREATE POLICY shared_with_me ON pim_app.shares FOR SELECT USING (audience LIKE 'circle:%' AND EXISTS (SELECT 1 FROM pim_app.circles c WHERE c.owner_id = shares.owner_id AND 'circle:' || c.id = shares.audience));
CREATE POLICY shared_view ON pim_app.artifacts FOR SELECT USING (access = 'shared' AND EXISTS (SELECT 1 FROM pim_app.circles c WHERE c.owner_id = artifacts.owner_id AND c.id = ANY (artifacts.circles)));
CREATE POLICY shared_view ON pim_app.artifact_versions FOR SELECT USING (EXISTS (SELECT 1 FROM pim_app.artifacts a WHERE a.owner_id = artifact_versions.owner_id AND a.id = artifact_versions.artifact_id AND a.access = 'shared' AND a.latest_version = artifact_versions.version AND EXISTS (SELECT 1 FROM pim_app.circles c WHERE c.owner_id = a.owner_id AND c.id = ANY (a.circles))));
-- Published artifacts are listed for anyone, by design.
CREATE POLICY listed ON pim_app.published_artifacts FOR SELECT USING (unpublished_at IS NULL);
-- A shared chat link is found by its link before its owner is known.
CREATE POLICY by_link ON pim_app.shares FOR SELECT USING (link = pim_app.cur_lookup());
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;
