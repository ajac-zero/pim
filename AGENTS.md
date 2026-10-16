# Working on Pim

Pim is one Cloudflare Worker (`src/`) that serves the API, passkey sign-in and the web app (`web/`, React). Each person's agent is a Durable Object (`src/pim.ts`) running on pi-durable. The README explains the product and its vocabulary. Use the same words: Pim is the platform and a person's space; an agent is what people chat with; a blueprint is what an extension defines; a template is an agent shared through the gallery.

## Checks

Run them one at a time. An orb has 2 CPUs and 3 GB of memory, and parallel runs next to the preview and a browser have run out of memory.

```sh
pnpm exec vitest run test/goals.test.ts   # one file of Worker tests, while iterating
pnpm --filter pim-web test                # the web app's tests (seconds)
pnpm typecheck                            # about 30 s
pnpm lint                                 # Biome, for web/; `pnpm --filter pim-web format` fixes formatting
pnpm test                                 # every test, about 3 min
pnpm check                                # typecheck, lint and test, as CI does
```

Worker tests run in workerd against `test/worker.ts`: the real Worker, with pi-ai's faux model in place of Workers AI. Tests script the model with `faux.setResponses(...)`, and every scripted response must be used. Helpers are in `test/helpers.ts`. Extend an existing test file before adding one. `pnpm test:live` reaches real third-party servers and is opt-in.

After editing `wrangler.jsonc`, run `pnpm types` to regenerate `worker-configuration.d.ts`.

## Running Pim

Use the preview. `amp orb services ensure` starts it (`.amp/services.yaml`) at `http://localhost:8787` and prints a portal link that signs the viewer in. It is `wrangler.preview.jsonc` with `preview/worker.ts`: the real Worker with a stand-in model, open registration, and no Cloudflare account. It rebuilds the web app when `web/src` changes and reloads the Worker when its code does; check `amp orb service logs preview` after an edit. State persists in `.wrangler/state-preview`; delete that directory for a fresh Pim.

- **Signing in:** open `/__dev/sign-in/<username>?returnTo=/path` in the browser. It makes the account if it's new (the first one is the admin) and sets the session cookie. For the API, `curl -c jar http://localhost:8787/__dev/sign-in/ada`, then make a token: `curl -b jar -X POST -H 'origin: http://localhost:8787' -H 'content-type: application/json' -d '{"name":"cli"}' http://localhost:8787/auth/tokens`, and send it as `Authorization: Bearer <token>`.
- **The stand-in model** echoes each message through `send_to_user`. `/tool <name> {json}` makes it call that tool, and it then sends the tool's result. For example, `/tool http_request {"method": "GET", "url": "https://example.com"}` files an approval, and `/tool create_goal {"title": "Run a 5k", "steps": ["Run 2k"]}` makes a goal. Use it to reach approvals, artifacts, goals and widgets in the UI; behavior that depends on what a real model says belongs in tests with the faux model.
- **Passkey screens:** to test the real WebAuthn flow, start Chrome with `--remote-debugging-port=9222`, run `node scripts/virtual-authenticator.mjs 9222` beside it, and drive that Chrome with `agent-browser --cdp 9222`.

For UI changes, follow `web/DESIGN.md`. Sign in with `agent-browser` through the portal link or `http://localhost:8787/__dev/sign-in/ada`, set the viewport to 2x (`agent-browser set viewport 1280 800 2`), and inspect screenshots of every state you changed. `.agents/setup` installs Inter so screenshots look right.

Never run `pnpm dev` or `pnpm deploy` here: `wrangler dev` uses the remote Workers AI binding, which needs a Cloudflare login and bills that account. Never deploy `wrangler.preview.jsonc`. `wrangler.prod.jsonc` and `docs/deployments/` are private and not in the repository.

## Code and docs

- Worker code in `src/` uses tabs; `web/` uses 2 spaces and Biome. Follow each file's style.
- Comments and docs are plain prose about what something is for, in full sentences, as in `src/pim.ts` and `docs/`. Update the README or `docs/` when behavior they describe changes.
- A tool with effects outside the conversation is a gated action (`src/extensions/approvals.ts`), so it runs only after approval. New blueprints and widgets are extensions listed in `pim.config.ts` (`docs/extensions.md`).
- Commit messages are one short sentence in the imperative about what changes for people, such as "Let agents rename themselves and other agents through chat".
