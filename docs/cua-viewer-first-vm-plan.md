# Starting and qualifying the viewer-first preview on one VM: the plan

This is a plan for review, in prose. It is not a script. Nothing in it has been done, and nothing in it is authorized by being written down. It creates no cloud resource, certificate, DNS name, account, file or service. It doesn't touch main or deploy a Cloudflare Worker, and it runs no type check, build or install. Each stage below needs its own approval before anyone runs it.

It gathers into one order what these documents already say: `docs/cua-viewer-first-preview.md`, `docs/cua-viewer-first-worker.md`, `docs/cua-bridge.md`, `docs/cua-eval-install.md`, `docs/cua-eval-credentials.md` and `docs/celld.md`. It adds the preview's evaluation mode (`preview/cua-eval.ts`). Where they leave something open, it says so and doesn't fill the gap.

## The proposed topology

Two hostnames point at one VM, by DNS only (no proxy in front), and nothing is reserved yet:

- **Pim:** `https://pim-cua-eval.ajac-zero.com`
- **The viewer and bridge:** `https://cua-eval.ajac-zero.com`

```diagram
 browser ──HTTPS 443──▶ Caddy (ACME HTTP-01 on 80, TLS on 443)
                         │
                         ├─ pim-cua-eval.ajac-zero.com ──HTTP──▶ 127.0.0.1:8787  wrangler dev, preview Worker, PREVIEW_MODE=cua-eval
                         │    sets X-Pim-Ingress-Secret and X-Pim-Client-IP            local Durable Objects, KV and R2 under the
                         │    refuses /__dev* (defense in depth only)                   preview account's own state directory
                         │
                         └─ cua-eval.ajac-zero.com ──HTTPS──▶ 127.0.0.1:8443  bridge.ts with the viewer host (bridge account)
                              no Pim ingress headers                               ├─ journal, root token, bridge token, TLS key
                                                                                   ├─ spacesd (view only, one display)
                                                                                   └─ Unix socket ─▶ desktop.ts ─▶ pim-computer (desktop user)
```

- **Pim's side:** the preview Worker runs locally under `wrangler dev`, bound to loopback, with its own persistent local Durable Objects, KV and R2. No Cloudflare Worker is deployed, and `pnpm dev` is never used because it bills the remote Workers AI binding.
- **The ingress:** Caddy, pinned as `deploy/celld/versions.env` pins it (v2.11.7, by SHA-256), gets both certificates by ACME HTTP-01, so ports 80 and 443 must be open. For Pim's host it does what `deploy/celld/caddy/Caddyfile` does for celld. It sets `X-Pim-Client-IP` from the connection and `X-Pim-Ingress-Secret` from its own environment, replacing whatever the client sent, and drops other address headers. It also answers `404` for `/__dev*` before proxying. That is defense in depth only: the application refuses those paths itself.
- **Accounts:** four, none of them root and none in another's group:
  - `pim-preview`: wrangler, its state and its private environment;
  - Caddy's account: its certificates and the ingress secret;
  - `pim-bridge`: the bridge and the viewer host;
  - `pim-desktop`: the desktop and every agent command.

## What the application now enforces

The preview has an explicit evaluation mode, `PREVIEW_MODE=cua-eval` (`preview/cua-eval.ts`). Without it, the local preview is as it was: open registration, `/__dev/sign-in`, and the stand-in model.

In the mode, these hold whatever the ingress or the rest of the environment does:

- **No dev sign-in and no setup link.** Every path under `/__dev`, by any method, case, percent-encoding or doubled slash, is `404`, and so is `/auth/setup-link`. Both are refused before the request is read further. No claim or admin setup link is ever written to the logs.
- **Only through the ingress.** The Worker serves with the ingress profile celld uses (`src/runtime.ts`), so a request without `PIM_INGRESS_SECRET` and a client address is `403`. The Directory counts the rate limits, and no claim window opens.
- **Registration is closed**, whatever `PIM_REGISTRATION` says. The preview's own `wrangler.preview.jsonc` says `open`, and the mode ignores it.
- **Every request is at Pim's address.** The request URL is rewritten onto `PIM_PUBLIC_URL`, and the browser's `Origin` is left as it was. Passkeys are made for the host `pim-cua-eval.ajac-zero.com`, and the session cookie is `__Host-pim-session`: `Secure`, `Path=/`, no `Domain`, so host-only.
- **Watching needs the owner's passkey session.** An API token or an anonymous request is refused (`401`), as in every mode.
- **Set up wrong, it answers nothing.** The Worker answers `503` to every request in any of these cases:
  - the mode is named but `PIM_PUBLIC_URL` isn't an exact, canonical HTTPS origin;
  - the ingress secret is missing or too short (at least 32 visible characters, and not `APP_CREDENTIALS_KEY`);
  - the claim digest is malformed;
  - `PIM_PUBLIC_URL` is HTTPS but the mode isn't named;
  - a request carries the ingress's headers while the mode isn't named.

  So a preview whose evaluation settings didn't load can't be reached through Caddy as an open local preview.
