-- Sign in with ChatGPT for images (the way Codex makes them): one sealed OAuth credential per owner, apart from the plan's sign-in of 0610 because it is another client of
-- OpenAI's with its own refresh token. `secret` is the credential sealed with the deployment's key ring, bound to its owner; `pending` is an unfinished sign-in (its PKCE
-- verifier), sealed the same way. The Gate reads and writes the table as the owner; a Runner uses the definer functions below, which name one owner each, and refreshes
-- under the row's lock so a rotated refresh token is never spent twice.

CREATE TABLE pim_app.chatgpt_image_credentials (
	owner_id text PRIMARY KEY REFERENCES pim_app.accounts (owner_id),
	secret text,
	email text,
	pending text,
	version integer NOT NULL DEFAULT 0,
	updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT pim_app.seal_tenant('pim_app.chatgpt_image_credentials');
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.chatgpt_image_credentials TO pim_gate;

-- The sealed credential, or null when the owner has none.
CREATE FUNCTION pim_app.runner_chatgpt_images(p_owner text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result text;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT secret INTO result FROM pim_app.chatgpt_image_credentials WHERE owner_id = p_owner;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

-- The same, with the row locked until the caller's transaction ends: a refresh reads, refreshes and writes under it, so two Runners never spend one rotated refresh token twice.
CREATE FUNCTION pim_app.runner_chatgpt_images_lock(p_owner text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	result text;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	SELECT secret INTO result FROM pim_app.chatgpt_image_credentials WHERE owner_id = p_owner FOR UPDATE;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN result;
END $$;

-- Writes a refreshed credential; nothing is written (false) when the owner disconnected meanwhile, so a refresh never brings a signed-out account back.
CREATE FUNCTION pim_app.runner_chatgpt_images_put(p_owner text, p_secret text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
DECLARE
	previous text := coalesce(current_setting('pim.owner_id', true), '');
	changed integer;
BEGIN
	PERFORM set_config('pim.owner_id', p_owner, true);
	UPDATE pim_app.chatgpt_image_credentials SET secret = p_secret, version = version + 1, updated_at = now() WHERE owner_id = p_owner AND secret IS NOT NULL;
	GET DIAGNOSTICS changed = ROW_COUNT;
	PERFORM set_config('pim.owner_id', previous, true);
	RETURN changed > 0;
END $$;

REVOKE ALL ON FUNCTION pim_app.runner_chatgpt_images(text), pim_app.runner_chatgpt_images_lock(text), pim_app.runner_chatgpt_images_put(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_chatgpt_images(text), pim_app.runner_chatgpt_images_lock(text), pim_app.runner_chatgpt_images_put(text, text) TO pim_runtime;
