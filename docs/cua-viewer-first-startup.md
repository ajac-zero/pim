# The Cua host's startup artifact, and the bounded live plan

This page is for review. It describes the source added to make the Cua host's VM startable for the isolated topology (Pim as a Cloudflare Worker, the Cua host on one Azure VM, the video direct from the VM to the person's browser), and the bounded live plan that would use it. **Nothing here has been run, built, installed, type-checked or deployed, and no resource exists.** Nothing in it is authorized by being written down: the live plan runs only on its own reviewed approval. Local Wrangler is closed and unsupported (`docs/cua-viewer-first-vm-plan.md`, "Wrangler's developer listeners"); `docs/cua-viewer-first-cloudflare.md` is the Worker's side.

Budget, as given: Azure $50 in total within 48 hours of the first resource; Cloudflare's existing Workers Paid ($5 a month) used within its included allowances only, with no incremental charge.

```diagram
 owner's browser ──passkey──▶ https://pim-cua-eval.ajac-zero.com   Cloudflare Worker `pim-cua-eval` (Pim; management only)
        │                                      │  launch / end / status  (bridge bearer, x-pim-space)
        │                                      ▼
        └──viewer page, RPC, media (capabilities, no Pim cookie)──▶ https://cua-eval.ajac-zero.com   one Azure VM
                                                                       bridge account: relay + viewer host, TLS, journal, tokens
                                                                       spacesd (view only)   desktop account: pim-computer
```

## What is added

All of it is additive. A configuration with no `viewer` renders, plans, starts and bundles exactly as before.

| File | What it adds |
| --- | --- |
| `computer/cua-host/eval-install/config.ts` | The optional `viewer` field (four exact values), `VIEWER_PATHS`, the viewer's bundle files and their pinned SHA-256s. The bridge's unit gets the reviewed flags and `PIM_VIEWER_ROOT_TOKEN_FILE`; the desktop's unit is untouched. |
| `computer/cua-host/eval-install/install.ts` | With a viewer: the planner also needs its files in the bundle, and the journal's directory and its tombstone absent; `start` also needs the root token, the journal and its tombstone as they must be, and no lock; `status` also reports their metadata. It makes none of them. |
| `computer/cua-host/eval-install/journal-provision.ts` | The one place a first journal is made: once, as root, tombstone first (below). |
| `computer/cua-host/eval-install/operator.ts` | `bundle ... --protobuf-tarball <file>` makes the bundle carry the viewer; `render` writes one more script, `journal.sh`, only when the configuration has a viewer. |
| `computer/cua-host/journal-store.ts` | `withDescriptor` is exported, so provisioning closes descriptors by the same rule as the store. |
| `preview/cua-viewer-first.ts` | An observation lasts 10 minutes (it was 30), for the live plan's bound. |
| `computer/cua-host/test/viewer-startup.test.ts` (new) | Fake-only specifications of all of it, and `fake-journal-files.ts` gains `mkdir`, `chown` and `fchown`. |

### The configuration's `viewer`

```json
"viewer": {
  "origin": "http://127.0.0.1:3211",
  "publicOrigin": "https://cua-eval.ajac-zero.com",
  "embedOrigin": "https://pim-cua-eval.ajac-zero.com",
  "display": "primary"
}
```

Exactly these four, each checked: `origin` is spacesd, plain HTTP on `127.0.0.1` and never reached from outside; `publicOrigin` is the bridge's own address, which the browser loads the viewer from and which the Worker's absolute viewer URL names; `embedOrigin` is the one Pim origin that may frame the page; both must be exact `https://host[:port]` origins as `isHttpsOrigin` takes them (no path, `:443`, uppercase, trailing dot, empty label, or wildcard), and they must differ. They become the bridge's reviewed flags, in the unit and nowhere else:

```
--viewer-origin http://127.0.0.1:3211 --viewer-public-origin https://cua-eval.ajac-zero.com \
--viewer-embed-origin https://pim-cua-eval.ajac-zero.com --viewer-journal-dir /var/lib/pim-viewer --viewer-display primary
```

