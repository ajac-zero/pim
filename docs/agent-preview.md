# Agent-driven preview: the browser harness and the banner

**Status: under review, not accepted.** This is the browser side of an unsafe, authorized preview in which one agent uses the preview's web app and API without a person operating a passkey. It is for a REVIEW branch. **Nothing here has run**: the harness and its tests use fake Playwright objects, and no browser, socket, process, login or credential has been involved. It implements no authentication: the exchange, the session cookie and its validation belong to the auth branch (`review/preview-automation-auth-20261028`, read at `67e338f6`, itself not accepted; its `docs/preview-automation.md` is the contract). The integration branch (`review/agent-preview-integration-20261028`) merges the two unchanged; there, `test/preview-automation.test.ts` runs this harness's first diagnosis against the real preview Worker in workerd, with fake Playwright objects in place of a browser.

Starting one new observation, watching it and ending it is not this harness's: it stays read only. That is the separate, one-use launch evaluator (`docs/launch-evaluator.md`, `computer/cua-host/launch-evaluator-cli.ts`).

## What an agent gets

Both a browser UI and API requests, from one sign-in. Playwright's `BrowserContext.request` shares the context's cookie jar, so the harness POSTs the credential once through it, the Worker's Secure HttpOnly cookie stays in that context's memory, and the same context reads the API (`context.request.get`) and loads pages (`context.newPage`). The existing browser tool cannot attach to this context; an interactive controller must be a Playwright script that imports `computer/cua-host/agent-preview.ts` and drives the session it returns. Nothing is stored: there is no `storageState` method, no profile, no trace, video or HAR, and a context ends with the session.

```diagram
 operator dir (0700)           Playwright, fresh headless Chromium
 └─ credential (0600) ──read──▶ isolated BrowserContext ── POST once ──▶ preview origin (exact)
                                  │  cookie jar (memory)  ◀── Secure HttpOnly cookie
                                  ├─ request.get /api/observations  (same jar)
                                  └─ page.goto /                    (same jar)
```

## The harness (`computer/cua-host/agent-preview.ts`)

`openAgentPreview({ configFile, parse, deadline, launcher })` returns a session; `diagnoseObservations(session)` is the first command.

- **Configuration file.** One file: an absolute, normalized path, in a directory of this account's with mode `0700`, the file a regular file of this account's with mode `0600` and one link, opened without following links, 1–4096 bytes, whose content the adapter validates. Not an environment variable, argument, URL or chat message. Errors name what is wrong, never the path or content, including filesystem errors.
- **Origin.** Exactly an `https` origin as configured (no path, query or user). The exchange and every request go to it with no redirect followed (a redirect closes the session). The exchange sends `Origin` itself, since Playwright's request context doesn't and the Worker's writes require it.
- **Isolation.** A fresh `chromium.launch` for the run, never `connectOverCDP` or a persistent profile, so none of the human's cookies or passkeys. Downloads, service workers and permissions are off.
- **Browser read-only.** Before any page exists, the context installs `routeWebSocket` for every URL with a handler that closes the socket (1008) and never calls `connectToServer`, so a page cannot open a stateful channel to the server or anywhere else. It also routes every browser request through an allowlist (`pageMayRequest`): GET or HEAD, this origin, no query, and only `/`, `/auth/session` (the banner's feed), the icons and manifest, and single files under `/assets/`. Everything else is aborted before it reaches the server, including all of `/api` (so `/api/observations/<id>` and the page's `/api/themes.css`; the page may look unthemed), other `/auth` routes and `/__dev`. Past 300 allowed requests in the session the rest are aborted. The `/assets/` pattern was checked against a local build of the web app at integration: every file under `/assets/` and every file the built `index.html` names matches it, but `/api/themes.css`. A miss costs rendering, not safety. `context.request` calls are not browser requests: the one `GET /api/observations` is made by it, and bounded separately. Only the root page is loaded (`inspectPage` takes no other path).
- **Lifetime and bounds.** The session ends at the adapter's expiry, which the harness refuses unless it is within 30 minutes and before the evaluation's `deadline`. A timer closes the context and browser then; each call checks it. The session makes at most 50 API reads and page loads (`MAX_REQUESTS`), and its pages at most 300 browser requests. Time is the bound for everything else. The cookie must be Secure, HttpOnly, host-only for the origin, and not outlast the session.
- **One attempt, closed on any error.** A refused or failed exchange, a launcher error, a navigation or network error, a redirect, any status but 200, a body that isn't the expected shape, and a thrown adapter all close the context and browser once and throw a fixed sentence with a code and at most an HTTP status. Nothing is retried. Nothing a launcher, Playwright, a file system call or a server said is repeated.
- **Output.** Metadata only: origin, expiry, requests left, and for each observation what the Worker's list gives: `id`, `status`, `notAfter`, the Worker's `evidence` text (redacted, 300 characters at most) and `lostReason`, the parenthesized reason in "… was lost (timeout|unreachable|status|malformed|redirect)". The Worker omits the host's launch, generation and viewer path, and so does this; it says nothing about whether the host holds anything. The credential and cookie values are scrubbed from everything read. Don't take screenshots or network traces of an authenticated page with request headers or cookies in them.
- **Read only.** One `GET /api/observations` (the list; no query) and a page load of `/`. There is no read of a single observation, because the Worker's `GET /api/observations/<id>` asks the computer and may record the answer in the ledger. There is no Watch, End, setup, enrollment or tool call, and startup makes none. After the exchange no `Authorization` header is sent; the observation routes refuse one.

