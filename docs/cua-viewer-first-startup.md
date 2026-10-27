# The Cua host's startup package, and the bounded live plan

This page is for review. It describes the source that makes the Cua host's VM startable for the isolated topology (Pim as a Cloudflare Worker, the Cua host on one Azure VM, the video direct from the VM to the person's browser), and the bounded live plan that would use it. **Nothing here has been run, fetched, built, installed, type-checked or deployed, and no resource exists.** The new tests are not run and are not accepted. Nothing is authorized by being written down: the live plan runs only on its own reviewed approval. Local Wrangler is closed and unsupported (`docs/cua-viewer-first-vm-plan.md`); `docs/cua-viewer-first-cloudflare.md` is the Worker's side. Budget, as given: Azure $50 in total within 48 hours of the first resource; Cloudflare's existing Workers Paid ($5 a month) within its included allowances only, with no incremental charge.

```diagram
 owner's browser ──passkey──▶ https://pim-cua-eval.ajac-zero.com   Cloudflare Worker `pim-cua-eval` (Pim; management only)
        │                                      │  launch / end / status (bridge bearer, x-pim-space)
        │                                      ▼
        └─ viewer page, RPC, media (capabilities, no Pim cookie) ─▶ https://cua-eval.ajac-zero.com  :443 (:80 for ACME only)
                                                                      Caddy (pim-ingress) ── TLS verified against the bridge's own certificate ──▶
                                                                      bridge 127.0.0.1:8443 (pim-bridge): relay + viewer host, journal, tokens
                                                                      spacesd 127.0.0.1:3211 (pim-desktop, view only)   pim-computer (pim-desktop)
```

## What is added

All of it is additive: a configuration with no `viewer` renders, plans, starts and bundles exactly as before.

| File | What it adds |
| --- | --- |
| `eval-install/config.ts` | The optional `viewer` field, `VIEWER_PATHS`, the bridge unit's flags, the **spacesd** and **Caddy** units, and `renderCaddyfile`. |
| `eval-install/install.ts` | With a viewer: the planner also needs the viewer's bundle files and the two pinned binaries (digests checked), makes the `pim-ingress` account, the ingress's and spacesd's directories and files, and both units; `start` starts inside out and refuses without what each needs; `status` reports them. It makes neither the journal nor the root token. |
| `eval-install/journal-provision.ts` | The one place a first journal and spacesd's root token are made, each once, as root: `journal`, `root-token`. |
| `eval-install/operator.ts` | `bundle ... --protobuf-tarball` carries the viewer, and `--source-dir` reads the sources from an unpacked archive instead of git (what the VM does); `render` writes five more scripts (`bridge-cert.sh`, `journal.sh`, `root-token.sh`, `fetch.sh`, `support.sh`) and `base-cloud-config.yaml`, only with a viewer, and only from complete pins. |
| `eval-install/pins.ts` (new) | The pinned artifacts: each one's HTTPS address, SHA-256 (npm packages: SHA-512 integrity) and size bound. Two pins are empty (see Delivery). |
| `origin.ts` (new) | `isHttpsOrigin`, moved out of `host.ts` (which re-exports it) so the operator's and the installer's programs, which run on the VM before `ws` exists, don't import the bridge. It is in the bundle's base sources, so a bundle's digest differs from one made before this change. |
| `journal-store.ts` | `withDescriptor` exported. |
| `preview/cua-viewer-first.ts` | An observation lasts 10 minutes. |
| `test/viewer-startup.test.ts` (new) | The fake-only specifications of all of it; `test/fake-journal-files.ts` gains `mkdir`, `chown`, `fchown`. |

### The configuration's `viewer`

```json
"viewer": {
  "origin": "http://127.0.0.1:3211",
  "publicOrigin": "https://cua-eval.ajac-zero.com",
  "embedOrigin": "https://pim-cua-eval.ajac-zero.com",
  "display": "primary",
  "spacesd": { "path": "/opt/pim-spacesd/bin/cua-spacesd", "sha256": "<the binary's SHA-256>", "version": "0.7.0" },
  "caddy": { "path": "/opt/pim-caddy/bin/caddy", "sha256": "<the extracted binary's SHA-256>", "version": "v2.11.7" },
  "backendName": "pim-cua-bridge.internal"
}
```