- **Native tools, the optional Cua child and takeover stay off.** The ledger has no recovery, reset or eviction, as before (`preview/cua-viewer-first.ts`, `docs/cua-observation.md`).

The tests that check this are fake-only. They are the five evaluation-mode tests in `test/preview-cua-fixture.test.ts`, listed in `docs/cua-viewer-first-worker.md`, and none has run yet.

## Setting up the one owner

This reuses Pim's own claim, the way the first account of any Pim becomes its admin. The claim code comes from the operator instead of the Worker's logs, and is accepted once.

1. **The operator makes the code**, on their own machine, not on the VM: 32 random bytes written as unpadded base64url, which is 43 characters.
2. **The preview gets only the code's SHA-256**, in lowercase hex, as `PREVIEW_EVAL_CLAIM_SHA256` in its private environment. The code itself is never on the VM, in a log, an environment, a flag or a response.
3. **The person registers.** With the preview running in the mode and the fixture off, they open `https://pim-cua-eval.ajac-zero.com/#claim=<code>` in the browser they will watch from. The web app shows the claim form for it and takes the fragment out of the address bar and history once used; a fragment never reaches a server or Caddy. They choose a username, keep the recovery codes the page shows once, and make a passkey. That is the real WebAuthn ceremony for the relying party `pim-cua-eval.ajac-zero.com`, with no forged session and no dev passkey.
4. **The Directory records the claim before registering anyone.** The preview's Directory (`EvalDirectory`) compares the code's digest in constant time. Before it registers the admin, it writes that a claim began. From then on, it refuses every claim, whether that one succeeded, failed or never got a passkey. It also never claims a Directory that already holds any account, and records that refusal for good. A wrong code changes nothing.
5. **The operator reads the owner ID** from the person's own session, such as Settings or `/api/account`, not from a log. It is then named in `PREVIEW_CUA_FIXTURE_OWNER` with `PREVIEW_CUA_FIXTURE=seed` and `CUA_BRIDGES`, and the preview is restarted once to seed. The digest may stay or go: the record refuses it either way.

The risks, stated plainly:

- **A leaked code is the owner's place.** Whoever uses the code first becomes the one owner, and the real person can't. That is visible: the claimed username is in the Directory, and `preview.eval_claim` logs the owner ID. The evaluation is then abandoned, not repaired. Make the code just before use and send it nowhere.
- **A claim that doesn't finish leaves no owner, for good**, for example when no passkey is made within the setup code's day. Nothing has been observed by then and no ledger exists. Trying again means a new evaluation, with a new state directory and its own approval, never a reset of this one.
- **No recovery through logs.** There is no setup link, so an owner who loses both the passkey and every recovery code is locked out of this evaluation.
- **Signed-in features stay.** What the signed-in owner can already do (device links, API tokens, recovery codes) works as in a deployment, for that owner only. API tokens can't watch.
- **The two hosts are same-site.** They share the registrable domain `ajac-zero.com`. Host-only cookies don't cross to the viewer's host, but same-site requests from it to Pim would carry `SameSite` cookies. Pim's `Origin` checks on writes are what refuse them. The preflight must also confirm nothing else sets cookies scoped to `.ajac-zero.com`.

## Secrets, and where each one lives

None of these is readable by `pim-desktop` or any desktop group:

| Secret | Who holds it |
| --- | --- |
| `PIM_INGRESS_SECRET` | The preview's private environment file (`pim-preview`, mode `0600` in a `0700` directory) and Caddy's environment, never its config file. Never sent to the bridge's host. |
| The claim code's digest | The preview's private environment. The code itself stays with the operator. |
| Pim's state: sessions, passkeys, the ledger, the cookie key | `wrangler dev --persist-to` in `pim-preview`'s own `0700` directory |
| `CUA_BRIDGES` (the bridge's URL and bearer token) | The preview's private environment, delivered as `docs/cua-eval-credentials.md` says |
| The TLS keys for both hosts | Caddy's own storage |
| The bridge's bearer token, its loopback TLS key, spacesd's root token, the journal | `pim-bridge`'s own `0700` directories, as `docs/cua-viewer-first-preview.md` and `docs/cua-bridge.md` say |

## Gates to decide before anything is created

These are consequential, and none is decided here.

1. **The desktop user shares the VM's loopback.**
   - **The problem:** binding wrangler to `127.0.0.1` keeps workerd off the network, not away from `pim-desktop`, which every agent runs as.
     - The preview's port is safe: it refuses requests without the ingress secret.
     - Wrangler's own developer ports are not. Its DevTools inspector defaults to 9229 on loopback, by its config schema, and Miniflare's internal loopback servers take no credential. A process there could read Pim's state and secrets.
     - Whether this wrangler version starts the inspector unasked is unverified.
   - **Options:**
     - **(a) Pim on its own VM.** `pim-cua-eval.ajac-zero.com` then points elsewhere. This is the simplest isolation.
     - **(b) The preview in its own network namespace**, reached by Caddy over a veth and given outbound access through it.
     - **(c) Firewall marks** that drop loopback connections from `pim-desktop` to the preview's sockets (`meta skuid` on output, `socket cgroupv2` on input). This is unverified.
   - **Recommendation:** the same-VM topology is not safe without one of these. (a) or (b) is the recommendation.
2. **The bridge's TLS behind Caddy.**
   - **The pinned build's option:** a stock Caddy terminates TLS and re-encrypts to the bridge's loopback HTTPS (`bridge.ts` serves HTTPS only). Caddy must then trust the bridge's private certificate explicitly.
   - **Caddy must not change the requests:** it passes `Authorization`, `x-pim-space`, `Origin`, the request target and WebSocket upgrades unchanged. It sends neither Pim's ingress headers nor the client's address headers.
   - **Caddy must not log them:** no request target or headers, because the media ticket is in the query and the launch credential is in `x-cua-env-authorization`.
   - **The alternative:** passing TLS through by SNI needs a Caddy plugin outside the pinned build.
   - The host's `--viewer-public-origin` is `https://cua-eval.ajac-zero.com` either way.
3. **How the private environment reaches the Worker.**
   - **The assumption:** `wrangler dev --env-file` overrides `wrangler.preview.jsonc`'s `vars` (`PIM_PUBLIC_URL`, `PIM_REGISTRATION`, `PIM_CONTENT_ORIGIN`). That is unverified.
   - **Why it fails safe:** if it doesn't, the Worker sees an HTTP address with the mode named and answers `503`.
   - **The check:** the first start shows it, as the absence of a `preview.refused` line and a `403` on loopback without the secret.
4. **Source still missing**, each a separate reviewed change:
   - **The bundle** must carry the viewer host and `@bufbuild/protobuf`. `operator.ts bundle` doesn't yet.
   - **The bridge's unit** must take `--viewer-origin`, `--viewer-public-origin https://cua-eval.ajac-zero.com`, `--viewer-embed-origin https://pim-cua-eval.ajac-zero.com`, `--viewer-journal-dir` and `PIM_VIEWER_ROOT_TOKEN_FILE`.
   - **The journal's provisioning step** must be written (below).
   - **The root token's file** needs a decided place.
   - **The preview's own unit**, the `pim-preview` account, and **Caddy's configuration** for these two hosts must be written.
5. **Installing the preview on the VM.** It runs from a checkout of the review branch at one exact commit, with `pnpm install --frozen-lockfile` and the web app built once, owned by `pim-preview` and writable by no one else. That is an install, with its own approval.
6. **Approvals:**
   - the Radia preflight's confirmation of both names, no shared-parent cookies and no portal;
   - DNS records;
   - ports 80 and 443;
   - the VM;
   - the budget.

## The pinned base

The base is pinned only as far as the documents pin it. The rest is blocker 1 of the preview page.

- **The operating system:** Ubuntu 24.04 with systemd.
- **The desktop:** a non-root `pim-desktop` account with a persistent graphical session on the display the viewer shows, `primary` by default.
- **Node:** 22.18 or later, one binary pinned by its exact version and SHA-256. The same binary runs the bridge and wrangler, unless the preflight chooses otherwise.
- **The browser:** Chrome, pinned by SHA-256 only. Its version isn't pinned anywhere yet.
- **Cua:** cua-spacesd 0.7.0 from trycua/cua at `fca2193`, its daemon not root.
- **Packages:** `ws` 8.22.0 and `@bufbuild/protobuf` 2.15.0, each checked against `pnpm-lock.yaml`. Caddy v2.11.7 by its SHA-256.

## The journal, made once

The host never creates its journal. Someone with authority over `pim-bridge` makes it once, after the install and before the first start:

1. **The directory:** the bridge account's own, `0700`, refused if anything is already at that path.
2. **The file:** `journal.json`, created exclusively, `0600`, with the shape `initialJournal` states.
3. **Durability:** the file and its directory are flushed.

The step never makes `journal.lock` and never runs again. A left lock, a loss or an invalid file leaves the viewer blocked, with no stale-lock recovery and no new journal, space or identity.

## Order

Each step is one approved action. The plan stops at the first refusal or surprise. A failed install means a new VM, never a repair.

1. **Approvals:** gates 1 to 6 decided and approved.
2. **The base, and the accounts:** `pim-preview`, Caddy's, `pim-bridge` and `pim-desktop`.
3. **The bridge:**
   - the bundle with the viewer host, delivered root-owned;
   - `plan.sh`, then `install.sh`;
   - the journal, made once;
   - the root token's file;
   - `seal`, then the operator's `open`, which delivers `CUA_BRIDGES`.
4. **The preview:** checkout, locked install and web build as `pim-preview`. Its private environment holds `PREVIEW_MODE=cua-eval`, `PIM_PUBLIC_URL=https://pim-cua-eval.ajac-zero.com`, `PIM_INGRESS_SECRET` and `PREVIEW_EVAL_CLAIM_SHA256`, with the fixture off. Its state directory is under `pim-preview`, and wrangler's telemetry is off.
5. **Start, inside out:** the desktop endpoint, then the bridge with the viewer's settings, then the preview, then Caddy last, so nothing is public before the application runs in its mode.
6. **Check before anyone signs in:**
   - **on loopback:** the preview answers `403` without the ingress secret;
   - **through Caddy:** `/__dev/sign-in/x` is `404` and `/health` answers;
   - **in the logs:** there is no `preview.refused` line.
7. **The owner:** set up once, as above.
8. **The seed:** the fixture's settings added, and the preview restarted once. The listing says `frame: "embeddable"` and `agent: "stand-in"`.
9. **The qualification**, below.
10. **Cleanup**, below.

## The qualification, bounded

These steps come from the bounded plan in `docs/cua-viewer-first-worker.md`, each timed, recorded, and stopped at the first unexpected result. They need no OAuth provider.

1. Watch, and see the desktop in the frame.
2. Check `Origin`, the frame's policy and the media socket's bound.
3. Stop, then Check until `closed_observed`.
4. End once with the answer lost on purpose. The record must stay `unconfirmed` and refuse the next Watch.
5. The ordinary shell, files and Chrome still reach the VM through approvals while the person watches.

Within the mode, sign-in is only the owner's passkey. A real model is a later gate of its own: the stand-in model's `/tool` calls show the wiring, not an agent working the desktop.

## Cost, time and cleanup

The evaluation is bounded at **$15 and 48 hours, counted from the creation of its first cloud resource**, whichever comes first. The budget and how spend is read are part of the VM's approval.

At either bound, or when the qualification ends or stops, the operator does these in order:

1. **Keep the evidence, read only.** Pim's state now lives on the VM, so its ledger would go with it. Before anything is deleted, the operator copies the preview's whole state directory, which holds the ledger, and the journal, privately and read only. The state directory also holds sessions, passkeys and the cookie key, so the copy is kept as a secret. Also kept: the logs of the preview, bridge, endpoint and Caddy, and the recorded steps. Nothing is edited, and nothing later starts from the copy.
2. **Remove the credentials:** stop Caddy and the preview, and remove the private environment, the evaluation's key and `preview.env`, as `docs/cua-eval-credentials.md` says.
3. **Delete the VM**, with what it holds, and the DNS records.

Deleting the VM settles nothing. An `unconfirmed` or blocked record is not resolved by deleting the VM, the journal, the bridge or Pim's state, and no later observation continues from it under a new identity. A later evaluation is a new one, with its own approval, VM, key, claim code and seed.
