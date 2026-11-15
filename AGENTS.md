# Working on Pim

Pim is one Cloudflare Worker (`src/`) that serves the API, passkey sign-in and the web app (`web/`, React). Each person's space is held by a Durable Object `Pim` (`src/pim.ts`) running on pi-durable; what it does for a space is in the collaborators of `src/space/`, which `Pim` hosts and which never import it. The README pitches the product; `docs/reference.md` explains how it works and its vocabulary. Use the same words: Pim is the platform; a space is one person's own part of it; an agent is what people chat with; a template is an agent shared through the gallery; an app is what an agent builds that people use, with every version kept; a connector is a service an agent works with, such as Gmail. The canvas is the pane beside a chat where files and apps open as tabs; a file's tab is a code editor (`docs/code-editor.md`).

## Packages

`packages/*` are internal pnpm workspace packages (`private`, source-first: their `exports` point at `.ts`, so Vite, Wrangler's esbuild and Vitest read them with no build step). One Worker and one `Pim` Durable Object per space remain; the packages are how its parts are kept apart.

- `@pim/shared` (`packages/shared`): what the Worker, the web app and the other packages share and that needs no Cloudflare runtime: locales, themes and Pim's own theme data, transcript projection, base64url, HTTP routing, credential redaction, the coding harnesses' disclosures, Standard Webhooks signing.
- `@pim/ui-lang`: the `ui` block language, with its own unit, limits and fuzz tests.
- `@pim/triggers`: the triggers engine, store, spec, conditions, time scheduler, API contract and connector ingress. Pim's gated action and tools over it stay in `src/triggers/`.
- `@pim/coding`: the coding subsystem that needs no Worker: workspaces, harnesses, orbs, the git broker, the vault, tools, pools and the scheduler's queue. The Durable Objects (`CodingThreadDO`, `CodingSchedulerDO`) and the code that reaches bindings (`src/coding/`, including `vault/worker.ts` and `git-broker/worker.ts`) stay in `src/`. Its `test/support/` holds fixtures and fakes the Worker's tests import too.

A package imports only `@pim/shared` (besides npm packages), never `src/` or `web/`, and no `cloudflare:` module; each package's boundary test checks it. `web/` imports only `@pim/shared` and `@pim/ui-lang`. Import a package by its subpath, such as `@pim/coding/workspace/types`.

## Checks

Run them one at a time. An orb has 2 CPUs and 3 GB of memory, and parallel runs next to the preview and a browser have run out of memory; `pnpm test` is the exception, running its three stages side by side — use `pnpm test:serial` where even that doesn't fit.

```sh
pnpm exec vitest run test/goals.test.ts   # one file of Worker tests, while iterating
pnpm --filter pim-web test                # the web app's tests (seconds)
pnpm --filter @pim/ui-lang test           # a package's own tests, in seconds: also @pim/shared, @pim/triggers, @pim/coding
pnpm test:packages                        # every package's tests
pnpm typecheck                            # the root, each package and the web app
pnpm lint                                 # Biome, for web/; `pnpm --filter pim-web format` fixes formatting
pnpm test                                 # every test, its three stages at once
pnpm check                                # typecheck, lint and test, as CI does
```

Worker tests run in workerd against `test/worker.ts`: the real Worker, with pi-ai's faux model in place of Workers AI. Tests script the model with `faux.setResponses(...)`, and every scripted response must be used. Vitest has three projects (`vitest.config.ts`): `worker` (workerd, no Chrome), `browser` (only `test/browser.test.ts`, which drives a local Chrome in place of Browser Run through the `BROWSER` binding; `node scripts/install-test-browser.mjs` puts it where wrangler looks, which `.agents/setup` and CI's `browser` job run), and `node` (`test/*.node.test.ts`: what needs no workerd and no package, such as what starts real processes; a package's own pure tests are in `packages/*/test/`). A test that touches neither `cloudflare:test`, `cloudflare:workers` nor `./worker` is a `*.node.test.ts`; `pairTestComputer({ browser: true })` is for the browser project alone. The standalone daemons (`displayd/`, `sandbox-manager/`, `workspace-agentd/`) use `node --test`: `pnpm test:daemons`. Every test's `afterEach` in `test/helpers.ts` and `test/people-support.ts` puts the test Worker's shared state back (`resetTestWorkerState` in `test/worker.ts`), so add a new such global there. Helpers are in `test/helpers.ts`. Extend an existing test file before adding one. `pnpm test:live` reaches real third-party servers and is opt-in.

After editing `wrangler.jsonc`, run `pnpm types` to regenerate `worker-configuration.d.ts`.

## Testing

Cut the wall-clock you spend waiting for tests. While iterating, run the one file that covers your change, or `pnpm test:changed`, plus any other file that covers it; never run tests in the background and poll for them with sleep. The full suite runs in GitHub CI on the pushed branch (`.github/workflows/ci.yml`), and CI is the authority for whether it passes: don't run it locally just to check a fix. After fixing one failing file, rerun only that file, and the files that cover a change to shared code.

```sh
pnpm exec vitest run test/goals.test.ts   # one file, while iterating
pnpm test:changed                         # what a diff since origin/main reaches
# the full suite: GitHub CI, on the pushed branch
```

`pnpm test:changed` (`scripts/test-changed.mjs`) diffs against origin/main, or HEAD~1 without it, and runs the whole suite when `package.json`, `pnpm-lock.yaml` or any vitest, wrangler or tsconfig config changed, or when nothing maps to a test; otherwise it runs vitest's own `--changed` over the root project, the web app's tests too when `web/`, `@pim/shared` or `@pim/ui-lang` changed, each changed package's own tests (all of them for `@pim/shared`), and the daemons' tests when one of them changed. CI's `scope` job (`scripts/ci-scope.mjs`) likewise skips jobs a branch's files can't reach (docs only run the identifier check; a change that is only a package's own `test/` files runs just its types and the `unit` job, while a package's source also runs the Worker's shards, since the Worker bundles it); pushes to `main` run everything.