Each value is checked. `origin` is spacesd, plain HTTP on `127.0.0.1`; `publicOrigin` and `embedOrigin` are exact `https://host[:port]` origins (no wildcard, `:443`, path or uppercase) and differ; **`publicOrigin` has no port** (Caddy serves 443); **the bridge's `host` must be `127.0.0.1`**, so the bridge is private; the desktop must be headful; `backendName` is a DNS name that is neither the public host nor an address. They become the bridge's reviewed flags (`--viewer-origin … --viewer-public-origin … --viewer-embed-origin … --viewer-journal-dir /var/lib/pim-viewer --viewer-display primary`) and the units below. The bridge's relay path stays `bridge.path` (`/pim`), so the Worker's `CUA_BRIDGES` address is `https://cua-eval.ajac-zero.com/pim`.

## The ingress: Caddy

Standard Caddy, the version already pinned for celld (`deploy/celld/versions.env`: `CADDY_VERSION=v2.11.7`; its download's SHA-256 for linux/amd64 is `727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b`). That pin is for the release tarball: the operator verifies it, extracts `caddy`, and records the **binary's** SHA-256 in the configuration, which the planner checks. No celld secret, ingress header or configuration is reused: only the pin and the habit of running as its own account.

**The directives, read against v2.11.7's source** (not run): global `admin off`, `http_port`, `https_port`; the global `log { output stderr; level WARN; exclude … }`; `tls { issuer acme { disable_tlsalpn_challenge } }`; `request_body { max_size 16KB }`; `reverse_proxy` with `transport http { tls_server_name …; tls_trust_pool file … }` and `flush_interval -1` all exist in that release with those names. For an HTTPS upstream Caddy sends the upstream's address as `Host`, which the bridge ignores. A reading is not an acceptance: `support.sh` runs `caddy validate` on the installed file as `pim-ingress`, and `start` is not to follow a failed one.

`renderCaddyfile` writes the one file, `/etc/pim-ingress/Caddyfile`, for exactly the public host:

- **Certificate:** automatic for that name, by ACME HTTP-01 on port 80 (the TLS-ALPN challenge is off), so ports 80 and 443 are open inbound. Caddy answers plain HTTP only with its own redirect. Its admin API is off.
- **Forwarding:** only `/pim`, `/pim/observations/launch|end|status` and the adapter's `/<22 characters>/…` go to the bridge; everything else is `404`. One upstream, `https://127.0.0.1:8443`. No forward proxy, no other host, no header rewriting, no CORS header, no request body over 16 KB.
- **Backend TLS is verified, never skipped.** The bridge's certificate is its own, private, for `backendName`, generated on the VM (below); the installer writes its public part to `/etc/pim-ingress/bridge-cert.pem`, which is Caddy's only trust (`tls_trust_pool file`), and Caddy checks the name (`tls_server_name`). There is no `insecure_skip_verify`. The installer refuses a staged certificate that doesn't name `backendName`.
- **Same origin:** the viewer's page, calls and media socket are all this host, over WSS; `Origin` passes unchanged to the bridge, which requires it to be exactly the public origin.
- **No target or header logged:** access and proxy-error entries are excluded (the media ticket is in the query and the launch credential in a header); only Caddy's own warnings and errors reach the journal.

Caddy runs as its own account, `pim-ingress` (a system account of the bridge's kind: no login, no home, a locked password, no group but its own), with state in `/var/lib/pim-ingress` (`0700`, its alone: the ACME account and the certificate's key). Its unit has one capability, `CAP_NET_BIND_SERVICE`, to bind 80 and 443; the bridge's and the desktop's units have none, and no firewall redirect or load balancer is used.

### The bridge's own certificate, on the VM

`bridge-cert.sh` (root, once) makes a new `0700` staging directory and runs `openssl req -x509` for an ECDSA P-256 key and a self-signed certificate valid 3 days, with `CN` and the one subject alternative name `backendName`, `serverAuth`, not a CA. **Its key is born on the VM and never travels**; the installer's existing staging, check and copy then put it at `/etc/pim-bridge/` (`0600`, the bridge's) and its public part at Caddy's trust file. This replaces the earlier "public certificate must be delivered" blocker: the public certificate is Caddy's, obtained by ACME on the VM.

