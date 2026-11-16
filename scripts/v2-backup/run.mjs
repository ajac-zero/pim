#!/usr/bin/env node
// Physical backup, point-in-time restore and the post-restore safety pass: `node scripts/v2-backup/run.mjs backup|restore|post-restore ...` (docs/v2-operations.md, Backup and restore).
import "../../packages/v2-ops/src/cli/backup.ts";