## The contract and the configuration file

`agent-preview-automation.ts` is the adapter for the auth branch's contract: `POST /auth/automation/session` with `Origin: <origin>`, `Authorization: Pim-Automation <credential>` and the JSON body `{owner, evaluation, deployment}`, answered `201 {mode: "enabled", session: {…, expiresAt: <ISO>}}` with exactly one cookie, `__Host-pim-automation` (Secure, HttpOnly, SameSite=Strict, host-only, `Path=/`). The harness refuses a different cookie set. The adapter accepts the answer only if it says `kind: "automation"`, `access: "read-only"` and this file's owner, evaluation, deployment and origin, and reads the end of the session from `expiresAt`.

The operator's protected input is one JSON file. Read at `67e338f6`, the auth branch's `scripts/preview-automation-grant.mjs <absolute runner file> <origin> <owner> <evaluation> <deployment> <notAfter>` makes exactly this file: a fresh 32-byte credential, written with `wx` (never over anything) and mode `0600`, as one line of JSON; it prints only the grant for `PREVIEW_AUTOMATION_GRANT`, which holds the credential's SHA-256, never the credential. It does not create or check the directory, so the operator makes it first, `install -d -m 700 ~/.config/pim-agent-preview`, and the harness refuses the file unless that directory is the operator's with mode `0700`. That script is in the auth branch, not this one, and is a separate step run by the operator after review (it makes a real secret, so nothing here has run it). The file:

```json
{ "version": 1, "origin": "https://…", "owner": "o_…", "evaluation": "…", "deployment": "cua-eval@cloudflare", "credential": "<43 base64url characters>" }
```

Each field is checked for exactly its format, an extra or missing field is refused, and a refusal says only that the file is invalid. The credential never leaves the adapter except in the exchange's header. It is not logged and is scrubbed from everything the session reads.

The auth branch enforces the same limits from its side: only GET and HEAD, no `/api/observations/<id>`, and every WebSocket handshake refused. The harness's own blocks are a second layer, not a substitute.

## Running the first diagnosis (not yet run against a preview)

