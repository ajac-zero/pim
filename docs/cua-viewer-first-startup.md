# The Cua host's startup package, and the bounded live plan

This page is for review. It describes the source that makes the Cua host's VM startable for the isolated topology (Pim as a Cloudflare Worker, the Cua host on one Azure VM, the video direct from the VM to the person's browser), and the bounded live plan that would use it. **No script here has been run on a VM, nothing has been deployed, and no resource exists.** What has been done is recorded under "Evidence recorded so far": the fake-only tests (the latest, 54 of 54 at `afc9371`, in an independent run; two earlier runs failed and are kept) and the off-VM assembly of the pins and the bundle on two machines, which executed no downloaded program. The tests as they stand at this page's commit are not yet run, and none is an acceptance of the source. Nothing is authorized by being written down: the live plan runs only on its own reviewed approval. Local Wrangler is closed and unsupported (`docs/cua-viewer-first-vm-plan.md`); `docs/cua-viewer-first-cloudflare.md` is the Worker's side. Budget, as given: Azure $50 in total within 48 hours of the first resource; Cloudflare's existing Workers Paid ($5 a month) within its included allowances only, with no incremental charge.

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
| `eval-install/install.ts` | With a viewer: the planner also needs the viewer's bundle files and the two pinned binaries (digests checked), makes the `pim-ingress` account, the ingress's and spacesd's directories and files, and both units; `start` starts inside out and refuses without what each needs, and sends no `start` to spacesd or the ingress unless systemd says it has **never run** (a unit running is left alone; one that failed, exited, is changing or can't be read refuses with `viewer-unit-state`: reboot or discard, no restart); `status` reports them. It makes neither the journal nor the root token. |
| `eval-install/journal-provision.ts` | The one place a first journal and spacesd's root token are made, each once, as root: `journal`, `root-token`. |
| `eval-install/operator.ts` | `bundle ... --protobuf-tarball` carries the viewer, and `--source-dir` reads the sources from an unpacked archive instead of git (what the VM does); `render` writes five more scripts (`bridge-cert.sh`, `journal.sh`, `root-token.sh`, `fetch.sh`, `support.sh`) and `base-cloud-config.yaml`, only with a viewer, and only from complete pins. |
| `eval-install/pins.ts` (new) | The pinned artifacts: each one's HTTPS address, SHA-256 (npm packages: SHA-512 integrity) and size bound. The bundle commit B and its archive's digest are filled in (see Delivery). |
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

Delivery is ordinary startup source, not an executive decision: `fetch.sh` (root, once, written, **never run on a VM**) brings every pinned file to the VM, with no credential, no SSH, and nothing from the cloud's user data. Every artifact comes from its publisher over HTTPS only (no downgrade, TLS 1.2 or later, no proxy, no `curl` configuration file) in one request with no retry, and must answer `200`, be within its size bound (exactly its size where that is pinned) and match its pinned digest **before one byte is unpacked**. Then it stages everything in `/var/lib/pim-cua-fetch` (new, root's, `0700`, which must not exist; removed on exit, the original failure still reported, a failed removal reported too), unpacks without restoring any owner, drops Chrome's setuid helper bit, checks that no staged file is group- or world-writable or setuid, **checks each unpacked program against the digest the configuration records**, builds the bundle from the pinned archive with the staged Node (`operator.ts bundle --source-dir`, no git) and checks its tree digest against `bundle.sha256`, and only then publishes each into place **without ever replacing**: a file by a hard link (`ln -P -T`), which the kernel refuses if the destination exists however it came to; a directory by an exclusive `mkdir` of its destination and then the same, entry by entry, under it. `mv` is not used: its rename replaces an existing regular file (and an empty directory), so a check for absence before it would not be a guarantee, and `mv -n` would skip with a zero exit. The hard link needs the stage and the destinations on one filesystem, as on the base; on two it fails and copies nothing. Each tree's listing (directories, then everything else, NUL-separated and sorted) is first written to a file in the stage by a pipeline run under `pipefail` in a subshell whose failure `fetch.sh` observes, bounded to 16 MiB, checked for plain names, **all before the first placement** (a process substitution feeding a loop would not report a failing `find` or `sort`, and is not used). The loops read those files, and afterwards each placed tree's own listing is compared byte for byte with the staged one (`cmp`), so a missing library or file fails, not only a missing executable; the placed programs and the bundle are then checked again against their digests. If anything fails once placing has begun, **the stage and whatever was placed are kept as evidence** (`partial-placement-kept`), nothing resumes from them, and the next run refuses on both: that VM is discarded. A tree entry whose name falls outside letters, digits and `._@+-` also fails closed, which may stop a package that has an unusual name; that is a finding, not a switch.

