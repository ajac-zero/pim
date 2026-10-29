# Automation sign-in for the preview's Cua evaluation

The preview's Cua evaluation (`preview/cua-eval.ts`, `wrangler.cua-eval.jsonc`) signs people in only with a passkey. A runner the operator protects sometimes needs to look at the evaluation the way its owner does, in an isolated browser and through the API, without a passkey. This page describes how that runner signs in and the limits on what it can do. The code is in `preview/automation.ts`, with the mount in `src/gateway.ts` (`AutomationSessions`).

It is not anonymous access, not an API token, and not `/__dev` sign-in, which the evaluation still refuses. Nor is it the one-use launch evaluator (`docs/launch-evaluator.md`), which has its own grant, credential and routes, makes no session, and gives an automation session nothing. Nobody is registered or enrolled, and no passkey, token or account is made. Ordinary passkey sessions don't change.

## Off unless the evaluation grants it

Only the evaluation mounts automation sign-in (`evaluation` in `preview/worker.ts`). The local preview doesn't, and a deployment's entry point (`src/index.ts`) never passes the mount to `serve`. So copying these variables into a deployment, or into the local preview, opens nothing: its routes answer as `/auth` always has (`401 Sign in to Pim`), and its cookie signs nobody in.

Within the evaluation, automation sign-in is off unless the preview's private environment sets both of these variables:

- `PREVIEW_AUTOMATION=on`, the explicit opt-in. Any other value means off.
- `PREVIEW_AUTOMATION_GRANT`, one JSON object with exactly these fields:

```json
{
  "owner": "o_…",
  "evaluation": "cua-eval-…",
  "deployment": "cua-eval@cloudflare",
  "origin": "https://pim-cua-eval.ajac-zero.com",
  "credentialSha256": "<64 lowercase hex digits>",
  "notAfter": "2026-10-30T01:20:50Z"
}
```

| Field | Must be |
| --- | --- |
| `owner` | The owner the evaluation's claim set up (the Directory's claim record, `claimed`), whose account is active. Any other owner, even an existing one, is refused. |
| `evaluation` | The evaluation's ID, as `docs/cua-eval-credentials.md` names them. The runner must name the same evaluation. |
| `deployment` | `cua-eval@<PIM_RUNTIME>`, the mode and runtime this Worker actually runs as. A grant for `cua-eval@cloudflare` does nothing in a `celld` Worker, and the reverse. |
| `origin` | Exactly `PIM_PUBLIC_URL`, an HTTPS origin. |
| `credentialSha256` | The SHA-256 of the operator's credential. The preview is never given the credential itself. |
| `notAfter` | The evaluation's absolute cleanup deadline, in UTC. It must be in the future and no more than 7 days ahead. No session lasts past it, and once it passes, automation sign-in is off. |

A grant that doesn't meet every rule means automation sign-in is off. The reason is logged (`preview.automation`, `outcome: "off"`) only when someone asks for an automation route.

## The credential and the runner's input

The operator makes the credential, a value of 32 random bytes:

```sh
node scripts/preview-automation-grant.mjs /absolute/path/runner.json https://pim-cua-eval.ajac-zero.com o_… <evaluation> cua-eval@cloudflare 2026-10-30T01:20:50Z
```

The script writes the runner's input to a new file that only its owner can read (mode `0600`, never over an existing file). It prints only the grant, with the credential's digest, for `PREVIEW_AUTOMATION_GRANT`. The runner's input looks like this:

```json
{ "version": 1, "origin": "https://…", "owner": "o_…", "evaluation": "…", "deployment": "cua-eval@cloudflare", "credential": "<43 base64url characters>" }
```

The credential goes only in the `Authorization` header of a POST. It never goes in a URL, a body, a log, chat or the browser. A credential grants one evaluation's one owner and nothing else: no admin, bootstrap or enrollment power. To make a new grant, make a new credential.

## Operator readiness before the one exchange

