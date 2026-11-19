-- Apps with a backend remember where they run on the person's computer: the port Pim gave the backend (the same for as long as the app exists) and the version run last.
ALTER TABLE pim_app.artifacts ADD COLUMN backend_port integer, ADD COLUMN backend_version integer;
CREATE UNIQUE INDEX artifacts_backend_port ON pim_app.artifacts (owner_id, backend_port) WHERE backend_port IS NOT NULL;

-- Drawings and diagrams (SVG and Mermaid apps) are apps of their own kinds, as they were before.
ALTER TABLE pim_app.artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE pim_app.artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN ('html', 'jsx', 'svg', 'mermaid', 'backend'));

-- A published app is in the gallery of everyone signed in; `public` also lets anyone with its link open it. What was published before this was open to anyone with the link, and stays so.
ALTER TABLE pim_app.published_artifacts ADD COLUMN public boolean NOT NULL DEFAULT false;
UPDATE pim_app.published_artifacts SET public = true;

-- A trigger made with a key (an agent's tool call, an API client's Idempotency-Key) is made once: the same key and request give the trigger made the first time.
ALTER TABLE pim_app.triggers ADD COLUMN creation_key text, ADD COLUMN creation_digest text;
CREATE UNIQUE INDEX triggers_creation_key ON pim_app.triggers (owner_id, creation_key) WHERE creation_key IS NOT NULL;

-- Where a computer trigger's source had got to when its last observation was taken (a stream's position, a poll's cursor): a computer that restarts resumes from it instead of from now.
ALTER TABLE pim_app.triggers ADD COLUMN checkpoint jsonb;
