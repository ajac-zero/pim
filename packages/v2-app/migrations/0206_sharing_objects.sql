-- Sharing, publishing, objects, Canvas notes and Relay pairings.
CREATE TABLE pim_app.circles (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	name text NOT NULL,
	members text[] NOT NULL DEFAULT '{}',
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.circles');

CREATE TABLE pim_app.shares (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	kind text NOT NULL CHECK (kind IN ('agent', 'app', 'chat', 'note')),
	resource_id text NOT NULL,
	audience text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.shares');

CREATE TABLE pim_app.bots (
	id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	name text NOT NULL,
	agent_id text,
	created_at timestamptz NOT NULL DEFAULT now()
);
SELECT pim_app.seal_lookup('pim_app.bots', 'id');

CREATE TABLE pim_app.templates (
	id text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	agent_id text NOT NULL,
	title text NOT NULL,
	bundle jsonb NOT NULL DEFAULT '{}',
	published_at timestamptz NOT NULL DEFAULT now()
);
SELECT pim_app.seal_lookup('pim_app.templates', 'id');

CREATE TABLE pim_app.visits (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	visitor text NOT NULL,
	bot_id text,
	public_chat_id uuid,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.visits');

-- Apps (still "artifacts" in code) keep every version; a published artifact is served at /p/pa_... by anyone holding the id,
-- even after its author is suspended or deleted unless the instance's hide policy says otherwise (it reads the author's status).
CREATE TABLE pim_app.artifacts (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	title text NOT NULL,
	access text NOT NULL DEFAULT 'private' CHECK (access IN ('private', 'shared', 'public')),
	latest_version integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.artifacts');
CREATE TABLE pim_app.artifact_versions (
	artifact_id text NOT NULL,
	owner_id text NOT NULL,
	version integer NOT NULL,
	manifest jsonb NOT NULL DEFAULT '{}',
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, artifact_id, version),
	FOREIGN KEY (owner_id, artifact_id) REFERENCES pim_app.artifacts (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.artifact_versions');
CREATE TABLE pim_app.published_artifacts (
	public_id text PRIMARY KEY CHECK (public_id ~ '^pa_'),
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	artifact_id text NOT NULL,
	version integer NOT NULL,
	published_at timestamptz NOT NULL DEFAULT now(),
	unpublished_at timestamptz
);
SELECT pim_app.seal_lookup('pim_app.published_artifacts', 'public_id');

-- Object metadata and access control; the bytes live in S3-compatible storage under the same key.
CREATE TABLE pim_app.objects (
	key text PRIMARY KEY,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	purpose text NOT NULL CHECK (purpose IN ('image', 'media', 'artifact_file', 'note_snapshot', 'file')),
	content_type text NOT NULL,
	size bigint NOT NULL,
	sha256 text NOT NULL,
	acl text NOT NULL DEFAULT 'private' CHECK (acl IN ('private', 'public')),
	created_at timestamptz NOT NULL DEFAULT now(),
	deleted_at timestamptz
);
SELECT pim_app.seal_lookup('pim_app.objects', 'key');

-- Canvas: Yjs notes with an update log and S3 snapshots. A document lease carries a fence that rises on every takeover,
-- so a writer that lost the lease cannot append.
CREATE TABLE pim_app.notes (
	note_id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	title text NOT NULL DEFAULT '',
	version bigint NOT NULL DEFAULT 0,
	snapshot_key text,
	snapshot_seq bigint NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	deleted_at timestamptz,
	PRIMARY KEY (owner_id, note_id)
);
SELECT pim_app.seal_tenant('pim_app.notes');
CREATE TABLE pim_app.note_updates (
	owner_id text NOT NULL,
	note_id text NOT NULL,
	seq bigint NOT NULL,
	data bytea NOT NULL,
	origin text NOT NULL,
	fence bigint NOT NULL,
	at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (owner_id, note_id, seq),
	FOREIGN KEY (owner_id, note_id) REFERENCES pim_app.notes (owner_id, note_id)
);
SELECT pim_app.seal_tenant('pim_app.note_updates');
CREATE TABLE pim_app.note_leases (
	owner_id text NOT NULL,
	note_id text NOT NULL,
	holder text NOT NULL,
	fence bigint NOT NULL,
	expires_at timestamptz NOT NULL,
	PRIMARY KEY (owner_id, note_id),
	FOREIGN KEY (owner_id, note_id) REFERENCES pim_app.notes (owner_id, note_id)
);
SELECT pim_app.seal_tenant('pim_app.note_leases');

-- Relay: a person's computer pairs with a pimc_ token; protocol 1 and 2 clients both pair.
CREATE TABLE pim_app.computers (
	id text NOT NULL,
	owner_id text NOT NULL REFERENCES pim_app.accounts (owner_id),
	name text NOT NULL,
	protocol integer NOT NULL CHECK (protocol IN (1, 2)),
	consumer_id text,
	last_seen_at timestamptz,
	revoked_at timestamptz,
	PRIMARY KEY (owner_id, id)
);
SELECT pim_app.seal_tenant('pim_app.computers');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pim_app TO pim_gate;

-- Templates are shared through the gallery on purpose, so any signed-in space lists them.
CREATE POLICY gallery ON pim_app.templates FOR SELECT USING (true);