## Running Pim

Use the preview. `amp orb services ensure` starts it (`.amp/services.yaml`) at `http://localhost:8787` and prints a portal link that signs the viewer in. It is `wrangler.preview.jsonc` with `preview/worker.ts`: the real Worker with a stand-in model, open registration, and no Cloudflare account. It rebuilds the web app when `web/src` changes and reloads the Worker when its code does; check `amp orb service logs preview` after an edit. State persists in `.wrangler/state-preview`; delete that directory for a fresh Pim.

- **Signing in:** open `/__dev/sign-in/<username>?returnTo=/path` in the browser. It makes the account if it's new (the first one is the admin) and sets the session cookie; add `&bot=<id>` to make a new account a guest of that shared bot. For the API, `curl -c jar http://localhost:8787/__dev/sign-in/ada`, then make a token: `curl -b jar -X POST -H 'origin: http://localhost:8787' -H 'content-type: application/json' -d '{"name":"cli"}' http://localhost:8787/auth/tokens`, and send it as `Authorization: Bearer <token>`.
- **The stand-in model** echoes each message through `send_to_user`. `/tool <name> {json}` makes it call that tool, and it then sends the tool's result. For example, `/tool http_request {"method": "GET", "url": "https://example.com"}` files an approval, and `/tool create_goal {"title": "Run a 5k", "steps": ["Run 2k"]}` makes a goal; several `/tool` lines in one message call one tool after another. Use it to reach approvals, apps, goals and widgets in the UI; behavior that depends on what a real model says belongs in tests with the faux model.
- **Traces:** to see what the preview's agents did, put `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in `.dev.vars` (and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` for messages), run an OTLP backend there, such as Jaeger, and restart the preview. See Traces in `docs/reference.md`.
- **Passkey screens:** to test the real WebAuthn flow, start Chrome with `--remote-debugging-port=9222`, run `node scripts/virtual-authenticator.mjs 9222` beside it, and drive that Chrome with `agent-browser --cdp 9222`.

For UI changes, follow `web/DESIGN.md`. Sign in with `agent-browser` through the portal link or `http://localhost:8787/__dev/sign-in/ada`, set the viewport to 2x (`agent-browser set viewport 1280 800 2`), and inspect screenshots of every state you changed. `.agents/setup` installs Inter so screenshots look right.

Never run `pnpm dev` or `pnpm deploy` here: `wrangler dev` uses the remote Workers AI binding, which needs a Cloudflare login and bills that account. Never deploy `wrangler.preview.jsonc`. `docs/deployments/` is private and not in the repository. A deployment's own settings aren't in `wrangler.jsonc`: they are variables set in the Cloudflare dashboard, with defaults in `src/deployment.ts`. Tests set theirs in `vitest.config.ts`, and the preview in `wrangler.preview.jsonc`.

## Code and docs

- Worker code in `src/` uses tabs; `web/` uses 2 spaces and Biome. Follow each file's style.
- In code the older names remain: an app is still an artifact (`src/artifacts.ts`, `pim_artifact_*`, `/api/artifacts`) and a connector is still an app (`DirectoryApp`, `src/extensions/app-directory.ts`, `/api/app-directory`). Renaming the code and the API is a later change.
- Comments and docs are plain prose about what something is for, in full sentences, as in `src/pim.ts` and `docs/`. Update the README or `docs/` when behavior they describe changes.
- A tool with effects outside the conversation is a gated action (`src/extensions/approvals.ts`), so it runs only after approval. New apps, abilities and widgets are extensions listed in `pim.config.ts` (`docs/extensions.md`).
- Commit messages are one short sentence in the imperative about what changes for people, such as "Let agents rename themselves and other agents through chat".
