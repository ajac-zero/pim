# Starting and qualifying the viewer-first preview on one VM: the plan

This is a plan for review, in prose. It is not a script. Nothing in it has been done, and nothing in it is authorized by being written down. It creates no cloud resource, certificate, DNS name, account, file or service. It doesn't touch main or deploy anything, and it runs no type check, build or install. Each stage below needs its own approval before anyone runs it. It gathers what `docs/cua-viewer-first-preview.md`, `docs/cua-viewer-first-worker.md`, `docs/cua-bridge.md`, `docs/cua-eval-install.md` and `docs/cua-eval-credentials.md` already say into one order. Where they leave something open, it says so and doesn't fill the gap.

## What must exist before a VM

### The pinned base

These are pinned only as far as the documents above pin them. Everything else is blocker 1 of the preview page, a gate of its own.

- **The operating system:** Ubuntu 24.04 booted with systemd, as `install.ts` checks.
- **The desktop:** a non-root `pim-desktop` account with a persistent graphical session (autologin, X server, D-Bus) on the display the bridge's `--viewer-display` names, `primary` by default.
- **Node:** 22.18 or later (`computer/cua-host/package.json`), one binary pinned by its exact version and SHA-256 in the installer's configuration.
- **The browser:** one Chrome binary pinned by its SHA-256. Its version isn't pinned anywhere yet.
- **Cua:** cua-spacesd 0.7.0, as built from trycua/cua at `fca2193`, the release the viewer's assets and schema are pinned to (`computer/cua-host/viewer-upstream.ts`). Its daemon doesn't run as root.
- **Packages:** `ws` 8.22.0 and `@bufbuild/protobuf` 2.15.0, each from a tarball checked against the SHA-512 in `pnpm-lock.yaml` at the bundle's commit.

What the base image is, how its session starts, whether spacesd 0.7.0 and its `/media` and viewer run on it, and whether Chrome's sandbox works for `pim-desktop` under Ubuntu 24.04's user-namespace restriction are all unchecked.

### Source still missing, each a separate reviewed change

The plan can't start until these exist, and none is written here:

1. **The bundle.** It must carry the viewer host. `operator.ts bundle` holds `bridge.ts`, `desktop.ts`, `session.ts` and `host.ts`, but not `viewer-host.ts`, `journal-store.ts`, `viewer-launch-manager.ts`, `viewer-lifetime.ts`, `viewer-adapter.ts`, `viewer-upstream.ts`, the pinned `cua-viewer/` assets with their licence, or `@bufbuild/protobuf`. A bridge started from today's bundle would refuse the viewer's settings at stage `viewer`.
2. **The bridge's unit.** It must take the viewer's settings. `install.ts` writes `bridge.ts --space --path --socket --host --port` only. The viewer needs, together, `--viewer-origin` (where spacesd answers on the VM), `--viewer-public-origin` (the bridge's own exact HTTPS origin), `--viewer-journal-dir` and `PIM_VIEWER_ROOT_TOKEN_FILE`. `--viewer-display` and `--viewer-embed-origin` are optional.
3. **The journal's provisioning step**, described under "The journal, made once".
4. **The root token's place**, described under "Two principals, and where each secret lives".
5. **The preview's sign-in route at a public origin.** The preview Worker answers `GET /__dev/sign-in/<username>` for any name. It signs the browser in as that person, existing accounts included, with no credential. At a public HTTPS origin, that would let anyone who can reach Pim sign in as the seeded owner, watch the desktop and answer its approvals. So before Pim is reachable over HTTPS, one of two things must happen: a reviewed change that turns the route off there, or a front that admits only the operator's browser. Which one is a decision for the preflight. Until then, Pim's HTTPS origin stays unreachable.

## Two principals, and where each secret lives

The VM has two accounts that matter, as `docs/cua-bridge.md` sets them up:

- **The bridge account** (`pim-bridge`) runs `bridge.ts`, and with it the viewer host. Its own `0700` directory holds three files, each its own and `0600`: the bridge's bearer token (`PIM_BRIDGE_TOKEN_FILE`, written by `seal`), and the TLS certificate and key.
- **The journal's directory** is also the bridge account's own, mode `0700`, holding `journal.json` (`0600`) and, while a host lives, `journal.lock`.
- **spacesd's root token:** the host reads it on each launch from the file `PIM_VIEWER_ROOT_TOKEN_FILE` names. That must be a regular file of the bridge account's, mode `0400` or `0600`, with one link and not reached through a link (`createRootTokenReader`). The bridge account isn't in any desktop group.
- **The desktop user** (`pim-desktop`) runs `desktop.ts`, pim-computer, Chrome and every agent command. It must not be able to read any of the bridge account's files: not the bearer token, the TLS key, the root token or the journal.

How spacesd gets its own credential, and whether the file the host reads holds the token spacesd accepts, is open. The plan doesn't choose. It requires only that the copy the host reads sits in the bridge account's directory under the rules above, and is never put in a flag, environment value, unit file, log or the bundle.

Pim's side holds only the bridge's URL and bearer token, in `CUA_BRIDGES`, in the operator's `preview.env` (`0600`, in a `0700` directory), as `docs/cua-eval-credentials.md` delivers it. The root token never leaves the VM. The browser gets only the launch's credential and attach tickets the host mints.

## Two separate HTTPS origins, chosen by the preflight

Two origins are needed, both exact, canonical and HTTPS, on different hosts:

- **Pim's origin.** This is the preview's `PIM_PUBLIC_URL`, and the host's `--viewer-embed-origin`.
- **The bridge's origin.** It is the origin of the bridge URL in `CUA_BRIDGES`, and the host's `--viewer-public-origin`. It includes the port when that isn't 443, such as `https://bridge.example:8443`; `:443` written out is refused.

Neither origin may have a wildcard, credentials, a path, query, fragment, uppercase letters or a trailing dot. No credential may be scoped to a parent domain they share. Pim's cookies are host-only (`__Host-`), which is a prerequisite here, not a guarantee.

Who picks the names, where TLS ends for Pim, and which certificates both use, so that the person's browser and the preview's `fetch` trust them, is for the Radia preflight. No portal origin is assumed. The local preview's `http://localhost:8787` stays refused for embedding: the listing says `local_http`, and the card says the desktop won't be shown. `--viewer-origin` is a third, different thing: where spacesd answers on the VM, which the browser never reaches.

## Pim over HTTPS, with a real owner session

The person opens Pim at its HTTPS origin directly, in the browser that will watch. The preview Worker serves the built web app there. That origin, and nothing else, must equal `PIM_PUBLIC_URL`: the preview also answers under other names, but the host lets only the embed origin frame the viewer.

The person registers and signs in with a real passkey made at that origin. The session that results is a real `__Host-pim-session` cookie.

What doesn't count as the owner's session:

- **Vite's dev server.** `pnpm dev:web` signs every request in with `PIM_API_TOKEN` through its proxy. Management refuses an API token, and the page would sit at Vite's origin, not the embed origin.
- **`/__dev/sign-in`.** It isn't used for the qualification. See source item 5 above.
- **`pnpm dev`.** It is never used, because it bills the remote Workers AI binding.

## The journal, made once

The host never creates its journal: `openJournalStore` refuses to, and a missing journal blocks the viewer for good. So someone with authority over the bridge account makes the first file once, as its own reviewed step, after `install` and before the first `start`:

1. Make the journal's directory as the bridge account's own, mode `0700`, refusing if anything is already at that path.
2. Create `journal.json` in it exclusively (`O_CREAT | O_EXCL | O_NOFOLLOW`), mode `0600`, holding the shape `initialJournal` states in `preview/cua-viewer-first.ts`: version 1, revision 1, a generation name, who made it and when, and no entries.
3. Flush the file and its directory.

The step never makes `journal.lock`. A lock that is there, live or left by a host that died, is refused and left in place: no stale-lock recovery is supported, so a host that died keeps its successor from starting. The step runs once per VM and is never run again: not after a failure, a loss, a left lock, an invalid file or a restart. A journal that is lost or blocked leaves the viewer blocked. Nothing makes a new journal, space, owner or identity to get past it.

## Bundle, install and start, in order

Each step is one approved action. The plan stops at the first refusal or surprise, and never resumes on the same VM: a failed install means a new VM, as `docs/cua-eval-install.md` says.

1. **Approvals.** The two origins and certificates (from the preflight), the VM and its account, the budget below, and the reviewed source items above.
2. **The bundle.** Made on the operator's machine at one exact commit of the review branch, with its tree digest recorded. Delivered to the VM, root-owned, beside the staged TLS files. How it travels is part of the delivery approval; no public URL is assumed.
3. **The base checks:** `plan.sh`, which changes nothing.
4. **Install:** `install.sh`. It makes the accounts, the socket group and directory, the bridge's files and the two units, enabled but not started.
5. **The journal:** made once, as above.
6. **The root token's file**, placed as above.
7. **The bridge token:** `seal` makes it on the VM, and the operator's `open` writes `preview.env` (`docs/cua-eval-credentials.md`).
8. **Start:** `start.sh` starts the desktop endpoint, then the bridge with the viewer's settings. `status.sh` then reads both units. The bridge must be active, with no `bridge.failed` in its log. The bridge logs nothing when it starts well, so whether the viewer can launch is first seen at the first Watch.
9. **Pim:** the preview starts with `preview.env` and its `PIM_PUBLIC_URL` set to Pim's HTTPS origin. The person signs in with a passkey there, and the fixture seeds that one space once, with its ledger. The listing must say `frame: "embeddable"` and `agent: "stand-in"`.

## The qualification, bounded

These steps come from the bounded plan in `docs/cua-viewer-first-worker.md`. Each is timed, recorded, and stops at the first unexpected result:

1. Watch, and see the desktop in the frame.
2. Check `Origin`, the frame's policy, and the media socket's bound.
3. Stop, then Check until `closed_observed`.
4. An end whose answer is lost on purpose. It must leave the record `unconfirmed` and refuse the next Watch.
5. The ordinary shell, files and Chrome still reach the VM through approvals while the person watches.

A real model is a later gate of its own. The stand-in model's `/tool` calls show the wiring, not an agent working the desktop.

## Cost, time and cleanup

The evaluation is bounded at **$15 and 48 hours, counted from the creation of its first cloud resource**, whichever comes first. The budget and how spend is read are part of the VM's approval. An alert isn't assumed to stop spending.

When either bound is reached, or the qualification ends or stops, the operator does three things in order:

1. **Keep the evidence, read only:** the ledger as the listing shows it, a copy of the journal, the bridge's and endpoint's logs, and the recorded steps. Nothing is edited.
2. **Remove the credentials:** stop the preview, and remove `preview.env` and the evaluation's key, as `docs/cua-eval-credentials.md` describes.
3. **Delete the VM and what the cloud keeps of it.** That takes the bridge token, root token and journal with it.

Pim's preview state, which holds the space's ledger, is not part of this cleanup. Its records stay as they are: an `unconfirmed` or blocked record is not settled by deleting the VM, the journal or the bridge, and no later observation continues from it under a new identity. A later evaluation is a new one, with its own approval, VM, key and seed.
