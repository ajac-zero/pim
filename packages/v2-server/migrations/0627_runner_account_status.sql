-- Whether an account may still have its agents run, for the Runner to ask before each model request: an agent whose owner was suspended or deleted stops at its next
-- request, whatever turn it was in. NULL when the account is live, else why not, in words the run ends with.
CREATE FUNCTION pim_app.runner_account_refusal(p_owner text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pim_app, pg_temp AS $$
	SELECT CASE status
		WHEN 'active' THEN NULL
		WHEN 'suspended' THEN 'This account is suspended, so its agents have stopped. Ask the person who runs this Pim.'
		WHEN 'pending' THEN 'This account is not set up yet: make a passkey first.'
		ELSE 'This account is being deleted.'
	END FROM pim_app.accounts WHERE owner_id = p_owner
$$;
REVOKE ALL ON FUNCTION pim_app.runner_account_refusal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_app.runner_account_refusal(text) TO pim_runtime;
