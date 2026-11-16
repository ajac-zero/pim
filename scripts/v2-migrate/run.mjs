#!/usr/bin/env node
// Entry for the legacy-to-v2 migration CLI: `node scripts/v2-migrate/run.mjs export|import|rehearse ...` (see docs/v2-operations.md).
import "../../packages/v2-ops/src/cli/migrate.ts";