**A successful secret write is not readiness.** In the installed `wrangler@4.148.0` (`wrangler-dist/cli.js`), `wrangler secret put` sends one secret to the Worker's `/secrets` endpoint. When the latest version isn't the deployed one, Cloudflare refuses the write (errors 10214 and 10215), and Wrangler explains that the limit exists "to prevent accidental deployment": a write to the deployed version makes and deploys a new version. So setting `PREVIEW_AUTOMATION` and `PREVIEW_AUTOMATION_GRANT` with two writes makes two versions, and the first of them serves with only one of the two. `wrangler secret bulk` sends both in one request to `/secrets-bulk`; whether that always makes exactly one version isn't visible in Wrangler's source, so the gate below checks the version either way. "Success! Uploaded secret" says the write was accepted, not which version serves a given request.

The operator makes the one permitted exchange only after every step below passes, in order, immediately before it. Any step that doesn't pass means stop: no exchange.

1. **Write the grant first and the flag last**, or both in one `wrangler secret bulk -c wrangler.cua-eval.jsonc`. Never turn the flag on while an earlier grant may still be set.
2. **One version serves everything.** `pnpm wrangler deployments status -c wrangler.cua-eval.jsonc` shows exactly one version, at 100%, of the `pim-cua-eval` Worker (never `pim`). A split, or another Worker's name, is a stop.
3. **That version holds both.** `pnpm wrangler versions view <that version ID> -c wrangler.cua-eval.jsonc` lists both `PREVIEW_AUTOMATION` and `PREVIEW_AUTOMATION_GRANT` under Secrets, and was created no earlier than the last write. It prints names only: no value is readable, so this can't show that the flag is `on` or that the grant is the one printed for this credential.
4. **The Worker serving a read sees both.** A signed-out `GET https://<origin>/auth/session`, with no cookie and no credential, answers `"agentPreview": {"enabled": true, "expiresAt": null}`. The Worker adds that only when the request it served saw `PREVIEW_AUTOMATION=on` and a grant well formed for this mode, runtime and address, and not past its `notAfter` (`describe` in `preview/automation.ts`). Without it, stop.
5. **The one exchange.** `201` goes on. Any `401` is the end of the attempt: no retry and no second exchange. The operator turns the flag off, then removes the grant (each its own approved step), and records the outcome as unclassified.

**What the gate can't prove.** Steps 2 and 3 are the control plane's record of what is deployed. Wrangler has no command that reports whether every Cloudflare location serves that version yet, and nothing here claims it does. Step 4 is evidence about the one request that made it: a grant for another credential, owner or evaluation that is well formed reads the same, and the exchange may be served by another version than the read was. So the gate makes a refused exchange less likely; it can't rule one out, and the procedure fails closed instead: a refusal stops the attempt.

**What a refusal says.** The exchange's two `401` bodies are fixed and unchanged. `Sign in to Pim` means the route wasn't on for that request: the flag or grant wasn't seen, or the grant wasn't valid for this Worker then. `That automation credential isn't valid for this preview.` means the route was on and refused the credential, the identity in the body, or the Directory's check. Neither says which, or which version served it, so a refusal stays unclassified.

**Local coverage, not propagation.** `test/preview-automation.test.ts` ("refuses the exchange with the same fixed 401s while a request sees only part of the flag and grant…") serves each request from one environment snapshot: neither, the grant only, the flag only, the flag off, another runtime's grant, another credential's grant, and both. It checks the readiness read and the exchange's fixed `401` for each, a read that passes on one snapshot followed by an exchange served by another, no session recorded and no credential logged by any refusal, and then one exchange that signs in when both are seen. That is deterministic and local. It qualifies nothing about how Cloudflare propagates a version.

## The interface

All routes are at the preview's own origin. A write must carry `Origin: <origin>` exactly; a read may carry that or none.

### Exchange: `POST /auth/automation/session`

```http
POST /auth/automation/session
Origin: https://pim-cua-eval.ajac-zero.com
Authorization: Pim-Automation <credential>
Content-Type: application/json

{"owner":"o_…","evaluation":"…","deployment":"cua-eval@cloudflare"}
```

The body has exactly these three fields, and each must match the grant. On success the answer is `201` with the session's metadata (below) and this cookie:

```http
Set-Cookie: __Host-pim-automation=<43 base64url characters>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<seconds>
```

