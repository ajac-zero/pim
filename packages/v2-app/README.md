# @pim/v2-app

Pim's portable application backend: Node.js, PostgreSQL (schema `pim_app`) and any S3-compatible object store. No Cloudflare runtime.

- `migrations/0200–0206`: accounts, credentials, sessions and tokens, grants, conversations and the command ledger, the agent domain, sharing, objects, Canvas and Relay. Every tenant table is `FORCE ROW LEVEL SECURITY`, keyed on the transaction-local setting `pim.owner_id`; secret lookups (a token hash, a credential id) set `pim.lookup` for the one row they name. `src/db.ts` is the only way in, and it sets both per transaction, so pooled and PgBouncer-fronted connections never carry a tenant over. The app role must be neither superuser nor `BYPASSRLS`; the migration owner is a different role.
- `Authorizer` (`src/authz.ts`): one decision point for HTTP, WebSockets, MCP and agent tools. A principal passes only if its owner is alive (403 suspended, 410 deleting or deleted), its token scope allows the action, the owner's role and grants allow it, and, for push and merge, a standing grant covers it. A delegated principal carries its originator and must pass for both.
- `EnvelopeCrypto` (`src/crypto.ts`): AES-256-GCM, versioned keys, a key per purpose, rotation, and a reader for what the Cloudflare build sealed.
- `Gate` (`src/gate.ts`): stateless HTTP. A chat command is accepted into `accepted_commands` and `command_inbox` in one short transaction and answered at once; the Runner works the inbox later.
- `Objects`, `Canvas`, `Relay`: S3 objects with ranges, Yjs notes with fenced leases, and the computer registry. A missing computer is a `CapabilityUnavailableError` for the tools that need one and nothing else.

Tests start a real PostgreSQL (`embedded-postgres`) and an S3-protocol server (`s3rver`): `pnpm --filter @pim/v2-app test`.
