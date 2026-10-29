# The ordinary smoke test of an evaluation's Cua computer (plan; not run)

This is the plan for one manual run of an evaluation's Cua computer through Pim's ordinary tools: `shell`, the file tools and the structured browser, with one approval granted, one denied, and cleanup. **It has not been run, and running it is a separate authorization.** It doesn't depend on native-app calls, which stay off (`docs/cua-native-host-plan.md`).

**What it qualifies:** transport and approvals end to end, meaning Pim's link through the bridge to pim-computer, the approval flow, and the computer's effects on its files and browser. **It is not a qualification of an autonomous model.** The preview's stand-in model calls exactly the tool a message names (`/tool <name> {json}`, `preview/worker.ts` L69–70) and decides nothing.

## Before the run

- **Sign-in:** the evaluation's existing owner signs in to the evaluation's preview with **their existing passkey**, through the web app's own sign-in (`POST /auth/sign-in/options`, then `POST /auth/sign-in`, `src/auth/index.ts`). There is no dev sign-in, no portal sign-in link, no new account, passkey, setup code or enrollment, and no API token.
- **The computer:** the space's computer is the evaluation's Cua computer, and Settings shows it connected.
- **Approvals:** `shell` and `file_delete` ask first. If either is set to run without asking, stop: the approval and denial steps would mean nothing.
- **The chat:** a new chat with Pim. Send each message below alone, in order, and wait for its answer before the next.
- **Paths:** the file tools see the person's files as `/workspace` (`FILES_ROOT`, `src/files.ts`). Commands use the configuration's `workspace`, `/srv/pim-workspace`, written out. Each command first checks that `$PIM_WORKSPACE`, which pim-computer sets to that folder for every command (`computer/pim-computer.ts`), is that path, so nothing depends on the shell's working directory.
- **The two fixed names**, used for this run and no other:
  - `pim-smoke-20261029-shell.txt` is the only file the run makes;
  - `pim-smoke-20261029-denied.txt` must never exist.

**"Not found"** below means the answer contains exactly `File not found: <the path>`, which is `file_read`'s own answer for a missing file (`@cloudflare/computer` 0.5.1). Any other error, a refusal, the computer offline, a timeout, or an answer saying the call may have run is not "not found": it is a stop.

## Steps

1. **Preflight: the run's file is absent.**

   ```text copy Copy Step 1
   /tool file_read {"path": "/workspace/pim-smoke-20261029-shell.txt"}
   ```

   Expect not found.
2. **Preflight: the denied name is absent.**

   ```text copy Copy Step 2
   /tool file_read {"path": "/workspace/pim-smoke-20261029-denied.txt"}
   ```

   Expect not found.
3. **Shell writes the run's file.** It files an approval: approve exactly this one in Approvals.

   ```text copy Copy Step 3
   /tool shell {"command": "set -euo pipefail; set -C; test \"$PIM_WORKSPACE\" = /srv/pim-workspace; printf '%s\\n' pim-smoke-20261029 > /srv/pim-workspace/pim-smoke-20261029-shell.txt; cat /srv/pim-workspace/pim-smoke-20261029-shell.txt", "cwd": "/workspace", "timeout_seconds": 30}
   ```

   The approval's summary reads `Run on your computer: set -euo pipefail; set -C; …`. Expect `Exit code 0` and `stdout:` `pim-smoke-20261029`. `set -C` refuses to overwrite, a second guard behind step 1.
4. **Read it back.** No approval.

   ```text copy Copy Step 4
   /tool file_read {"path": "/workspace/pim-smoke-20261029-shell.txt"}
   ```

   Expect exactly the one line `pim-smoke-20261029`. This is the content check that cleanup depends on.
5. **The structured browser, on a harmless public page.** No approval.

   ```text copy Copy Step 5
   /tool browser_open {"url": "https://example.com/"}
   ```

   Expect `Page: Example Domain`, `URL: https://example.com/` and the page's text (`describePage`, `src/browser.ts`). Then read the same window again:

   ```text copy Copy Step 5b
   /tool browser_read {}
   ```

   Expect the same title and URL. Then close the window:

   ```text copy Copy Step 5c
   /tool browser_close {}
   ```

   Expect `Your window is closed.`
6. **A shell command, denied.** It files an approval: deny exactly this one in Approvals.

   ```text copy Copy Step 6
   /tool shell {"command": "set -euo pipefail; set -C; test \"$PIM_WORKSPACE\" = /srv/pim-workspace; printf '%s\\n' denied > /srv/pim-workspace/pim-smoke-20261029-denied.txt", "cwd": "/workspace", "timeout_seconds": 30}
   ```

   Expect the approval recorded as `denied` in Approvals, and no command output in the chat.
7. **The denied path, read after the denial.**

   ```text copy Copy Step 7
   /tool file_read {"path": "/workspace/pim-smoke-20261029-denied.txt"}
   ```

   Expect not found.
8. **Cleanup: only the run's own file, only after step 4 matched exactly.** It files an approval: approve exactly this one, whose summary reads `Delete /workspace/pim-smoke-20261029-shell.txt`.

   ```text copy Copy Step 8
   /tool file_delete {"path": "/workspace/pim-smoke-20261029-shell.txt"}
   ```

9. **The run's file is gone.**

   ```text copy Copy Step 9
   /tool file_read {"path": "/workspace/pim-smoke-20261029-shell.txt"}
   ```

   Expect not found.

## Stop rules

- **Stop at the first answer that isn't what its step expects.** Record it and the state, and send nothing more in that chat.
- **A collision is a stop.** If step 1 or 2 finds a file, or step 3's `set -C` refuses, stop. Don't rename, add a suffix, or choose another path; deciding what to do with an existing file is the owner's, outside this run.
- **Unknown is a stop and never a retry.** An answer saying a call may have run, a timeout, the computer offline, or a refusal from Pim's control state means the step's effect is unknown. Don't send that message, or any later one, again. Reading the path afterwards to learn the state is a decision for the owner, not part of this run.
- **No cleanup without a verified creation.** If step 4 didn't show exactly `pim-smoke-20261029`, skip step 8: deleting needs the exact file the run made, verified.
- **Approve or deny only the approval each step names**, by its summary. Never use "always allow".
- **Never send another `/tool` message than these**, and never a `/tool` line naming a native-app tool.

## Checked against the source

- **`shell`'s schema** (`src/extensions/files.ts`): `command` (at least 1 character), optional `cwd` under `/workspace`, optional `timeout_seconds` from 1 to 600. Its approval summary is `Run on your computer: <command>`.
- **`file_read`** (`path`, optional `offset`, `byteOffset`, `limit`) and `file_delete` (`path`, optional `recursive`), from `@cloudflare/computer` 0.5.1, under Pim's names. `file_read` answers `File not found: <path>` for a missing file. `file_delete` is a gated action whose summary is `Delete <path>`.
- **`browser_open`** (`url` matching `^(https?://|data:text/html)`), `browser_read` and `browser_close` (no arguments) (`src/extensions/browser.ts`).
- **The approval routes** the app uses: `POST /approvals/:id/approve` and `POST /approvals/:id/deny` (`src/pim.ts`).
- **A scratch check** (not committed) parsed every message above with the preview's own directive pattern and JSON, and found only the schemas' fields.