| Artifact | From | Pin |
| --- | --- | --- |
| Node v22.18.0 | `nodejs.org/dist/v22.18.0/node-v22.18.0-linux-x64.tar.gz` | SHA-256 `a2e70372…8c8a`, from the release's own `SHASUMS256.txt`; the extracted `bin/node` is `node.sha256` |
| Caddy v2.11.7 | the GitHub release's `caddy_2.11.7_linux_amd64.tar.gz` | SHA-256 `727b9170…4f8b` (celld's pin); the extracted binary is `viewer.caddy.sha256` |
| spacesd 0.7.0 | the `cua-spacesd-v0.7.0` release's Linux x86_64 asset | SHA-256 `78622428…08fd` and exactly 121,121,848 bytes; the same digest is `viewer.spacesd.sha256` |
| Chrome 156.0.8078.47-1 | Google's apt pool, `google-chrome-stable_156.0.8078.47-1_amd64.deb` | SHA-256 `6c92cd22…7ac8` and exactly 144,849,192 bytes (from Google's own `Packages`); the extracted `chrome` is `browser.sha256`; only `/opt/google/chrome` is kept |
| The bundle's sources | `codeload.github.com/ajac-zero/pim/tar.gz/<commit>` | B, `afc9371a75f1c21b3b22627222b9791ef283692d`, and SHA-256 `582716ed…aae8` (2,693,038 bytes), pinned |
| `ws` 8.22.0, `@bufbuild/protobuf` 2.15.0 | the npm registry's tarballs | SHA-512 integrity, as `pnpm-lock.yaml` has it (the bundle build checks the lockfile too) |

Google keeps only the current Chrome in its pool, so the Chrome pin may stop resolving; if so `fetch.sh` fails on `status`, and a new pin is a new review.

### The missing pins, exactly, and the procedure that fills them

B and its archive's SHA-256 are now in `pins.ts` (the pin commit P is the commit that adds them, with this page; B itself is unchanged). `render` refuses (`pin-missing:…`) if either is ever empty again, and refuses a configuration whose `commit` is not B (`pin-commit`). The procedure below is what produced them; it was run as recorded under "The second machine".

**Two commits, so the hash does not chase itself.** The archive's SHA-256 can't be written inside the commit it hashes. So:

- **B, the bundle commit:** an already reviewed commit that has all the code `fetch.sh` runs (`operator.ts` with `bundle --source-dir`, `config.ts`, `origin.ts`, the bundle sources) and archive pins that were empty then. B is the configuration's `commit` and the archive's commit. Once chosen, B is final; nothing is amended into it. Its own `pins.ts` is not in the bundle and is never run on the VM.
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

### Evidence recorded so far (not pins)

