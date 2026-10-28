# Agent-driven preview: the browser harness and the banner

**Status: under review, not accepted.** This is the browser side of an unsafe, authorized preview in which one agent uses the preview's web app and API without a person operating a passkey. It is for a REVIEW branch. **Nothing here has run**: the harness and its tests use fake Playwright objects, and no browser, socket, process, login or credential has been involved. It implements no authentication: the exchange, the session cookie and its validation belong to the auth branch (`review/preview-automation-auth-20261028`, read at `67e338f6`, itself not accepted; its `docs/preview-automation.md` is the contract). This branch holds the adapter for that contract and has not been merged with it or run against it.

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
- **Browser read-only.** Before any page exists, the context installs `routeWebSocket` for every URL with a handler that closes the socket (1008) and never calls `connectToServer`, so a page cannot open a stateful channel to the server or anywhere else. It also routes every browser request: anything to another origin, anything but GET or HEAD, and anything past 300 requests in the session (subresources included) is aborted. `context.request` calls are not browser requests and are bounded separately.
- **Lifetime and bounds.** The session ends at the adapter's expiry, which the harness refuses unless it is within 30 minutes and before the evaluation's `deadline`. A timer closes the context and browser then; each call checks it. The session makes at most 50 API reads and page loads (`MAX_REQUESTS`), and its pages at most 300 browser requests. Time is the bound for everything else. The cookie must be Secure, HttpOnly, host-only for the origin, and not outlast the session.
- **One attempt, closed on any error.** A refused or failed exchange, a launcher error, a navigation or network error, a redirect, any status but 200, a body that isn't the expected shape, and a thrown adapter all close the context and browser once and throw a fixed sentence with a code and at most an HTTP status. Nothing is retried. Nothing a launcher, Playwright, a file system call or a server said is repeated.
- **Output.** Metadata only: origin, expiry, requests left, and for each observation what the Worker's list gives: `id`, `status`, `notAfter`, the Worker's `evidence` text (redacted, 300 characters at most) and `lostReason`, the parenthesized reason in "… was lost (timeout|unreachable|status|malformed|redirect)". The Worker omits the host's launch, generation and viewer path, and so does this; it says nothing about whether the host holds anything. The credential and cookie values are scrubbed from everything read. Don't take screenshots or network traces of an authenticated page with request headers or cookies in them.
- **Read only.** One `GET /api/observations` (the list; no query) and a page load of `/`. There is no read of a single observation, because the Worker's `GET /api/observations/<id>` asks the computer and may record the answer in the ledger. There is no Watch, End, setup, enrollment or tool call, and startup makes none. After the exchange no `Authorization` header is sent; the observation routes refuse one.

## The contract and the configuration file

`agent-preview-automation.ts` is the adapter for the auth branch's contract: `POST /auth/automation/session` with `Origin: <origin>`, `Authorization: Pim-Automation <credential>` and the JSON body `{owner, evaluation, deployment}`, answered `201 {mode: "enabled", session: {…, expiresAt: <ISO>}}` with exactly one cookie, `__Host-pim-automation` (Secure, HttpOnly, SameSite=Strict, host-only, `Path=/`). The harness refuses a different cookie set. The adapter accepts the answer only if it says `kind: "automation"`, `access: "read-only"` and this file's owner, evaluation, deployment and origin, and reads the end of the session from `expiresAt`.

The operator's protected input is one JSON file, written by the auth branch's `scripts/preview-automation-grant.mjs` (mode `0600`, in a `0700` directory of the operator's, such as `~/.config/pim-agent-preview/`):

```json
{ "version": 1, "origin": "https://…", "owner": "o_…", "evaluation": "…", "deployment": "cua-eval@cloudflare", "credential": "<43 base64url characters>" }
```

Each field is checked for exactly its format, an extra or missing field is refused, and a refusal says only that the file is invalid. The credential never leaves the adapter except in the exchange's header. It is not logged and is scrubbed from everything the session reads.

The auth branch enforces the same limits from its side: only GET and HEAD, no `/api/observations/<id>`, and every WebSocket handshake refused. The harness's own blocks are a second layer, not a substitute.

## Running the first diagnosis (not yet run)

```sh
node computer/cua-host/agent-preview-cli.ts --origin https://pim-cua-eval.ajac-zero.com \
  --config-file ~/.config/pim-agent-preview/automation.json \
  --deadline 2026-10-30T01:20:50Z --playwright-dir ~/.local/share/pim-agent-preview
```

`--origin` must equal the file's. Nothing secret is an argument. It prints one JSON metadata line, or one fixed failure line to standard error (exit 1; usage exit 2), and does only `diagnoseObservations`: one `GET /api/observations` and one page load of `/`. It starts, ends and sets up nothing. Node 22.18 or later.

Playwright is not a dependency of the repository. It is exactly `playwright@1.59.1` (`PLAYWRIGHT_VERSION`; `routeWebSocket` needs 1.48 or later), installed by the operator in a directory of their own, outside the checkout, which the harness loads from and refuses any other version of:

```sh
mkdir -p ~/.local/share/pim-agent-preview && cd ~/.local/share/pim-agent-preview
npm init -y && npm install --save-exact playwright@1.59.1
npx playwright install chromium
```

This downloads Chromium and is for the operator to run after review; nothing here has. For more than the first diagnosis, a controller is a Playwright-side script that imports `openAgentPreview` with `parseAutomationConfig` and drives the returned session; the existing agent browser tool cannot attach to this context.

## The banner

While the mode is on, every page shows **UNSAFE PREVIEW — agent access enabled** in a red bar (`web/src/components/agent-preview-banner.tsx`), signed in or not, to a human as much as to the automation session. For an automation session it adds when it ends and, after that, that it expired. It shows no secret. When the mode is absent the app renders exactly as before. The web app reads `agentPreview: { enabled: true, expiresAt: <Unix ms> | null }` on the existing `/auth/session` answer (`AuthSession` in `web/src/lib/auth.ts`), which the auth branch adds in the evaluation while automation is on: `expiresAt` is `null` for a signed-out or passkey browser and a number for `method: "automation"`. It is shown whether or not anyone is signed in, so the human sees it too. This matches the auth branch's page; the two have not run together.

## Tests

`pnpm --filter pim-cua-host test` runs `test/agent-preview.test.ts` (with the rest); `pnpm --filter pim-web test` runs the banner's. They prove, with fakes and records shaped like the Worker's real `ObservationView`: one context serves the exchange, an API read and a page; the credential only goes in the POST; isolated context options; origin rules, route aborts, the browser request bound and the WebSocket handler installed first and never connecting; file-permission refusals; fixed, redacted errors and cleanup on each failure path; the lifetime limits and timer close; no retry; the Playwright version check against a fake module; and that first use is read only.

## Not done

An interactive controller beyond the first diagnosis; Playwright installed; any run of a real browser or against the real backend; the auth branch's acceptance. This branch does not contain the auth branch.
