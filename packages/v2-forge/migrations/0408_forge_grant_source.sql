-- The Gate's coding grant a forge grant follows, so that revoking the one revokes the other. Null for a grant made by hand in this table.
alter table pim_forge.forge_grants add column source_grant_id text;
create index forge_grants_source on pim_forge.forge_grants (source_grant_id) where source_grant_id is not null;