- **Test run at `243988f`:** an independent, fake-only `node --test` of `viewer-startup.test.ts` **passed 44 of 46 and failed 2** (two assertions, exit 1, 693.69 ms) and was stopped, with no retry. Both were over-broad substring checks in the test, not in the scripts: `"| sh"` matched the legitimate `| sha256sum` of the tree digest, and `"curl"` matched the package name `libcurl4t64`. The test now detects command words (a pipe into a shell interpreter; `curl` or `wget` run as a command) and a test of those detectors shows unsafe samples rejected and the legitimate ones accepted. The fixed file has not been run.
- **Rerun at `ef10895`:** the file **failed before any test ran** (0 tests, exit 1, 271 ms): `ERR_INVALID_TYPESCRIPT_SYNTAX` at `operator.ts:592`, unescaped backticks in a bash comment inside the `renderFetch` template. Its `find -printf '%P\0'` and one `printf` `\n` also had single backslashes, which a template turns into a real NUL and newline; all are now escaped (`\\0`, `\\n`), and the test asserts the rendered script holds no NUL and no newline inside a `printf` format. The fixed source has not been run.
- **Run at `95150a8`:** the same file **passed 48 of 48** (11 suites, 1056.56 ms, exit 0, no skip, cancel or todo), fake-only, run by an independent reviewer.
- **Run at `afc9371`:** **passed 54 of 54** (12 suites, 900.74 ms, exit 0, no skip, cancel or todo), same boundary. These pass the fake and text specifications only; no script has been run, so they say nothing about a real VM.
- **Independent off-VM preparation (reported, by public download and extraction, no program executed):** the Node, Caddy and Chrome archives matched their pins above, against Node's published SHA-256, Caddy's official SHA-512 checksums and Google's `Packages` SHA-256; no signature was verified. The archive of `243988f` had SHA-256 `086c6faf831e449529db0e76e4293c6e3771a5a6dcea7e3c51b57198bcc452e6`, and its 431 blobs matched git. That archive is of a commit that is not the bundle commit B, so **it is not the pin**.
- **Derived program digests** (the same values were derived again on a second machine; see "The second machine"): `bin/node` `ccacb2d6d87ba6d118b2bffc1ae33747a05cc5fc6b1f1ec4fc1d420b687e952d`; `caddy` `678ade3bfc088749c81a681adc603333ee0bb023b6a6cfe3c0f58bef8ff854e9`; Chrome's `chrome` `95dc9473b4f904cb3ab0800fc7206081fcae12abc094a088bd741a13f1747b72`. They are the values for the operator's configuration (`node.sha256`, `viewer.caddy.sha256`, `browser.sha256`).

### The bundle-source candidate: `afc9371a75f1c21b3b22627222b9791ef283692d`

Selected as the immutable bundle-source candidate **B**. No further source change goes into B; anything later is the pin commit P or after (above). What was derived from it, once, off the VM and the cloud, by the reported local steps (already-installed Node, the exact git objects and the verified npm archives; no compilation, install, lifecycle script or downloaded program executed):

| Item | Value |
| --- | --- |
| Bundle tree digest (`operator.ts bundle`, then `digest`) | `5c7764a89e785f1e150ac6d64622ddb69a5aed68410a7298b71c11d01078e7b4` |
| The same, recomputed independently in Python from the output's manifest (389 files, 422 entries) | the same value |
| GitHub's codeload archive of B, fetched fresh | HTTP 200, 2,693,038 bytes, SHA-256 `582716ed2cac76e546980d0e856160e45e6b5f64e2dfde0aa2b2173b3236aae8`; all 431 file and symlink entries match their git blob hashes |

The first derivation was on one machine. The second, below, is what the procedure required.

### The second machine (done once, assembly only)

Run on a different machine from the first (a separate orb: hostname `e2b.local`, working directory `/home/user/workspace/repo`, its own filesystem; `/home/sprite/pim` does not exist there), with its already-installed Node `v26.12.1` (nothing installed), by plain `curl`, `tar`, `dpkg-deb`, `sha256sum`, `sha512sum` and Node running the reviewed `operator.ts`. **No downloaded program was executed**: the archives were hashed and unpacked, the three programs were only hashed, and nothing was built, type-checked or installed. Stage: a new `0700` directory `/tmp/pim-pin-second-1793125633` (kept as evidence). Each download used `curl -q --noproxy '*' --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 5 --fail --retry 0 --max-time 300`, one attempt, the same flags `fetch.sh` uses, and every command returned 0.

| Download | HTTP | Bytes | Digest | Equals the pin |
| --- | --- | --- | --- | --- |
| Node v22.18.0 linux-x64 | 200 | 54,824,343 | SHA-256 `a2e70372…8c8a` | yes |
| Caddy v2.11.7 linux_amd64 | 200 | 18,113,754 | SHA-256 `727b9170…4f8b` | yes |
| Chrome 156.0.8078.47-1 `.deb` | 200 | 144,849,192 | SHA-256 `6c92cd22…7ac8` | yes |
| B's codeload archive | 200 | 2,693,038 | SHA-256 `582716ed2cac76e546980d0e856160e45e6b5f64e2dfde0aa2b2173b3236aae8` | yes, equal to the first machine's |
| `ws` 8.22.0 | 200 | 35,094 | SHA-512 = the lockfile's integrity | yes |
| `@bufbuild/protobuf` 2.15.0 | 200 | 243,826 | SHA-512 = the lockfile's integrity | yes |