- `Max-Age` is at most 1800 (30 minutes), and less when the grant's `notAfter` comes sooner.
- The `__Host-` prefix makes it host-only: no `Domain`, so no other host under a shared parent domain gets it. It is separate from the passkey session's `__Host-pim-session`, which lasts 30 days.
- The Directory keeps only the cookie's SHA-256, with what the session is bound to: the grant's digest, owner, evaluation, deployment, origin, creation and expiry.
- A wrong credential, owner, evaluation or deployment, a revoked grant, or any owner but the claimed active one all get the same answer: `401 That automation credential isn't valid for this preview.` A request from another origin gets `403`. A grant may hold 8 unexpired sessions at once; the next exchange gets `429`.
- The exchange is under `/auth`, so the evaluation's auth rate limit counts it per client address.

The runner (`computer/cua-host/agent-preview.ts`, docs/agent-preview.md) makes the exchange through its isolated Playwright context's own request object, so the cookie lands in that context's jar, serves both its API reads and its pages, and is never handled by the runner or set through a browser protocol.

### Metadata: `GET /auth/automation/session`

```json
{
  "mode": "enabled",
  "session": {
    "kind": "automation",
    "access": "read-only",
    "owner": "o_…",
    "username": "…",
    "evaluation": "…",
    "deployment": "cua-eval@cloudflare",
    "origin": "https://…",
    "expiresAt": "2026-10-29T12:30:00.000Z",
    "notAfter": "2026-10-30T01:20:50.000Z"
  }
}
```

`session` is `null` when the request carries no good session. `expiresAt` is when the session ends, and `notAfter` is the grant's deadline. The answer never contains the credential or the cookie.

### What the web app sees: `GET /auth/session`

The web app already reads `GET /auth/session`. In the evaluation, while automation is on (the flag set and the grant good now), every answer gains one field, `agentPreview`, for a banner:

| Browser | `method` | `agentPreview` | `automation` |
| --- | --- | --- | --- |
| Automation off, or a deployment, or the local preview | as before | absent | absent |
| Signed out, automation on | `null` | `{ "enabled": true, "expiresAt": null }` | absent |
| Passkey session, automation on | `"passkey"` | `{ "enabled": true, "expiresAt": null }` | absent |
| Good automation session | `"automation"` | `{ "enabled": true, "expiresAt": <Unix ms> }` | the session object above |

`agentPreview.expiresAt` is a number of Unix milliseconds, set only for an automation session: when that session ends, at most 30 minutes after the exchange and never past the grant's `notAfter`. It equals `Date.parse(automation.expiresAt)`. Nothing else in a signed-out or passkey answer changes.

An automation session's full answer is `{ "signedIn": true, "method": "automation", "passkey": null, "credential": null, "account": { "username", "role" }, "name": null, "providers": [], "automation": <session>, "agentPreview": { "enabled": true, "expiresAt": <Unix ms> } }`. A banner tells automation from a person by `method` (or by a number in `agentPreview.expiresAt`), and automation is never counted as evidence of a real passkey. The answer never carries the credential or the cookie.

### End this session: `DELETE /auth/automation/session`

Ends the session the request carries, recorded in the Directory, and clears the cookie. It answers `200 {"ok": true}` either way.

### Revoke the grant: `POST /auth/automation/revoke`

This route takes the same header and body as the exchange. It records the grant's digest as revoked, for good. Every session the grant made stops on its next request, and the credential makes no more sessions.

### Aggregate check of stored observations: `GET /auth/automation/observation-summary`

For a future automation-only check of the owner's observation ledger, without touching any record. It answers only a plain `GET` (no query, no `Authorization` header, no `Upgrade`) that carries a current automation session for the grant's claimed, active owner, checked again in full as below; a passkey session, an API token, no session, another owner's grant, a revoked, ended or expired session, or a request from another site gets `401`, another method `405`, and a query or upgrade `400`. Off, in the local preview and in a deployment, the route isn't there.

The Worker asks the owner's space over RPC (`observationSummary` on the preview's `Pim`, by a plain Durable Object stub). The space answers only in the evaluation, while the automation grant is on and names its owner, in the space the Cua fixture seeded, active and not erased. It reads the ledger as stored and counts it: it never makes the space's observation desk, so nothing is restored (`pending_open` and `revoking` are counted as they are, not as the `unconfirmed` the desk would recover them to), written, flushed or asked of the viewer's host. The RPC is synchronous so the agents library doesn't start the space's lifecycle, which writes its own tables. The person's list, Watch and End still make the desk on first use, and recover those records as before.