with `PIM_VIEWER_ROOT_TOKEN_FILE=/etc/pim-bridge/viewer-root-token`. The bridge's relay path stays the configuration's `bridge.path` (`/pim`), so the Worker's `CUA_BRIDGES` address is `https://cua-eval.ajac-zero.com/pim`.

### The bundle, pinned

`operator.ts bundle --commit <sha> --ws-tarball <ws-8.22.0.tgz> --protobuf-tarball <protobuf-2.15.0.tgz> --out <new directory>` reads every source from git's objects at the commit, never the working tree, and adds, beside the existing files:

- **The viewer's programs:** `viewer-host.ts`, `journal-store.ts`, `viewer-adapter.ts`, `viewer-launch-manager.ts`, `viewer-lifetime.ts`, `viewer-upstream.ts`, and `eval-install/journal-provision.ts`.
- **The pinned page and scripts**, `index.html`, `viewer.js`, `index.css`, `audioWorklet.js`, `captureWorklet.js` and `LICENSE`, under `computer/cua-host/cua-viewer/`. Each of the five is refused (`viewer-asset`) unless its SHA-256 is the adapter's pin (`VIEWER_ASSETS`, cua-spacesd 0.7.0 at `fca2193`); a test holds the bundle's table equal to the adapter's.
- **`@bufbuild/protobuf`** from its tarball, whose SHA-512 must be the integrity the commit's `pnpm-lock.yaml` pins (`protobuf-integrity` otherwise), with `name` and `version` checked (`protobuf-package`); only regular files, under `package/`, with no link, device, PAX header, `..` or odd name. Its bounds are wider than `ws`'s (4096 entries, 16 MiB), because it has hundreds of files; whether that package's real file names all pass the bundle's name rule (`[A-Za-z0-9._@-]`) is **not verified here**: a name that doesn't makes the bundle step refuse, and that is a decision, not a quiet exception.
- **The marker** gains one line, `protobuf <version> <integrity>`; without a viewer the marker is what it was.

The bundle's tree digest, pinned in the configuration, covers all of it; the installer checks the files exist and are root's, and its marker names the package. Nothing is fetched and no package manager runs.

## The secrets, and who can read them

None is readable by `pim-desktop` or any desktop group; `status` runs `head -c 0` as the desktop account against each and says `denied` or `READABLE`.

| Secret | Where | Who | How it gets there |
| --- | --- | --- | --- |
| The bridge's bearer token (management) | `/etc/pim-bridge/token`, `0600` | `pim-bridge` | made on the VM by `seal`, as `docs/cua-eval-credentials.md` says; reaches the Worker only as `CUA_BRIDGES` |
| The bridge's TLS key | `/etc/pim-bridge/key.pem`, `0600` | `pim-bridge` | staged by root, copied by the installer |
| spacesd's root token | `/etc/pim-bridge/viewer-root-token`, `0600` | `pim-bridge` | **not made by anything written here (decision D2)**; `start` refuses (`viewer-root-token-missing`) until it is the bridge's own `0600` file |
| The journal | `/var/lib/pim-viewer/journal.json`, `0600` in a `0700` directory | `pim-bridge` | made once (below) |
| The journal's tombstone | `/etc/pim-eval/journal-provisioned`, `0444` | root's; readable by all, holds no secret | made first by provisioning |
| `CUA_BRIDGES` (the address and the bearer token), the claim digest | Cloudflare secrets | whoever can read the Worker's secrets | operator; **TLS and cloud credentials are never in it** |

The viewer's own capabilities (the launch credential and attach tokens) are minted per launch by the adapter and are neither of these secrets.

## The journal, made once, and its tombstone

`journal.sh` runs `journal-provision.ts` from the verified bundle as root, after `install.sh`:

1. **The tombstone first.** `/etc/pim-eval/journal-provisioned` is created with `O_CREAT | O_EXCL` (`0444`, root's), holds the evaluation and owner and nothing secret, is flushed, and its directory is flushed. Nothing in this tooling ever removes, replaces or rewrites it.
2. **Then** the journal's directory, `mkdir` (never recursive, so anything already there refuses) and given to the bridge's account at `0700`; the journal exclusively created in it (`0600`, the bridge's), written, flushed; the directory and `/var/lib` flushed. The text has the shape of `initialJournal` (revision 1, generation `provisioned`, no entries), which a test holds equal.
3. **Never** the lock, an open of an existing journal, a removal, or a replacement. A step that fails stops it and undoes nothing.

With the tombstone there, **no journal is ever made again for this VM**, whatever became of the first: a lost directory, a lost journal, a failed provisioning. A tombstone with no journal is a viewer blocked for good, which is the intended failure. Recovery, reset, a new journal, a new space or a new identity are not offered, and `docs/cua-observation.md`'s records (the claim, the ledger, every unknown or unconfirmed entry) are not settled by deleting anything.

`start.sh` refuses to start the viewer unless the root token, the journal (directory `0700`, file `0600`, the bridge's), and the tombstone (root's, `0444`) are as they must be (`viewer-root-token-missing`, `journal-missing`), and refuses if a `journal.lock` is there (`journal-locked`): a lock left by a host that ended is not recovered here. `plan.sh` refuses a VM that already has the directory or the tombstone (`preexisting-path`).

## The ingress, and what blocks it

The bridge terminates TLS itself, with the certificate and key staged for it, and listens unprivileged on `8443` (the installer refuses port 443 and adds no capability, accepted policy). The public origin is `https://cua-eval.ajac-zero.com`, port 443. The network allows only 443 in (not 80, not 8443, no SSH). **Something has to map 443 to 8443, and the artifact doesn't, because every way changes accepted scope: decision D1.**

## Decisions the artifact can't make

Each is a missing component that blocks a working start. None is implemented, and none is a redesign.

- **D1. The 443 to 8443 mapping.**
  - **A (recommended).** A root-owned nftables redirect: one file, `table ip pim_cua { chain prerouting { type nat hook prerouting priority dstnat; policy accept; tcp dport 443 redirect to :8443 } }`, loaded by one oneshot unit. It acts only on packets arriving from outside, not on the VM's own loopback. It needs `nft` on the base image and a third unit in the installer's checks. About 60 lines and their fake tests.
  - **B.** An Azure Standard Load Balancer rule, frontend 443 to backend 8443. It needs nothing on the VM, but is another billed resource to create, price and delete.
  - **C.** Let the bridge bind 443 with `AmbientCapabilities=CAP_NET_BIND_SERVICE`. One directive, but it reverses the installer's accepted "no capability, unprivileged port" policy and its test.
- **D2. spacesd, and its root token.** Nothing here installs spacesd 0.7.0 or makes `viewer-root-token`. The decision needed is how spacesd is installed and configured, as which account, and how one token reaches both spacesd and that file without passing through the desktop account or a flag. Until then the viewer can't start (`start` refuses), and ordinary shell, files and Chrome through the relay are unaffected.
- **D3. The public certificate for `cua-eval.ajac-zero.com`.** It must be one Cloudflare Workers' `fetch` and a browser trust. How it is issued (ACME DNS-01 from the operator's machine, with a DNS credential that never goes to the VM) and how the certificate and its key reach `/var/lib/pim-cua-install/` as root's `0644` and `0600` files (the staging the installer reads) is the delivery stage, undecided: the key must not travel in user data, a script or a flag. The certificate is valid for 90 days, so no renewal is part of a 48-hour evaluation.
- **D4. The base.** Ubuntu 24.04 with the `pim-desktop` account and its persistent graphical session, the pinned Node (22.18 or later) and Chrome, and `nft` if D1 is A. The exact image and pins are the base-image gate, unchanged.

A fifth is already known: Radia's preflight that Cloudflare's included allowances cover the Worker's side (`docs/cua-viewer-first-cloudflare.md`).

## The bounded live plan

It runs only on a reviewed approval of this whole page, with D1 to D4 decided, and **stops at the first refusal, surprise or bound, with no retry.** No upload, no model, no load generation, no OAuth provider; one owner, one passkey, one launch.

### Proposed resources

Names are proposals for isolation; no ID, address or subscription is invented here.

| Where | Resource | Name | Note |
| --- | --- | --- | --- |
| Azure | Resource group | `pim-cua-eval-rg` | one group, so one deletion removes everything |
| Azure | Virtual network, one subnet | `pim-cua-eval-vnet` | nothing peered |
| Azure | Network security group | `pim-cua-eval-nsg` | inbound 443/tcp only; no SSH, no 80, no 8443; commands go by Run Command |
| Azure | Public IP, Standard, static | `pim-cua-eval-ip` | static so the DNS record stays true |
| Azure | NIC, VM, OS disk | `pim-cua-eval-nic`, `pim-cua-eval-vm`, `pim-cua-eval-osdisk` | Ubuntu 24.04; size chosen against the $50 bound from Azure's calculator, not assumed here |
| Azure | Nothing else | | no Bastion, load balancer (unless D1 is B), NAT gateway, Log Analytics, backup or Defender plan |
| DNS | `A cua-eval` → the VM's address | in the `ajac-zero.com` zone | **DNS only, no proxy**: the video and the bridge's TLS go direct |
| Cloudflare | The Worker and its Durable Objects | `pim-cua-eval` | custom domain `pim-cua-eval.ajac-zero.com`; `wrangler.cua-eval.jsonc` |
| Cloudflare | KV namespace | `pim-cua-eval-oauth` | `OAUTH_KV` |
| Cloudflare | R2 buckets | `pim-cua-eval-blobs`, `pim-cua-eval-artifacts` | |
| Cloudflare | Rate-limit namespaces | two chosen integers | not created |
| Cloudflare | Secrets | `PREVIEW_EVAL_CLAIM_SHA256`, `CUA_BRIDGES`, `PREVIEW_CUA_FIXTURE`, `PREVIEW_CUA_FIXTURE_OWNER` | a digest, the bridge's address and token, the seed's switch and the owner |

### The 48 hours

The clock starts at the first resource created, whichever cloud it is in, and is written down at that moment. At 48 hours, or at $50 as Azure's cost view shows it, or at any stop above, cleanup begins, whatever stage the work is in.

### Order

1. **Off the cloud:** the bundle (digest pinned), the configuration, `render`, the certificate (D3). No resource yet.
2. **Azure:** the resource group, network, address, VM. **The clock starts.**
3. **Stage and install:** deliver the bundle, the staged certificate and key, the scripts; `plan.sh`, `install.sh`, `journal.sh`, the root token (D2), `seal.sh`, the credential channel's `open`; D1's mapping.
4. **`start.sh`, then `status.sh`.** `denied` on every secret; each unit's state as systemd says.
5. **DNS:** the `A cua-eval` record, then wait for it to resolve, from the operator's machine, to the VM's address. At most 10 lookups.
6. **The Worker:** the web app built from the reviewed commit, `wrangler deploy -c wrangler.cua-eval.jsonc`, the claim digest, then the owner's claim and passkey (the browser, once), then `CUA_BRIDGES` and the seed, as `docs/cua-viewer-first-cloudflare.md` says.
7. **The qualification** (below).
8. **Cleanup.**

### The qualification, in numbers

Everything is by hand, one request at a time, each recorded with its time.

| Step | Calls | Shows |
| --- | --- | --- |
| Reachability: `POST https://cua-eval.ajac-zero.com/pim/observations/status` with no token, then a wrong token | 2, expect `401` | TLS, the mapping, the host, and that the bridge answers only the token |
| Pim as the owner, through the page: Watch | 1 launch, lifetime 10 minutes (`notAfter` at most 10 minutes after the record) | the page loads from the VM's own origin with no Pim cookie; the media socket needs the exact `Origin`; the frame's policy |
| Status | at most 5 | the launch's state; `closed_observed` is shown only when the host saw it |
| End | 1, and the dialog closing | the launch is revoked on the host; `CloseMedia` asked |
| End with the answer lost, deliberately | 1, once | the record stays `unconfirmed` and the next Watch is refused; the capability lasts at most until `notAfter` |
| The ordinary tools, while watched | the approvals the stand-in model files, a handful of `/tool` lines | shell, files and Chrome reach the VM through the relay; this is the stand-in's wiring, not an agent |

No call is retried automatically. A refusal, a `5xx`, a timeout or a result that isn't expected ends the qualification at that step. What isn't shown (a real model's agent, load, a second owner) is out of scope.

### Cleanup, in order, keeping the audit

Deleting anything settles nothing: a record left `unconfirmed` or blocked stays unresolved, and no later work continues from it under a new identity.

1. **Keep the evidence, read only, before anything is deleted:**
   - from the VM, a private read-only copy of `journal.json`, the tombstone, the units' state and the host's logs (which carry no request target);
   - from the Worker, the observation ledger's last state and the claim record, by the owner's existing read (the status call and the app's own view), saved as the response said it, not edited.
2. **Remove the credentials:** the Cloudflare secrets (`CUA_BRIDGES` first); the operator's copies of the evaluation's key and the sealed envelope.
3. **DNS before the address.** Remove `A cua-eval`, then **verify from at least two resolvers that it no longer answers** before the public IP is released, so no name is left pointing at an address someone else may receive.
4. **Azure:** delete the VM, its disk, the NIC, then the public IP, the NSG, the network, then the resource group; check the group is gone and read the cost view once, recording the total.
5. **Cloudflare, after the evidence:** remove the custom domain, delete the Worker (which deletes its Durable Objects: the claim record and the ledger go with them, which is why step 1 comes first and why it never authorizes a new claim), list each R2 bucket and delete only empty ones, delete the KV namespace, release the rate-limit namespaces. Check the account's dashboard shows none of the names above.
6. **Write down** what was created, what was deleted, the total spent on each cloud, and every record still unresolved.

## The fake-only specifications

`computer/cua-host/test/viewer-startup.test.ts` (new) uses no process (not even `bash -n`), no socket, no account of this machine, no real file but the repository's own pinned viewer files and lockfile, read-only, and generates an RSA key in memory. It covers: the configuration's `viewer` (optional; every refusal; the bridge unit's exact flags with the desktop's unit unchanged); the planner over a synthetic VM with a viewer (the extra files and marker, what it refuses); `start`'s refusals over a stand-in probe; provisioning over the in-memory file system (the order of operations, tombstone-first, a second run refused from the tombstone alone even with the journal gone, every failure leaving the tombstone and removing nothing, the produced journal opened by the host's own store as the bridge's account); the bundle (the pins, the package's integrity and name, refusals, wider bounds); `lockedPackageIntegrity` over the repository's lockfile; and the rendered scripts as text. **It has not been run**, so a failure in it is a finding. It is not on the earlier allowlist and has no accepted result; the earlier files' results (`journal-store` 17, `viewer-host` 29, the Worker fixture) are as recorded and say nothing about it.

## What is not claimed

No bundle was made, no script rendered or run, no VM, certificate, DNS name, Worker, secret or account created, and nothing was started, installed, built or type-checked. The artifact doesn't start the viewer on its own: D1 to D4 are open, and spacesd, the root token, the certificate and the base image are not here. The package's file names, `nft`'s presence, whether a Worker's `fetch` and a browser accept the certificate, whether `connect-src` with the explicit `wss:` origin loads the viewer in a real browser, and every cost, are unmeasured.