Unpacked without executing: `bin/node` `ccacb2d6…952d`, `caddy` `678ade3b…54e9`, `opt/google/chrome/chrome` `95dc9473…7b72`, each **equal to the first machine's**; the source archive unpacked to 431 files and links. Then, with the installed Node, `operator.ts bundle --commit B --source-dir <the unpacked archive> --ws-tarball … --protobuf-tarball …` (the way `fetch.sh` builds it) and `operator.ts digest` both gave `5c7764a89e785f1e150ac6d64622ddb69a5aed68410a7298b71c11d01078e7b4`, **equal to the first machine's**; the same bundle built from B's git objects (the way the first machine did) was byte-identical to it (`diff -r`), 389 files and 422 entries. The first machine's Node version is not recorded here, so whether the two Nodes differ is not known; the digest is of files and modes, not of Node.

**Verified by two machines:** the archive pins, the three extracted-program digests, and `bundle.sha256` `5c7764a8…78e7b4`. **Not verified, and not claimed:** that either machine's network path was not intercepted at the same moment (each trusted the publishers' TLS and the pins, and no signature was checked); that a different Node 22.18.0 gives the same bundle (`fetch.sh` uses the pinned one, and this has not been run); anything about a VM.

### Before provisioning, and during the qualification

**Blockers to creating any resource** (all now met by source, or a decision, and none by a run on a VM): the pins above; the configuration's digests (the table above) and `bundle.sha256`; this page and the Worker's pages reviewed; the approval of gate 2 below. **Not blockers; these are what the qualification is for, and are not proven beforehand:** whether Caddy gets its certificate and serves the viewer's page and WebSocket over TLS to the backend; Chrome's sandbox as the desktop account; spacesd's libraries and behavior; `support.sh` and `fetch.sh` themselves; `render` of the final scripts on the operator's machine; and the observed cleanup. Each is a step of the live plan with its own bound, and a failure there ends the evaluation at that step without a retry.

## The live gates, consolidated

Nothing below is open. Each is a separate gate with its own explicit approval, taken in order, and passing one opens nothing after it. The numbers are the page's own, not new ones.

