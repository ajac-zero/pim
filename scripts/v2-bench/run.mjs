#!/usr/bin/env node
// Multi-tenant load benchmark: `node scripts/v2-bench/run.mjs --profile 5 --profile 50 [--mode single|batched]` (see docs/v2-operations.md, Load qualification).
import "../../packages/v2-ops/src/bench/cli.ts";
