# Starting and qualifying the viewer-first preview on one VM: the plan

This is a plan for review, in prose. It is not a script. Nothing in it has been done, and nothing in it is authorized by being written down. It creates no cloud resource, certificate, DNS name, account, file or service. It doesn't touch main or deploy a Cloudflare Worker, and it runs no type check, build or install.

It is meant to be approved once, as one bounded package with a single go or no-go: the topology, the stages, the checks, the stop conditions, the $15 and 48-hour bound, and the cleanup below. It is not a sequence of separate approvals. Until that decision, execution is held. **The decision today is no-go**, because of the open blocker in "Wrangler's developer listeners".

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
- **Pim's address, set in Wrangler:** wrangler runs with `--host pim-cua-eval.ajac-zero.com --upstream-protocol https`. With those, the URL the Worker sees is `https://pim-cua-eval.ajac-zero.com/…` whatever `Host` the request came with. In `wrangler@4.148.0`'s `wrangler-dist/cli.js`, `--host` and `--upstream-protocol` become the dev origin (L370035–370038). That origin sets the inner URL (L365054–365068) and Miniflare's `upstream` (L365172–365173). Then:
  - **The ProxyWorker** (`wrangler-dist/ProxyWorker.js` L116–132) sets `MF-Original-URL` to the inner URL, replacing any the client sent.
  - **Miniflare's entry** (`miniflare/dist/src/workers/core/entry.worker.js` L5082–5106) rebuilds the URL on `upstream`.

  Without those flags, the URL's host is the request's `Host`. The evaluation then answers `421` to everything, because it serves only at `PIM_PUBLIC_URL` and rewrites nothing onto it.
- **The ingress:** Caddy, pinned as `deploy/celld/versions.env` pins it (v2.11.7, by SHA-256), gets both certificates by ACME HTTP-01, so ports 80 and 443 must be open. Plain HTTP only redirects.
  - **What it does for Pim's host**, as `deploy/celld/caddy/Caddyfile` does for celld:
    - it sets `X-Pim-Client-IP` from the connection and `X-Pim-Ingress-Secret` from its own environment, replacing whatever the client sent;
    - it drops other address headers;
    - it answers `404` for `/__dev*` before proxying. That is defense in depth only: the application refuses those paths itself.
  - **`Host` passes unchanged**, which is Caddy's default. Wrangler's ProxyWorker rewrites any header value that names the incoming host into Pim's origin (`rewriteUrlRelatedHeaders`, `ProxyWorker.js` L300–320). So the incoming host must be Pim's own, where only Caddy's redirect is served. Rewriting `Host` to `127.0.0.1:8787` would let Wrangler turn an `Origin` of `http://127.0.0.1:8787` into Pim's origin before the Worker reads it.
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
- **Only at Pim's address.** A request whose URL isn't exactly at `PIM_PUBLIC_URL` is `421`: loopback, another host, plain HTTP or another port. Nothing is rewritten onto Pim's address. `Host`, `X-Forwarded-*`, `Forwarded` and `MF-Original-Hostname` are never read as the authority, and the browser's `Origin` is left as it came. Passkeys are made for the host `pim-cua-eval.ajac-zero.com`, and the session cookie is `__Host-pim-session`: `Secure`, `Path=/`, no `Domain`, so host-only.
- **Watching needs the owner's passkey session.** An API token or an anonymous request is refused (`401`), as in every mode.
- **Set up wrong, it answers nothing.** The Worker answers `503` to every request in any of these cases:
  - the mode is named but `PIM_PUBLIC_URL` isn't an exact, canonical HTTPS origin;
  - the ingress secret is missing or too short (at least 32 visible characters, and not `APP_CREDENTIALS_KEY`);
  - the claim digest is malformed;
  - `PIM_PUBLIC_URL` is HTTPS but the mode isn't named;
  - a request carries the ingress's headers while the mode isn't named.

  So a preview whose evaluation settings didn't load can't be reached through Caddy as an open local preview.
- **Native tools, the optional Cua child and takeover stay off.** The ledger has no recovery, reset or eviction, as before (`preview/cua-viewer-first.ts`, `docs/cua-observation.md`).

The tests that check this are fake-only. They are the seven evaluation-mode tests in `test/preview-cua-fixture.test.ts`, listed in `docs/cua-viewer-first-worker.md`, and none has run yet.

## Setting up the one owner

This reuses Pim's own claim, the way the first account of any Pim becomes its admin. The claim code comes from the operator instead of the Worker's logs, and is accepted once.

1. **The operator makes the code**, on their own machine, not on the VM: 32 random bytes written as unpadded base64url, which is 43 characters.
2. **The preview is provisioned with only the code's SHA-256**, in lowercase hex, as `PREVIEW_EVAL_CLAIM_SHA256` in its private environment. The code itself is not provisioned, stored or logged anywhere on the VM, and no response carries it.
   - **It does reach the VM, once.** The registration's JSON body carries it: over TLS to Caddy, then over loopback HTTP through Wrangler's ProxyWorker to the Worker.
   - **Where it exists, and how long:** it sits briefly in those processes' memory, and the Worker hashes and compares it. Nothing claims it can't be read there by root or by those processes' accounts.
