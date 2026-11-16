-- Grants on the operations-owned schema to the roles 0001_foundation.sql creates (pim_gate, pim_runtime, pim_live, pim_forge, pim_maintenance). The deployment
-- grants each role to the login a process connects as. Nothing is granted to PUBLIC, and nothing reads secret_envelopes but the roles that open secrets.
GRANT USAGE ON SCHEMA pim_ops TO pim_gate, pim_runtime, pim_live, pim_forge, pim_maintenance;

-- Maintenance runs the cutover, the import and the restore pass: everything, including the cutover record and the restore fence.
GRANT ALL ON ALL TABLES IN SCHEMA pim_ops TO pim_maintenance;
ALTER DEFAULT PRIVILEGES IN SCHEMA pim_ops GRANT ALL ON TABLES TO pim_maintenance;

-- The Gate reads identity, authentication and chat listings, and opens secrets.
GRANT SELECT ON pim_ops.owner_map, pim_ops.tenants, pim_ops.identities, pim_ops.passkeys, pim_ops.api_tokens, pim_ops.recovery_codes, pim_ops.chats, pim_ops.objects, pim_ops.conversation_directory, pim_ops.secret_envelopes TO pim_gate;

-- The Runner owns pi history, partitions, the external-operation ledger, due work and remote threads, and checks the restore fence.
GRANT SELECT, INSERT, UPDATE, DELETE ON pim_ops.partitions, pim_ops.owner_id_sequence, pim_ops.conversation_directory, pim_ops.pi_conversations, pim_ops.pi_entries, pim_ops.pi_tasks, pim_ops.pi_submissions, pim_ops.pi_documents, pim_ops.pi_document_revisions, pim_ops.chats, pim_ops.external_operations, pim_ops.due_work, pim_ops.remote_threads TO pim_runtime;
GRANT SELECT ON pim_ops.secret_envelopes TO pim_runtime;

-- Live reads what it projects and replays.
GRANT SELECT ON pim_ops.pi_entries, pim_ops.chats, pim_ops.partitions, pim_ops.conversation_directory TO pim_live;