```json
{ "kind": "observation-summary", "ledger": "valid", "total": 3,
  "counts": { "pending_open": 1, "open": 0, "revoking": 1, "unconfirmed": 1, "closed_observed": 0, "not_opened": 0, "reconciled": 0 } }
```

`ledger` is `valid`, `missing` (none is stored) or `invalid` (stored, but not a ledger the space could use); the last two have `total` and `counts` `null`. The answer and its log line never hold an observation ID, evidence, time, launch, generation, ticket, address, the owner, the cookie or the credential. There is no per-record route.

## Every request is checked again

Each request that carries the cookie, socket upgrades included, is checked again in full. Nothing is cached between requests. The request is signed in only if all of these hold:

1. Automation is on now: the flag is set, and the grant is well formed, matches this Worker's mode, runtime and address, and its `notAfter` hasn't passed. This is read from the environment on every request.
2. The request is at the grant's origin.
3. The Directory holds a session for the cookie's SHA-256 that hasn't ended or expired, and whose grant isn't revoked. This is read from the Directory's storage on every request.
4. The session's grant digest, owner, evaluation, deployment and origin equal the grant's now. Changing the grant in the environment ends the sessions it made; turning it off stops them while it is off. To end them for good, revoke the grant or end each session.
5. The session's owner is still the claimed owner and active, read from the Directory's own row on every request rather than the Worker's account cache. The gateway then applies the usual account checks, the check that the request comes from this app's own origin, and the per-person API rate limit.

A browser that carries a good automation session counts as automation, even if it also carries a passkey session. A browser whose automation session is no longer good falls back to whatever else it carries, as before.

## What a session can do: read only

On `/api`, an automation session gets:

- only `GET` and `HEAD`, and no socket (`403 An automation session only reads, and not this.`; see below);
- none of these reads: an observation's status or anything under `/api/observations/<id>` (a status may ask the viewer's host and settle a record), the agent's browser (`/api/browser…`), a model's suggestions, ChatGPT's sign-in, and either export;
- the list of observations (`GET /api/observations`), which the space answers from what it holds. It never starts, ends, checks or reconciles an observation;
- nothing that needs the person's own browser session. The space is never told the request is the person's browser (`x-pim-signed-in`), and account deletion and the admin API are refused.

It manages no sign-in. Every `/auth` route but those above, such as tokens, passkeys, device links, recovery codes and MCP connections, answers it `401`, as it would a browser that isn't signed in. Approvals and tools are unchanged: an automation session can't approve anything, because approving is a write.

Signing in, reading the metadata, ending and revoking write only the Directory's automation tables (`preview_automation_sessions`, `preview_automation_revoked`). They change no observation or journal record, no tool, approval, token, passkey, linked identity or account, and reach no host.

## Sockets and revocation

**The boundary.** An automation session never has an open socket. The gateway refuses a request that carries a good automation session and any `Upgrade` header (`/api/ws`, `/api/browser/live` or any other path, in any spelling), with `403`, after checking the session again and before any space sees the request. So no WebSocket, and no RPC over one, is ever established on an automation session. A revoked, ended or expired session's handshake gets `401`, as with no session. That is the backend's enforcement; a runner blocking sockets in its browser is a second layer, not a substitute.

**Why refuse rather than recheck.** The space checks a socket only at its handshake, through the gateway. Once `/api/ws` is open, the space (`onMessage` in `src/pim.ts`) runs every command it is sent (`submit` a message, `abort` or `reset` a run, `follow` a chat) with no further check of the session that opened it, for passkey sessions too. Nothing ties an open connection to a session, so revoking a session, a grant or an account doesn't close it. Letting automation sockets through and revoking them reliably would need the space to record which session opened each connection, recheck it before each command or on a timer, and close its connections when the session, the grant or its deadline ends. That is a change to the space's socket handling for every connection, which this change doesn't make. Refusing every automation handshake is the complete enforcement within this scope.

