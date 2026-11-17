-- The computer host (`pim-host`): a machine of the operator's that keeps a computer for every person. These are instance-level rows, like instance_settings: the
-- host is the admin's, and its requests are for every account, so only the Gate (pim_gate) reads and writes them, with no tenant scope. A person's own row of
-- `computers` says which machine holds theirs.
ALTER TABLE pim_app.computers ADD COLUMN machine text;

-- At most one host. Its `pimh_` bearer is a `token_consumers` row (kind host) of the admin who paired it; only that consumer's token may sync.
CREATE TABLE pim_app.computer_hosts (
	id text PRIMARY KEY CHECK (id = 'host'),
	admin_owner_id text NOT NULL,
	consumer_id text NOT NULL,
	paired_at timestamptz NOT NULL DEFAULT now(),
	seen_at timestamptz,
	image text,
	kind text,
	version text,
	machines integer,
	running integer
);

-- One request per person: to make their computer or remove it. The `pimc_` token a new computer connects with is made when the host takes the request and
-- travels only in the answer to that sync, so nothing here holds a computer's token. A request the host took and never reported is given again after 20 minutes;
-- one it reported failed stays with its error (not retaken) until the person asks again.
CREATE TABLE pim_app.computer_requests (
	owner_id text PRIMARY KEY,
	id text NOT NULL UNIQUE,
	op text NOT NULL CHECK (op IN ('create', 'delete')),
	name text NOT NULL,
	requested_at timestamptz NOT NULL DEFAULT now(),
	taken_at timestamptz,
	failed_at timestamptz,
	error text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON pim_app.computer_hosts, pim_app.computer_requests TO pim_gate;
