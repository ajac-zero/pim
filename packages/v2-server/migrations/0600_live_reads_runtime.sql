-- What Live may read of the runtime. Live projects what the runtime committed, so its role reads the commit facts
-- (receipts and outbox) and the canonical records a commit changed (entries, documents). It writes none of them. Every
-- table keeps its row-level security: Live reads as one owner at a time (pim.owner_id), so another owner's rows are
-- invisible to it even by a query that asks.
GRANT SELECT ON
	pim_runtime.commit_receipts,
	pim_runtime.runtime_outbox,
	pim_runtime.entries,
	pim_runtime.documents,
	pim_runtime.document_revisions
TO pim_live;

-- Finding which partitions have commits needs no owner: it is a list of ids and the newest commit's number, never a
-- record. `partitions` admits a transaction that sets pim.scope to 'all', which this function does for its own
-- statement only, and clears before it returns, so a caller's later queries in the same transaction see one owner.
CREATE FUNCTION pim_runtime.live_partitions() RETURNS TABLE (owner_id text, partition_id uuid, last_seq bigint)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
	PERFORM set_config('pim.scope', 'all', true);
	RETURN QUERY SELECT p.owner_id, p.partition_id, p.next_seq - 1 FROM pim_runtime.partitions p WHERE p.next_seq > 1 ORDER BY p.owner_id, p.partition_id;
	PERFORM set_config('pim.scope', '', true);
END $$;
REVOKE ALL ON FUNCTION pim_runtime.live_partitions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pim_runtime.live_partitions() TO pim_live;
