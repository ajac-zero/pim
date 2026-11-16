#!/usr/bin/env node
// After `run.mjs import` has landed and audited a legacy snapshot: `node scripts/v2-migrate/promote.mjs` writes it into the live schemas (accounts, passkeys, chats and their
// pi history, a projection baseline, coding threads). Needs PIM_DATABASE_URL (the schema owner), PIM_RP_ID, PIM_CUTOVER_AT and optionally PIM_DEFAULT_MODEL (provider/model).
// Run it with the server package's loader: `node --import tsx scripts/v2-migrate/promote.mjs` from packages/v2-server, or `pnpm --filter @pim/v2-server start promote`.
import { main } from "../../packages/v2-server/src/main.ts";

await main(["promote"]);