3. **The person registers.** With the preview running in the mode and the fixture off, they open `https://pim-cua-eval.ajac-zero.com/#claim=<code>` in the browser they will watch from. The fragment isn't part of the HTTP request target, so it isn't in Caddy's or Wrangler's request line. The web app shows the claim form and takes the fragment out of the address bar and history once used, then sends the code in the registration's body, as above. They choose a username, keep the recovery codes the page shows once, and make a passkey. That is the real WebAuthn ceremony for the relying party `pim-cua-eval.ajac-zero.com`, with no forged session and no dev passkey.
4. **The Directory records the claim before registering anyone.** The preview's Directory (`EvalDirectory`) compares the code's digest in constant time.
   - **One record, written first.** Before it registers the admin, it inserts the evaluation's one claim record (`claiming`). The insert is plain, never a replace, and no wait comes between the last check and it, so of two claims at once only one is recorded.
   - **Nothing is registered unless that write succeeds.** If the write fails, nobody is registered and the request is refused (`503`).
   - **Afterwards the record only moves on** from `claiming`, to `claimed` or `failed`. If that last write fails, or the registration throws, the record stays `claiming`. That is logged and refuses as surely. Nothing deletes or replaces the record.
   - **Every later claim is refused**, whether that one succeeded, failed or never got a passkey, and also after the Directory restarts or the registration's day has passed.
   - **A Directory that already holds any account** is never claimed, and that refusal is recorded for good. A wrong code changes nothing.
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
| The claim code's digest | The preview's private environment. The code itself is never provisioned or stored; it reaches the Worker once, in the registration's body. |
| Pim's state: sessions, passkeys, the ledger, the cookie key | `wrangler dev --persist-to` in `pim-preview`'s own `0700` directory |
| `CUA_BRIDGES` (the bridge's URL and bearer token) | The preview's private environment, delivered as `docs/cua-eval-credentials.md` says |
| The TLS keys for both hosts | Caddy's own storage |
| The bridge's bearer token, its loopback TLS key, spacesd's root token, the journal | `pim-bridge`'s own `0700` directories, as `docs/cua-viewer-first-preview.md` and `docs/cua-bridge.md` say |

## What the package must settle

These are consequential, and none is decided here. They are part of the one package, not separate approvals.

1. **Wrangler's developer listeners**, the blocker; see the section of that name below. The topology stays one VM.
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

## Wrangler's developer listeners: the open blocker

**Why it matters.** `pim-desktop`, which every agent runs as, shares the VM's loopback with wrangler. That is not changed here: the topology stays one VM. What matters is which loopback listeners `wrangler dev` opens and what each one checks. Read from the installed source only, with no process run or inspected:

- **Wrangler's DevTools inspector proxy: on, with no credential.**
  - **Always on for `wrangler dev`:** the `dev` command always passes an inspector object, `{ hostname: --inspector-ip, port: --inspector-port }` (`wrangler@4.148.0/wrangler-dist/cli.js` L370031–370034), never `false`.
  - **No configuration turns it off:** `resolveInspectorConfig` turns it off only for `dev.inspector === false`. Otherwise it listens on `inspector_ip` or `127.0.0.1`, on `inspector_port` or the first free port from 9229 (L207242–207251, L206911, L207657). The proxy then runs `InspectorProxyWorker` on that socket (L208288–208320).
  - **What it checks:** only that `Host` names localhost and that `Origin` is a local one. A request without an `Origin` and without a `User-Agent` counts as local (`wrangler-dist/InspectorProxyWorker.js` L47–58, L369–396). That stops a browser page, not a local process.
- **workerd's own inspector: also on.**
  - Unless `dev.inspector === false`, the user Worker's Miniflare gets `inspect: true, inspectorPort: 0` (`cli.js` L365156–365164).
  - Miniflare then starts workerd with `--inspector-addr=127.0.0.1:<random port>` (`miniflare/dist/src/index.js` L107310–107312, L124925–124942). No credential is passed to it, and nothing installed shows workerd checking one.
  - `VSCODE_INSPECTOR_OPTIONS` turns off only the proxy (`cli.js` L208489–208495), not this inspector, so it is no remedy.
- **The dev registry's debug port.** Miniflare starts workerd with `--debug-port=127.0.0.1:0` whenever the registry path is non-empty (`index.js` L107313–107315, L124914–124916, L121389–121391).
  - The dev server passes `registry: args.disableDevRegistry ? void 0 : getRegistryPath()` (`cli.js` L370043), and `getRegistryPath()` defaults to a directory unless `WRANGLER_REGISTRY_PATH` is set (L19833–19838).
  - `disableDevRegistry` is set only by the experimental programmatic `unstable_dev` export (L370168–370214, and L369914 for its auxiliary Workers). The `wrangler dev` command has no flag for it, so under `wrangler dev` the registry path is always set.
  - Whether an empty `WRANGLER_REGISTRY_PATH` turns the port off, and what the port allows, are unverified. It is counted as unauthenticated control until shown otherwise.
- **Miniflare's Node loopback server: authenticated.** It requires `MF-Loopback-Secret`, compared in constant time (`index.js` L124109–124115). The only exception is a module-fallback service, which `wrangler dev` isn't shown to configure.
- **The user Worker's own entry socket: open, but it reaches only Pim.**
  - It sits on `127.0.0.1` at a random port, and it takes `MF-Original-URL` without the shared secret (`entry.worker.js` L5082–5099).
  - With `upstream` set, the URL is rebuilt on Pim's origin anyway. What arrives is still the Worker's, which refuses requests without the ingress secret.
  - The magic-proxy operations on that socket require a secret (`entry.worker.js` L4939–4950).
- **The ProxyWorker's control requests: authenticated.** They require `Authorization` equal to a random secret (`ProxyWorker.js` L216–218).

**What disables the inspectors.** The only path in this version's source that turns both inspectors off is `dev.inspector: false` through the programmatic `unstable_startWorker` export (`cli.js` L372743, L364969–364972). That leads to L207243, L208494 and L365156. The same path can leave `dev.registry` unset, and with it the debug port. That export is experimental, and it is not accepted as a supported way, so no launcher is written on it.

**The documented interfaces offer no off switch either.** Cloudflare's Wrangler configuration reference lists `dev.inspector_port` (default 9229) and `dev.inspector_ip` (default `127.0.0.1`), and nothing that disables the inspector (https://developers.cloudflare.com/workers/wrangler/configuration/). Its command reference lists `--inspector-port` for `wrangler dev`, and no flag that disables the inspector or the dev registry (https://developers.cloudflare.com/workers/wrangler/commands/workers/).

**So there is no supported, stable way to run Pim under `wrangler dev` with every developer and control listener off, and the live evaluation is no-go until a person chooses how Pim runs on the VM.** The choices, none of them implemented here:

1. **Accept a reviewed launcher on `unstable_startWorker`,** with `dev.inspector: false` and no registry, and a start-time check that only the declared loopback port listens. It is the smallest change, but it rests on an API Cloudflare marks experimental, which can change in any Wrangler release.
2. **Run workerd directly** from a generated, reviewed configuration with no `--inspector-addr` and no `--debug-port`. workerd is a supported runtime, but Pim's KV, R2, assets and Durable Object storage would need their own configuration in place of Miniflare's, which is substantial new work to write and review.
3. **Run Pim on the reviewed celld runtime** (`deploy/celld`, with Caddy pinned in `deploy/celld/versions.env`). That reuses reviewed operations, but it changes how the evaluation is hosted, and it doesn't remove the problem: celld's peer and operator API has no authentication and listens on loopback (`docs/celld.md`, "How it fits together" and "The proxy"), which `pim-desktop` shares on one VM.
4. **Accept the listeners as they are,** with any local process, `pim-desktop` and its agents included, able to reach unauthenticated inspectors. Not recommended: an inspector can run code inside Pim.

The bundle inclusion, the service units, the Caddy configuration and the journal step wait on this choice, because each depends on how Pim is started.

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

Once the package is approved as a whole, these steps run in this order. They stop at the first refusal, surprise or bound, with no retry. A failed install means a new VM, never a repair.

1. **The package's go:** items 1 to 6 above settled.
2. **The base, and the accounts:** `pim-preview`, Caddy's, `pim-bridge` and `pim-desktop`.
3. **The bridge:**
   - the bundle with the viewer host, delivered root-owned;
   - `plan.sh`, then `install.sh`;
   - the journal, made once;
   - the root token's file;
   - `seal`, then the operator's `open`, which delivers `CUA_BRIDGES`.
4. **The preview:** checkout, locked install and web build as `pim-preview`. Wrangler runs with `--ip 127.0.0.1 --host pim-cua-eval.ajac-zero.com --upstream-protocol https`, plus whatever the listener blocker's resolution requires. Its private environment holds `PREVIEW_MODE=cua-eval`, `PIM_PUBLIC_URL=https://pim-cua-eval.ajac-zero.com`, `PIM_INGRESS_SECRET` and `PREVIEW_EVAL_CLAIM_SHA256`, with the fixture off. Its state directory is under `pim-preview`, and wrangler's telemetry is off.
5. **Start, inside out:** the desktop endpoint, then the bridge with the viewer's settings, then the preview, then Caddy last, so nothing is public before the application runs in its mode.
6. **Check before anyone signs in:**
   - **on loopback:** the preview answers `403` without the ingress secret;
   - **the listeners:** only those the listener blocker's resolution allows are open;
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
