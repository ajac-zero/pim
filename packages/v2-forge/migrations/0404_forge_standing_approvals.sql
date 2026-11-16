-- Standing approvals (@pim/v2-contracts StandingApproval): an auditable record that a kind of gated action may go ahead without asking again.
create table pim_forge.forge_standing_approvals (
	approval_id text primary key,
	owner_id text not null,
	action text not null,
	-- Every key must match the action's resource, such as {"repository": "github.com/acme/app"}.
	scope jsonb not null default '{}',
	granted_by text not null,
	granted_at timestamptz not null default now(),
	expires_at timestamptz,
	revoked_at timestamptz
);
create index forge_standing_owner on pim_forge.forge_standing_approvals (owner_id, action) where revoked_at is null;
