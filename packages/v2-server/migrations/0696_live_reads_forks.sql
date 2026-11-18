-- A fork shows what its parent said up to the entry it forked at, which Live reads along the conversation's fork chain, so its role reads the
-- conversation records too. Live writes none of them, and the table keeps its row-level security.
GRANT SELECT ON pim_runtime.conversations TO pim_live;