## spacesd

### Provenance (read from GitHub, not downloaded)

- Tag `cua-spacesd-v0.7.0` is commit `fca21937bc4e1420a23d544d11dbdf987f0266e6`, the commit the viewer pins use; the release was published 2026-10-21T19:38:42Z by `github-actions[bot]`.
- The Linux x86_64 asset `cua-spacesd-x86_64-unknown-linux-gnu` is 121,121,848 bytes with GitHub's asset digest `sha256:78622428711f3778127ad661ba2976ae27bf23ae5e05439d60d5b95511c808fd`. That digest is what the configuration pins (`viewer.spacesd.sha256`). Beside it the release has a `.sha256`, a `.sigstore.json`, a `SHA256SUMS` and its bundle, all from the same workflow, so the `.sha256` is not an independent root: the pin is the digest recorded at review, with the Sigstore bundle verified off the VM, which is not done here.
- It is built in a `debian:11` container, so glibc compatibility with Ubuntu 24.04 is plausible; its shared-library needs are **not verified** (the base's package list is a proposal).
- It is too large for the bundle's tarball bounds, so it is a root-owned pinned file at its own path, delivered like Node and the browser.

### How it runs, and where its token is

The token is spacesd's **root token**: it authorizes every service (Process, Filesystem, Computer, Driver, Teleport, Tunnel, `/mcp`) and keys every ticket and signed URL. Whoever holds it has the authority of spacesd's own account, and "view only" is a property of the tickets the adapter asks for, not of the token. So the decision is whose authority spacesd has:

- **Placement A, implemented:** spacesd runs as `pim-desktop`. That is the desktop's own authority, which agents already have, so the token gives them nothing more. The bridge keeps its own `0600` copy for the viewer host, and the value is **known to the desktop account by design**; `status`'s `denied` check covers the bridge's file, not the value. The management token, the bridge's TLS key, Caddy's state and every cloud credential stay outside the desktop.
- **Placement B, not implemented:** a separate `pim-spacesd` account whose token agents can't read. It would need that account to reach the desktop's X display (an X authorization grant, untested), a fifth account and more checks. If the desktop must not know this token, this is the change.

Either way spacesd is never root and gets no `Delegate`, no `--allow-guest-power`, no `--insecure-bootstrap`, no `--await-token-file`. The unit:

```
ExecStart=/opt/pim-spacesd/bin/cua-spacesd serve --listen 127.0.0.1:3211 --quic-port 0 --no-mcp --no-driver --cursor-probe false --token-file /etc/pim-spacesd/token --data-dir /var/lib/pim-spacesd
```

`--listen` is required: with a token the default is `0.0.0.0:3211`. QUIC (UDP 3212) is off, `/mcp` and the driver are off because native tools stay off, and the pointer probe is off so nothing moves the real pointer. The token file is `/etc/pim-spacesd/token`, the desktop's own `0600` file in a root-owned directory. `DISPLAY` and the session bus are the desktop unit's.

### The root token, made once

`root-token.sh` runs `journal-provision.ts root-token` as root: 32 random bytes as 43 characters of unpadded base64url (spacesd takes 16 to 4096), written to two files, each created exclusively and flushed: the bridge's `/etc/pim-bridge/viewer-root-token` (`0600`, the bridge's, in its own `0700` directory) and spacesd's `/etc/pim-spacesd/token` (`0600`, the desktop's). It is never printed, logged, put in an argument or variable, or sent anywhere, and it never leaves the VM: the Worker needs only the management token. It replaces, rotates and removes nothing; if either file exists it refuses, and a failure after the first file leaves it and blocks `start`. A second try is a new VM.