There is no build step and no runtime install of project dependencies. The entry point is TypeScript that Node runs by itself: Node strips the types from `.ts` files when it loads them (on by default from Node 22.18; the repository's `.nvmrc` is 26). That works because the three files it loads (`agent-preview-cli.ts`, `agent-preview-automation.ts`, `agent-preview.ts`) use only erasable syntax (no parameter properties, enums or namespaces) and import only Node's own modules and each other; a test strips each of them with `module.stripTypeScriptTypes` to keep it so, and another that no other import appears. Nothing from the Worker, `node_modules` or Cloudflare's modules is loaded. From a clean checkout, in `computer/cua-host`:

```sh
node agent-preview-cli.ts --origin https://pim-cua-eval.ajac-zero.com \
  --config-file ~/.config/pim-agent-preview/automation.json \
  --deadline 2026-10-30T01:20:50Z --playwright-dir ~/.local/share/pim-agent-preview [--browser-channel chrome]
```

(`pnpm run agent-preview -- <the same arguments>` is the same command.) Without arguments it prints the usage and exits 2. I ran the argument-less and missing-config cases under Node 26.12 here (they read no secret and start no browser); Node 22.18 and 24 are not tried.

`--origin` must equal the file's. Nothing secret is an argument. It prints one JSON metadata line, or one fixed failure line to standard error (exit 1; usage exit 2), and does only `diagnoseObservations`: one `GET /api/observations` and one page load of `/`. It starts, ends and sets up nothing.

Playwright is not a dependency of the repository. It is exactly `playwright@1.59.1` (`PLAYWRIGHT_VERSION`; `routeWebSocket` needs 1.48 or later), installed by the operator in a directory of their own, outside the checkout, which the harness loads from and refuses any other version of:

```sh
mkdir -p ~/.local/share/pim-agent-preview && cd ~/.local/share/pim-agent-preview
npm init -y && npm install --save-exact playwright@1.59.1
npx playwright install chromium
```

### System Chrome instead of the bundled Chromium

Playwright 1.59.1 cannot download its Chromium on Ubuntu 26.04. For that case only, add `--browser-channel chrome`. The harness then calls `chromium.launch({ headless: true, channel: "chrome" })`, Playwright's supported channel for the operating system's Google Chrome Stable. Without the option nothing changes: the bundled Chromium, `launch({ headless: true })`, no channel. Only the exact word `chrome` is accepted; any other value, an empty one or a repeated option is refused with the usage (exit 2) before a browser is considered. There is no option for an executable path, a launch argument or another channel, and the sandbox stays on (no `--no-sandbox`). The context is the same fresh `browser.newContext` as always: no user data directory, profile, storage state, CDP attach, extension, download, trace or video, and every origin, route, WebSocket and read-only control is unchanged. The Playwright pin stays 1.59.1.

Chrome is a separate prerequisite, managed by the operating system, not by this repository, and not installed by `npm install playwright`. Before using the option the operator checks, statically and without running Chrome:

- it came from the `google-chrome-stable` package from `dl.google.com` (for example `dpkg -S /opt/google/chrome/chrome` and `apt-cache policy google-chrome-stable`), at the version they intend (the build runner has 156.0.8078.47);
- `/opt/google/chrome/chrome` and `/opt/google/chrome/chrome-sandbox` are owned by root, not writable by group or others, and `chrome-sandbox` is setuid (mode 4755);
- no Playwright browser cache is expected to be used.

If Chrome is missing or Playwright cannot drive this version, the launch fails with the same fixed sentence as any launch failure, which carries no path or Playwright text. Nothing here has launched Chrome: the tests use a fake Playwright module that records its launch options, so whether Playwright 1.59.1 drives Chrome 156 is unqualified until the operator's first real run.

The bundled Chromium download is for the operator to run after review; nothing here has. For more than the first diagnosis, a controller is a Playwright-side script that imports `openAgentPreview` with `parseAutomationConfig` and drives the returned session; the existing agent browser tool cannot attach to this context.

## The banner

While the mode is on, every page shows **UNSAFE PREVIEW — agent access enabled** in a red bar (`web/src/components/agent-preview-banner.tsx`), signed in or not, to a human as much as to the automation session. For an automation session it adds when it ends and, after that, that it expired. It shows no secret. When the mode is absent the app renders exactly as before. The web app reads `agentPreview: { enabled: true, expiresAt: <Unix ms> | null }` on the existing `/auth/session` answer (`AuthSession` in `web/src/lib/auth.ts`), which the auth branch adds in the evaluation while automation is on: `expiresAt` is `null` for a signed-out or passkey browser and a number for `method: "automation"`. It is shown whether or not anyone is signed in, so the human sees it too. This matches the auth branch's page; in the integration branch's test, the banner's own text is computed from what the Worker answers.

## Tests

`pnpm --filter pim-cua-host test` runs `test/agent-preview.test.ts` (with the rest); `pnpm --filter pim-web test` runs the banner's. They prove, with fakes and records shaped like the Worker's real `ObservationView`: one context serves the exchange, an API read and a page; the credential only goes in the POST; isolated context options; origin rules, route aborts, the browser request bound and the WebSocket handler installed first and never connecting; file-permission refusals; fixed, redacted errors and cleanup on each failure path; the lifetime limits and timer close; no retry; the Playwright version check against a fake module; that the default launch is headless with no channel, that exactly `--browser-channel chrome` launches headless with `channel: "chrome"`, and that other values, executable-path or argument options are refused before any browser; and that first use is read only.

## Not done

An interactive controller beyond the first diagnosis; Playwright installed; any run of a real browser, or against a deployed or live preview; the review's acceptance.