| Gate | What it is | Exactly what it is limited to |
| --- | --- | --- |
| 1. Pins | two-machine derivation of B's archive digest, the three extracted-program digests and `bundle.sha256`; commit P | off the VM and the cloud; no resource |
| 2. Resources | the proposed names in the table below, no others, no IDs invented | **Azure $50 total within 48 hours of the first resource** (pre-tax, from Azure's cost view, with the VM size chosen against it); **Cloudflare's existing Workers Paid $5/month within included allowances only, no incremental charge**; the 48-hour clock is written down at the first creation, in either cloud |
| 3. Delivery and install | `fetch.sh`, `bridge-cert.sh`, `plan.sh`, `install.sh`, `journal.sh`, `root-token.sh`, `seal.sh`, then `support.sh` | `support.sh` runs the delivered programs (Node, Caddy, spacesd, Chrome and `ldd`'s loader) and is **its own approval**, not part of the delivery's |
| 4. Start | `start.sh`, `status.sh`; Caddy's one ACME order | no retry by hand; `viewer-unit-state` ends it, there is no restart |
| 5. Worker | the reviewed commit's web build, one `wrangler deploy`, the owner's claim and passkey (once), then `CUA_BRIDGES` and the seed | nothing else created |
| 6. Qualification | the table in the live plan: one owner, one launch, 10 minutes, 3 reachability calls, at most 5 Status calls before and 2 after, one End whose reply is deliberately lost; no ordinary tools and no successful-reply End | no upload, no model, no load generation, no automatic retry; stops at the first refusal, surprise or bound |
| 7. Cleanup | the ordered list in the live plan: evidence first, credentials, **DNS removed and verified from two resolvers before the IP is released**, Azure, then Cloudflare | unresolved records and tombstones are kept and reported, never abandoned under a new identity |

**What a timeout is, and isn't.** The `timeout` around `support.sh`'s checks, and any limit in the qualification, bounds how long a check is *waited for* and then signals the command (and, with `--kill-after`, kills it). It is **not** proof that the command's children are gone, that the system is quiet, or that a service did not change something before it was stopped: a program that started its own session or process group can outlive it. Nothing here is a termination or quiescence claim; the cleanup list's own inventory is the only thing that settles what exists.

### `support.sh`: what acceptance of the startup includes

Root, after `install.sh` and before `start.sh`; it starts no service and opens no port, writes only a profile directory it removes, but **it is not read-only data inspection: `ldd` runs the dynamic loader in the binary's context, and the version, `caddy validate`, spacesd and Chrome checks run the delivered programs.** It is therefore part of the whole validation that needs its own explicit approval later; it was not run and is not covered by the artifact-preparation approval. **It stops at the first failed check** (nothing after it runs; the profile directory is still removed, and a failed removal is reported beside the failure, never in place of it), printing one JSON line per check. **Every program it runs is bounded** by `timeout` (kill 5 seconds later): `ldd`, versions and `caddy validate` 20–30 seconds, spacesd `--help` 20, Chrome 60. The checks: every `BASE_PACKAGES` entry installed (`dpkg-query`); for each of Node, Caddy, spacesd and Chrome, `ldd` exits 0 with no `not found`, and **any other outcome fails**, including a loader error or an unreadable binary; the single exception is Caddy's output being exactly `not a dynamic executable` with status 1 (Caddy's release build is Go without cgo, so static is expected, which has not been seen; if it is dynamic it is checked like the others, and if its ldd says anything else it fails); Node's `--version` exactly the configured version and Caddy's `version` starting with it; **`caddy validate` of the installed Caddyfile as `pim-ingress`**; spacesd answering `--help` as `pim-desktop` (clap's default; a failure here may be the flag, not the program); and `chrome --headless=new --dump-dom about:blank` as `pim-desktop` **with the sandbox on**, in a profile made and removed by the script. A failure of any is a stop, not a note: Chrome refusing without `--no-sandbox` means Ubuntu's AppArmor restriction needs its `chrome` profile for `/opt/google/chrome/chrome`, which is a finding to bring, not a switch to flip. `pim-computer` itself passes `--no-sandbox` only as uid 0, so under the desktop account the sandbox stays on.

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
| Status, before the End | at most 5 | the launch's state; `closed_observed` is shown only when the host saw it |
| **End, with its reply deliberately lost** | exactly 1, as this launch's only End, no retry | the request is sent and the reply is not received (the caller's connection is cut after the send; the exact cut is fixed in the approval of this gate, and if there is no semantically sound way to make it, this step is dropped and the End below is run instead). The record is read afterwards by Status (at most 2 calls): the expected, and the only claim, is that it stays `unconfirmed` and is not shown closed. Whether the host revoked the launch is read from the host's own journal after, not assumed. |
| End with the reply received | **not run; deferred.** A second End on a launch whose first End is already terminal or known closed cannot show uncertainty, and a new launch breaks the one-launch bound, so there is no replay and no second launch | a successful-reply End is its own later qualification |
| Ordinary shell, files and Chrome tools | **not run; not qualified.** They are not part of the initial viewer run | the viewer is qualified, not the ordinary tools, which reach the VM through the existing relay and have their own later qualification with exact counts |

Whole run: one owner, one launch (lifetime 10 minutes, `notAfter` at most 10 minutes after the record), 3 reachability calls, at most 5 Status calls before and 2 after, 1 End. That a later Watch is refused while the record is `unconfirmed` is covered by the fake tests and not exercised live.

No call is retried automatically, and the first call whose result is not the expected one stops the qualification, with cleanup starting from that step. A refusal, a `5xx`, a timeout or a result that isn't expected ends the qualification at that step. What isn't shown (a real model's agent, the ordinary tools, a successful-reply End, load, a second owner) is out of scope and is not claimed.

**Timeouts and cleanup.** A check that `timeout` ended is a stop, and that VM is not reused. `timeout` only signals the command it started: cleanup after it is **confirmed** only when the termination of that command and of everything the account started for the check has been observed (the account's process list for it, read before cleanup), and otherwise is recorded **uncertain**, which does not block deleting the VM but is reported with the evidence, never as clean.

### Cleanup, in order, keeping the audit

Deleting anything settles nothing: a record left `unconfirmed` or blocked stays unresolved, and no later work continues from it under a new identity.

1. **Keep the evidence, read only, before anything is deleted:** from the VM, a private read-only copy of `journal.json`, the tombstone, the units' state and the host's logs (which carry no request target); from the Worker, the observation ledger's last state and the claim record, by the owner's existing read, saved as the response said it, not edited.
2. **Remove the credentials:** the Cloudflare secrets (`CUA_BRIDGES` first); the operator's copies of the evaluation's key and the sealed envelope.
3. **DNS before the address.** Remove `A cua-eval`, then **verify from at least two resolvers that it no longer answers** before the public IP is released, so no name is left pointing at an address someone else may receive.
4. **Azure:** delete the VM, its disk, the NIC, then the public IP, the NSG, the network, then the resource group; check the group is gone and read the cost view once, recording the total.
5. **Cloudflare, after the evidence:** remove the custom domain, delete the Worker (which deletes its Durable Objects: the claim record and the ledger go with them, which is why step 1 comes first and why it never authorizes a new claim), **account for each R2 bucket against the evaluation's own inventory**: list its objects, delete exactly those the evaluation created (named in the approved inventory) and then the bucket if it is empty; a bucket that still holds anything else, an object that can't be deleted, or a listing that can't be read leaves cleanup **uncertain**, the bucket in place and reported, never skipped as if it were empty; delete the KV namespace, release the rate-limit namespaces. Check the account's dashboard shows none of the names above.
6. **Write down** what was created, what was deleted, the total spent on each cloud, and every record still unresolved.

## The source and test manifest

Source added or changed (tested only by the fake specifications named below; run on no VM): `computer/cua-host/eval-install/config.ts`, `install.ts`, `journal-provision.ts`, `operator.ts`, `pins.ts` (new); `computer/cua-host/origin.ts` (new) and `host.ts` (the function moved, re-exported); `computer/cua-host/journal-store.ts` (one `export`); `preview/cua-viewer-first.ts`; `docs/cua-viewer-first-startup.md`, `docs/cua-eval-install.md`, `docs/cua-viewer-first-preview.md`, `docs/cua-viewer-first-worker.md` (the 10 minutes).

Test: `computer/cua-host/test/viewer-startup.test.ts` (new, with `fake-journal-files.ts` extended), **the revision at this page's commit has not been run; the revisions at `95150a8` (48 of 48) and `afc9371` (54 of 54) were, fake-only, after an independent audit of its imports, and earlier ones failed (above). Any rerun is for the independent reviewer, under the same boundary.** It uses no process (not even `bash -n`), no socket, no account of this machine, and no real file but the repository's pinned viewer files and lockfile, read-only; it generates an RSA key in memory. Its groups: the configuration's `viewer` and every refusal; the bridge, spacesd and Caddy units, exact; the Caddyfile as text (the one host, the path allowlist, the verified backend, nothing forbidden); the planner over a synthetic VM (the extra steps in order, every refusal); `start`'s refusals over a stand-in probe; the accounts and the four-unit check; provisioning of the journal and of the root token over the in-memory file system (order, modes, owners, tombstone-first, nothing replaced, every failure leaving what was made); the bundle's pins; the delivery's pins (against the lockfile, B's and its archive's, and every empty or mismatched pin refused), `fetch.sh` and `support.sh` as text, and that the operator's imports reach no `ws`; the rendered scripts, `bridge-cert.sh` included, as text; and the base cloud-init data. A positive check of `checkBackendName` against a real certificate isn't in it, since Node can't make one without `openssl`: the live step is its only positive test.

## What is not claimed

No script was rendered for a VM or run on one, and no VM, certificate, DNS name, Worker, secret or account created. The off-VM assembly built the bundle and hashed the programs on two machines, and the fake tests pass; nothing was started on a VM, and no type-check or build of the product was run for this page. The viewer does not start on this source alone: `fetch.sh` and `support.sh` have never run on a VM, so the package list, spacesd's libraries and behavior under Xvfb, Chrome's sandbox, Caddy's acceptance of its file and every cost are unmeasured. Placement A makes the root token known to the desktop account.