## The secrets, and who can read them

| Secret | Where | Who | How it gets there |
| --- | --- | --- | --- |
| The bridge's bearer token (management) | `/etc/pim-bridge/token`, `0600` | `pim-bridge` | made by `seal` (`docs/cua-eval-credentials.md`); reaches the Worker only as `CUA_BRIDGES` |
| The bridge's own TLS key | `/etc/pim-bridge/key.pem`, `0600` | `pim-bridge` | born on the VM by `bridge-cert.sh`, staged root `0700`, copied by the installer |
| The public TLS key and ACME account | `/var/lib/pim-ingress`, `0700` | `pim-ingress` | made by Caddy on the VM |
| spacesd's root token, bridge's copy | `/etc/pim-bridge/viewer-root-token`, `0600` | `pim-bridge` | made once by `root-token.sh` |
| spacesd's root token, its own file | `/etc/pim-spacesd/token`, `0600` | `pim-desktop` (by design, placement A) | the same step |
| The journal, and its tombstone | `/var/lib/pim-viewer/journal.json` (`0600`, `0700` directory); `/etc/pim-eval/journal-provisioned` (root's, `0444`, no secret) | `pim-bridge`; root | made once by `journal.sh` |
| `CUA_BRIDGES`, the claim digest | Cloudflare secrets | whoever can read the Worker's secrets | operator; **TLS and cloud credentials are never in them** |

The viewer's own capabilities (the launch credential and attach tokens) are minted per launch by the adapter and are none of these secrets.

## The journal, made once, with its tombstone

Unchanged: `journal.sh` makes `/etc/pim-eval/journal-provisioned` first (`O_EXCL`, root's, `0444`, never removed, replaced or rewritten by this tooling), then the journal's directory and the journal (`0700`, `0600`, the bridge's), flushing each; never the lock, never an open of an existing journal. With the tombstone there, no journal is ever made again for this VM, whatever became of the first; recovery, a reset, a new journal, space or identity are not offered, and deleting anything settles no record. `start` refuses without the journal, the tombstone and the root token as they must be, and with a `journal.lock` left behind.

## The base

`render` also writes `base-cloud-config.yaml`, cloud-init user data for the VM's creation:

- the desktop account `pim-desktop`, UID 1500 (above an Azure admin user's 1000), no sudo, no password, no group but its own;
- the X11 packages, `openssl`, `curl`, and every package Google's Chrome 156 package lists as a dependency, by their Ubuntu 24.04 names (`t64` where that release renamed them: `libasound2t64`, `libatk1.0-0t64`, `libgtk-3-0t64`, …; `operator.ts` `BASE_PACKAGES`), by name from the Ubuntu archive at first boot, **not pinned by version**;
- lingering for the account, so it has `/run/user/1500` and its session bus; and two system units run as that account: Xvfb on `:0` at 1920x1080x24 with no TCP, then `openbox`.

spacesd captures X11 (or Hyprland): GNOME and KDE Wayland, Ubuntu's default session, are unsupported by it, which is why the base is Xvfb. The base installs none of the pinned programs. Whether the list is enough, spacesd's real shared-library needs, whether Chrome runs as this account with its sandbox on (Ubuntu 24.04 restricts unprivileged user namespaces by AppArmor; its `chrome` profile is the usual way through), and the OpenH264 software encoder's behavior are **unverified until `support.sh` has run on the VM**, which is its purpose.

## Delivery, and the support checks

Delivery is ordinary startup source, not an executive decision: `fetch.sh` (root, once, written, **never run here**) brings every pinned file to the VM, with no credential, no SSH, and nothing from the cloud's user data. Every artifact comes from its publisher over HTTPS only (no downgrade, TLS 1.2 or later, no proxy, no `curl` configuration file) in one request with no retry, and must answer `200`, be within its size bound (exactly its size where that is pinned) and match its pinned digest **before one byte is unpacked**. Then it stages everything in `/var/lib/pim-cua-fetch` (new, root's, `0700`, which must not exist; removed on exit, the original failure still reported, a failed removal reported too), unpacks without restoring any owner, drops Chrome's setuid helper bit, checks that no staged file is group- or world-writable or setuid, **checks each unpacked program against the digest the configuration records**, builds the bundle from the pinned archive with the staged Node (`operator.ts bundle --source-dir`, no git) and checks its tree digest against `bundle.sha256`, and only then publishes each into place **without ever replacing**: a file by a hard link (`ln -P -T`), which the kernel refuses if the destination exists however it came to; a directory by an exclusive `mkdir` of its destination and then the same, entry by entry, under it. `mv` is not used: its rename replaces an existing regular file (and an empty directory), so a check for absence before it would not be a guarantee, and `mv -n` would skip with a zero exit. The hard link needs the stage and the destinations on one filesystem, as on the base; on two it fails and copies nothing. Afterwards the placed programs and the bundle are checked again against the same digests. If anything fails once placing has begun, **the stage and whatever was placed are kept as evidence** (`partial-placement-kept`), nothing resumes from them, and the next run refuses on both: that VM is discarded. A tree entry whose name falls outside letters, digits and `._@+-` also fails closed, which may stop a package that has an unusual name; that is a finding, not a switch.

| Artifact | From | Pin |
| --- | --- | --- |
| Node v22.18.0 | `nodejs.org/dist/v22.18.0/node-v22.18.0-linux-x64.tar.gz` | SHA-256 `a2e70372…8c8a`, from the release's own `SHASUMS256.txt`; the extracted `bin/node` is `node.sha256` |
| Caddy v2.11.7 | the GitHub release's `caddy_2.11.7_linux_amd64.tar.gz` | SHA-256 `727b9170…4f8b` (celld's pin); the extracted binary is `viewer.caddy.sha256` |
| spacesd 0.7.0 | the `cua-spacesd-v0.7.0` release's Linux x86_64 asset | SHA-256 `78622428…08fd` and exactly 121,121,848 bytes; the same digest is `viewer.spacesd.sha256` |
| Chrome 156.0.8078.47-1 | Google's apt pool, `google-chrome-stable_156.0.8078.47-1_amd64.deb` | SHA-256 `6c92cd22…7ac8` and exactly 144,849,192 bytes (from Google's own `Packages`); the extracted `chrome` is `browser.sha256`; only `/opt/google/chrome` is kept |
| The bundle's sources | `codeload.github.com/ajac-zero/pim/tar.gz/<commit>` | **the commit and the archive's SHA-256: not pinned yet** |
| `ws` 8.22.0, `@bufbuild/protobuf` 2.15.0 | the npm registry's tarballs | SHA-512 integrity, as `pnpm-lock.yaml` has it (the bundle build checks the lockfile too) |

Google keeps only the current Chrome in its pool, so the Chrome pin may stop resolving; if so `fetch.sh` fails on `status`, and a new pin is a new review.

### The missing pins, exactly, and the procedure that fills them

`render` refuses (`pin-missing:repository-commit,repository-sha256`) until the archive pin is filled into `pins.ts`, and refuses a pin for any commit other than the configuration's (`pin-commit`). Nothing below has been done.

**Two commits, so the hash does not chase itself.** The archive's SHA-256 can't be written inside the commit it hashes. So:

- **B, the bundle commit:** an already reviewed commit that has all the code `fetch.sh` runs (`operator.ts` with `bundle --source-dir`, `config.ts`, `origin.ts`, the bundle sources) and **empty** archive pins. B is the configuration's `commit` and the archive's commit. Once chosen, B is final; nothing is amended into it. Its own `pins.ts` is not in the bundle and is never run on the VM.
- **P, the pin commit:** a later commit, B plus one change to `pins.ts` (`repository: { commit: B, sha256: <the archive's> }`) and this page. The scripts are rendered from P, so P is what is reviewed and accepted; the VM runs P's scripts and B's bundle.

**Procedure, for the operator, off the VM and the cloud, in a new empty scratch directory** (run only on a reviewed approval, by hand, one step at a time):

1. Choose B, a full 40-character commit that is an ancestor of P and has been accepted. Record it with where it came from (the review that accepted it).
2. Download `https://codeload.github.com/ajac-zero/pim/tar.gz/<B>` once, over HTTPS, with no credentials, and record the HTTP status, the byte count and the SHA-256. **A second machine repeats step 2 independently; the two digests must match**, or GitHub's bytes are not stable enough to pin and the bundle needs another delivery (a decision, not a workaround).
3. Check the archive is B and only B's tree: unpack it into the scratch directory and compare its file list and each file's SHA-256 with `git ls-tree -r <B>` and `git cat-file` of the same commit from a clone. Any difference stops the procedure.
4. Fill `pins.ts` as P above, and record each program's digest in the configuration (next step).

**The extracted programs' digests** (`node.sha256`, `browser.sha256`, `viewer.caddy.sha256`), by the same two-machine rule, each from an archive that first matches its pin in this page:

| Program | Take the SHA-256 of | Unpack with |
| --- | --- | --- |
| `node.sha256` | `bin/node` | `tar -xzf node-v22.18.0-linux-x64.tar.gz --strip-components=1` |
| `viewer.caddy.sha256` | `caddy` | `tar -xzf caddy_2.11.7_linux_amd64.tar.gz caddy` |
| `browser.sha256` | `opt/google/chrome/chrome` | `dpkg-deb --extract google-chrome-stable_156.0.8078.47-1_amd64.deb <dir>` |

None of these publishers lists a digest for the extracted program, so each is derived, and its trust is the archive's pin plus the two matching unpackings. `viewer.spacesd.sha256` is already the pinned asset's own digest. The bundle's `bundle.sha256` is `operator.ts bundle --commit <B> ...` followed by `digest`, off the VM, also twice. The configuration is then complete, and `render` can be run for P; until then it can't.

### `support.sh`: what acceptance of the startup includes

Root, read-only, after `install.sh` and before `start.sh`; it starts no service and opens no port, prints one JSON line per check and exits nonzero if any failed: every `BASE_PACKAGES` entry installed (`dpkg-query`); no `not found` from `ldd` for Node, Caddy, spacesd and Chrome (a static program has none to miss); Node and Caddy at the configured versions; **`caddy validate` of the installed Caddyfile as `pim-ingress`**; spacesd answering `--help` as `pim-desktop` (clap's default; a failure here may be the flag, not the program); and `chrome --headless=new --dump-dom about:blank` as `pim-desktop` **with the sandbox on**, in a profile made and removed by the script. A failure of any is a stop, not a note: Chrome refusing without `--no-sandbox` means Ubuntu's AppArmor restriction needs its `chrome` profile for `/opt/google/chrome/chrome`, which is a finding to bring, not a switch to flip. `pim-computer` itself passes `--no-sandbox` only as uid 0, so under the desktop account the sandbox stays on.

## The bounded live plan

It runs only on a reviewed approval of this whole page and **stops at the first refusal, surprise or bound, with no retry.** No upload, no model, no load generation, no OAuth provider; one owner, one passkey, one launch.

### Proposed resources

Names are proposals for isolation; no ID, address or subscription is invented here.

| Where | Resource | Name | Note |
| --- | --- | --- | --- |
| Azure | Resource group | `pim-cua-eval-rg` | one group, so one deletion removes everything |
| Azure | Virtual network, one subnet | `pim-cua-eval-vnet` | nothing peered |
| Azure | Network security group | `pim-cua-eval-nsg` | inbound **80/tcp (ACME) and 443/tcp** only; no SSH, no 8443, no 3211; commands go by Run Command |
| Azure | Public IP, Standard, static | `pim-cua-eval-ip` | static so the DNS record stays true |
| Azure | NIC, VM, OS disk | `pim-cua-eval-nic`, `pim-cua-eval-vm`, `pim-cua-eval-osdisk` | Ubuntu 24.04; size chosen against the $50 bound from Azure's calculator, not assumed here; admin login by an unused key |
| Azure | Nothing else | | no Bastion, load balancer, NAT gateway, Log Analytics, backup or Defender plan |
| DNS | `A cua-eval` → the VM's address | in the `ajac-zero.com` zone | **DNS only, no proxy**: ACME HTTP-01 and the video reach the VM direct |
| Cloudflare | The Worker and its Durable Objects | `pim-cua-eval` | custom domain `pim-cua-eval.ajac-zero.com`; `wrangler.cua-eval.jsonc` |
| Cloudflare | KV namespace | `pim-cua-eval-oauth` | `OAUTH_KV` |
| Cloudflare | R2 buckets | `pim-cua-eval-blobs`, `pim-cua-eval-artifacts` | |
| Cloudflare | Rate-limit namespaces | two chosen integers | not created |
| Cloudflare | Secrets | `PREVIEW_EVAL_CLAIM_SHA256`, `CUA_BRIDGES`, `PREVIEW_CUA_FIXTURE`, `PREVIEW_CUA_FIXTURE_OWNER` | a digest, the bridge's address and token, the seed's switch and the owner |

### The 48 hours

The clock starts at the first resource created, whichever cloud it is in, and is written down at that moment. At 48 hours, or at $50 as Azure's cost view shows it, or at any stop above, cleanup begins, whatever stage the work is in.

### Order

1. **Off the cloud:** the bundle (digest pinned), the pinned binaries' digests, the configuration, `render`. No resource yet.
2. **Azure:** the resource group, network, address, VM with `base-cloud-config.yaml`. **The clock starts.** The VM's address is known.
3. **DNS:** the `A cua-eval` record; wait for it to resolve to the VM's address (at most 10 lookups). It comes before Caddy starts, so ACME can validate.
4. **Deliver and install:** `fetch.sh`; `bridge-cert.sh`, `plan.sh`, `install.sh`, `journal.sh`, `root-token.sh`, `seal.sh`, the credential channel's `open`; then **`support.sh`, which must pass.**
5. **`start.sh`, then `status.sh`:** inside out (desktop endpoint, spacesd, bridge, Caddy last). Caddy gets its certificate on its first start by ACME; one order, no retry by hand. `denied` on every bridge secret; each unit's state as systemd says; the certificate's names (the host only).
6. **The Worker:** the web app built from the reviewed commit, `wrangler deploy -c wrangler.cua-eval.jsonc`, the claim digest, then the owner's claim and passkey (the browser, once), then `CUA_BRIDGES` and the seed, as `docs/cua-viewer-first-cloudflare.md` says.
7. **The qualification** (below).
8. **Cleanup.**

### The qualification, in numbers

Everything is by hand, one request at a time, each recorded with its time.

| Step | Calls | Shows |
| --- | --- | --- |
| Reachability: `POST https://cua-eval.ajac-zero.com/pim/observations/status` with no token, then a wrong token; then a `GET` of `/` | 3, expect `401`, `401`, `404` | the public certificate, Caddy, the verified backend TLS, that only the allowed paths reach the bridge, and that it answers only the token |
| Pim as the owner, through the page: Watch | 1 launch, lifetime 10 minutes (`notAfter` at most 10 minutes after the record) | the page loads from the VM's own origin with no Pim cookie; the media socket needs the exact `Origin`; the frame's policy |
| Status | at most 5 | the launch's state; `closed_observed` is shown only when the host saw it |
| End | 1, and the dialog closing | the launch is revoked on the host; `CloseMedia` asked |
| End with the answer lost, deliberately | 1, once | the record stays `unconfirmed` and the next Watch is refused; the capability lasts at most until `notAfter` |
| The ordinary tools, while watched | the approvals the stand-in model files, a handful of `/tool` lines | shell, files and Chrome reach the VM through the relay; this is the stand-in's wiring, not an agent |

No call is retried automatically. A refusal, a `5xx`, a timeout or a result that isn't expected ends the qualification at that step. What isn't shown (a real model's agent, load, a second owner) is out of scope.

### Cleanup, in order, keeping the audit

Deleting anything settles nothing: a record left `unconfirmed` or blocked stays unresolved, and no later work continues from it under a new identity.

1. **Keep the evidence, read only, before anything is deleted:** from the VM, a private read-only copy of `journal.json`, the tombstone, the units' state and the host's logs (which carry no request target); from the Worker, the observation ledger's last state and the claim record, by the owner's existing read, saved as the response said it, not edited.
2. **Remove the credentials:** the Cloudflare secrets (`CUA_BRIDGES` first); the operator's copies of the evaluation's key and the sealed envelope.
3. **DNS before the address.** Remove `A cua-eval`, then **verify from at least two resolvers that it no longer answers** before the public IP is released, so no name is left pointing at an address someone else may receive.
4. **Azure:** delete the VM, its disk, the NIC, then the public IP, the NSG, the network, then the resource group; check the group is gone and read the cost view once, recording the total.
5. **Cloudflare, after the evidence:** remove the custom domain, delete the Worker (which deletes its Durable Objects: the claim record and the ledger go with them, which is why step 1 comes first and why it never authorizes a new claim), list each R2 bucket and delete only empty ones, delete the KV namespace, release the rate-limit namespaces. Check the account's dashboard shows none of the names above.
6. **Write down** what was created, what was deleted, the total spent on each cloud, and every record still unresolved.

## The source and test manifest

Source added or changed (all unrun): `computer/cua-host/eval-install/config.ts`, `install.ts`, `journal-provision.ts`, `operator.ts`, `pins.ts` (new); `computer/cua-host/origin.ts` (new) and `host.ts` (the function moved, re-exported); `computer/cua-host/journal-store.ts` (one `export`); `preview/cua-viewer-first.ts`; `docs/cua-viewer-first-startup.md`, `docs/cua-eval-install.md`, `docs/cua-viewer-first-preview.md`, `docs/cua-viewer-first-worker.md` (the 10 minutes).

Test: `computer/cua-host/test/viewer-startup.test.ts` (new, with `fake-journal-files.ts` extended), **not run and not on any accepted allowlist; run only after an independent audit of its imports.** It uses no process (not even `bash -n`), no socket, no account of this machine, and no real file but the repository's pinned viewer files and lockfile, read-only; it generates an RSA key in memory. Its groups: the configuration's `viewer` and every refusal; the bridge, spacesd and Caddy units, exact; the Caddyfile as text (the one host, the path allowlist, the verified backend, nothing forbidden); the planner over a synthetic VM (the extra steps in order, every refusal); `start`'s refusals over a stand-in probe; the accounts and the four-unit check; provisioning of the journal and of the root token over the in-memory file system (order, modes, owners, tombstone-first, nothing replaced, every failure leaving what was made); the bundle's pins; the delivery's pins (against the lockfile, and the two empty ones refused), `fetch.sh` and `support.sh` as text, and that the operator's imports reach no `ws`; the rendered scripts, `bridge-cert.sh` included, as text; and the base cloud-init data. A positive check of `checkBackendName` against a real certificate isn't in it, since Node can't make one without `openssl`: the live step is its only positive test.

## What is not claimed

No bundle was made, no script rendered or run, no VM, certificate, DNS name, Worker, secret or account created, and nothing was started, installed, built or type-checked. The viewer does not start on this source alone: two pins are empty (above), the extracted programs' digests are the operator's to record, and `fetch.sh` and `support.sh` have never run, so the package list, spacesd's libraries and behavior under Xvfb, Chrome's sandbox, Caddy's acceptance of its file and every cost are unmeasured. Placement A makes the root token known to the desktop account.