**What this doesn't cover.** A browser that also carries the owner's own passkey session, and whose automation session has ended, is signed in by that passkey session as before, sockets included: that is the person's own session, under its own rules. Passkey sockets outliving a signed-out or removed passkey is an existing property of Pim, unchanged here. Sockets that don't sign in with the browser's cookies (a computer's `/api/computer/connect` with its own token, and MCP clients with OAuth or API tokens) are unaffected.

## Tests

`test/preview-automation.test.ts` runs in workerd against the real preview Worker and a deployment's Worker (`src/index.ts`), with a fresh evaluation Directory per test. The owner is set up by the claim and a passkey made in the real ceremony by the tests' software authenticator. It starts no service, browser or socket, reaches nothing outside the isolate, and moves time only with `Date.now`. It covers:

- a good exchange: the cookie's attributes and lifetime, the metadata, `/auth/session`, reads, and the read-only boundary (writes, sockets, the refused reads, `/auth` management, the admin API, another origin). The credential and cookie are never logged, and the Directory holds only the cookie's digest;
- the operator readiness gate's local model: requests served by snapshots holding part of the flag and grant, the readiness read for each, and the exchange's fixed `401`s (see above);
- refusals with no cookie and no session recorded: another origin, evaluation, deployment, owner or credential; the credential anywhere but its header; a grant for an owner other than the claimed one; and automation off, with no flag, another flag value, no grant, another origin or runtime, a past or too-distant deadline, a malformed digest or an extra field, and in the local preview;
- a deployment's entry point with every preview variable copied and a live session, which offers none of it, while the owner's passkey still works there;
- ending one session; revoking the grant (at once, in the same isolate, and after the Directory restarts); changing or turning off the grant; a suspended owner; and expiry at 30 minutes;
- the deadline cap, a deadline brought forward, and the limit of 8 sessions;
- a passkey session unchanged but for `agentPreview`, and a browser that carries both counted as automation;
- `agentPreview` for signed-out, passkey and automation browsers while on, and absent while off and in a deployment;
- socket handshakes on `/api/ws`, `/api/browser/live` and other paths, in either spelling, refused with no socket made; and refused with `401` after ending, revoking or expiry;
- the observation summary: every status counted as stored, through the Worker, the Directory and the owner's space, with no SQL write, `put`, `delete`, `sync`, transaction, alarm or metadata write in the space, its ledger byte for byte as stored, and no bridge reached; missing and malformed ledgers; the full refusal matrix above, off, in the local preview and in a deployment; the space's RPC refusing outside its grant; and the person's list, Watch and End still recovering `pending_open` and `revoking` records on the desk's first use;
- a seeded space holding one unresolved observation: signing in, reading the metadata, listing, ending and revoking leave the space's storage, the owner's tokens, passkeys and linked identities, and the account exactly as they were. Its status, a Watch and an End are refused, and nothing reaches the host.

The same file runs the runner's first diagnosis (`openAgentPreview` with `parseAutomationConfig`, then `diagnoseObservations`) against this Worker, through fake Playwright objects whose requests reach the preview's Worker in the isolate. It checks that the runner's exchange, the cookie the Worker sets, the observation list and the banner's `/auth/session` work together; that the Worker is asked exactly the exchange, the list, `/` and `/auth/session`; that the page's request for one observation's status and its socket stop in the runner's context; and that the Worker refuses both on such a session anyway.

Removing any one of the revocation recheck, the deadline cap or the refusal of observation status, or mounting the routes in `src/index.ts`, fails these tests. So does making the space's desk when the space starts rather than on first use, or making the summary's RPC async.

## Not covered

- Nothing here has run against the live evaluation, a real browser, a real runner, Cloudflare's runtime or its rate limits. Setting the variables in the live evaluation is a separate step that needs its own approval.
- The list of refused reads is a list of known reads with side effects, not a proof that every other `GET` in the space has none.
- On Cloudflare, removing or changing a variable takes effect when the new version serves. Revoking through the route takes effect on the next request.
- Whether every Cloudflare location serves the deployed version before the exchange is neither observable with Wrangler nor tested here; the readiness gate fails closed rather than claim it.
- The runner and the banner (docs/agent-preview.md) have run against this Worker only with fake Playwright objects, in workerd: no real browser, Playwright install, page render or network.
