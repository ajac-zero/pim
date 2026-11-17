-- A deleted account's rows are erased by maintenance (sweepErasures), and the runtime's conversation -> partition map is immutable otherwise
-- (0100). Rows go only for an owner whose account is deleting or deleted; the check reads the account as the function's owner, since the caller
-- is a service role that cannot see accounts.
CREATE OR REPLACE FUNCTION pim_runtime.guard_conversation_partitions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pim_runtime, pim_app, pg_temp AS $$
BEGIN
	IF tg_op = 'INSERT' THEN
		IF new.conversation_id = 1 AND NOT EXISTS (
			SELECT 1 FROM pim_runtime.partitions p WHERE p.owner_id = new.owner_id AND p.partition_id = new.partition_id AND p.kind = 'home'
		) THEN
			RAISE EXCEPTION 'conversation 1 belongs to the home partition' USING errcode = '23514';
		END IF;
		RETURN new;
	END IF;
	IF tg_op = 'UPDATE' AND (new.conversation_id <> old.conversation_id OR new.partition_id <> old.partition_id OR new.owner_id <> old.owner_id) THEN
		RAISE EXCEPTION 'conversation_partitions rows are immutable' USING errcode = '23514';
	END IF;
	IF tg_op = 'DELETE' THEN
		IF EXISTS (SELECT 1 FROM pim_app.accounts a WHERE a.owner_id = old.owner_id AND a.status IN ('deleting', 'deleted')) THEN
			RETURN old;
		END IF;
		RAISE EXCEPTION 'conversation_partitions rows are immutable' USING errcode = '23514';
	END IF;
	RETURN new;
END $$;
