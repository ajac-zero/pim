# Pim on celld (beta)

[celld](https://celld.dev) runs Cloudflare Workers and Durable Objects on your own machines, and keeps their state in a bucket you own. This page runs Pim on one celld node at home or on a small server: a fresh install, from a commit of this repository, behind your own TLS proxy. Everything it uses is in [`deploy/celld/`](../deploy/celld/).

**This is a beta, on a beta.** celld v0.6.3 calls itself beta and not safe for hostile multi-tenant use. Pim on celld has been run end to end only on a disposable machine, with a stand-in bucket and a stand-in model (see [What has been checked](#what-has-been-checked)). Real passkeys in a browser on a real domain, sign-in with Google, GitHub or OpenID Connect, apps' OAuth (Gmail, Drive, Spotify, GitHub), real model providers, the ChatGPT plan, MCP clients and the computer companion have **not** been checked on celld. Use it for yourself and people you trust, and keep backups.

It needs a commit with Pim's celld runtime (`PIM_RUNTIME=celld`, [Trusted ingress](#trusted-ingress)); `deploy.sh` refuses an earlier one. Out of scope here: moving a Pim from Cloudflare to celld or back (there is no import), and more than one node.

## How it fits together

```
 Browser, apps                 This machine
┌──────────────┐  HTTPS/WSS   ┌────────────────────────────────────────────────────────────┐
│ pim.example  │─────────────▶│ Caddy :443 (deploy/celld/caddy/Caddyfile)                   │
│ .com         │              │  TLS; sets X-Pim-Client-IP and X-Pim-Ingress-Secret         │
└──────────────┘              │   │ HTTP                                                    │
                              │   ▼                                                         │
                              │ celld 127.0.0.1:8080  public listener: the Worker           │
                              │   src/index.ts, Durable Objects Pim, Auth, Directory,       │
                              │   Gallery, KV pim-oauth, R2 pim-blobs and pim-artifacts,    │
                              │   the web app (web/dist)                                    │
                              │ celld 127.0.0.1:8081  peer and operator API, no auth        │
                              │ /var/lib/celld        local working copy, not a backup      │
                              └───────────────────────────────┬────────────────────────────┘
                                                              │ S3 API, HTTPS
                                                              ▼
                              ┌────────────────────────────────────────────────────────────┐
                              │ Fleet bucket (R2, S3, GCS, Tigris, Azure), prefix pim/      │
                              │  every database, file, KV value, deployment and secret      │
                              └────────────────────────────────────────────────────────────┘
```

The bucket is the Pim. A write is answered only once it is in the bucket (one node has no peer to hold it sooner), and a node that starts against the bucket picks up where the last one stopped. Its credentials control everything in it, so give them access to this bucket only.

## What differs from Cloudflare

[`deploy/celld/wrangler.jsonc`](../deploy/celld/wrangler.jsonc) is `wrangler.jsonc`'s Worker, the production `src/index.ts` (never `preview/worker.ts`), with the same Durable Objects and migrations, `OAUTH_KV`, `BLOBS`, `ARTIFACTS`, and `ASSETS` with the same worker-first routes and single-page fallback. celld refuses the rest of `wrangler.jsonc`, so the profile leaves it out, and Pim runs without it:

| Left out | On celld |
| --- | --- |
| `ai` (Workers AI) | No platform model. The admin adds a model provider for everyone, or each person their own ([Models](#models)). `PIM_UTILITY_MODEL` and `PIM_IMAGE_MODEL` are `off`; `generate_image` isn't offered |
| `ratelimits` | Pim's celld runtime keeps its rate limits in the Directory instead, by the address in the proxy's `X-Pim-Client-IP` (an IPv6 address counts by its /64), with no binding to add |
| `version_metadata` | No claim window: under `PIM_RUNTIME=celld` nobody can claim the Pim anonymously after a deploy. The admin claims it with the setup link the Worker writes to celld's log ([Install](#install)) |
| `send_email` | celld has no Email Workers: Pim sends no email |
| `observability` | The Worker's console, Pim's `pim.*` events among it, goes to celld's log: `journalctl -u celld` |
| `keep_vars` | No dashboard: variables and secrets come from your files on every deploy ([Variables and secrets](#variables-and-secrets)) |
| `build` | `build.sh` builds the web app explicitly |
| `workers_dev`, `preview_urls` | Your proxy gives Pim its address |

celld also has an always-empty Cache API, doesn't compress (Caddy does, for the web app's files), and gives `request.cf` no edge fields. [celld's compatibility page](https://celld.dev/docs/cloudflare-compat) lists the rest. `deploy/celld/test/config.check.mjs` fails when `wrangler.jsonc` gains or loses a key, so each change gets a decision here.

## Pins

Every input of a build is pinned, so a commit builds the same way anywhere:

- celld v0.6.3, the SHA-256 of each platform's download, and the commit its build attestation must name, in [`deploy/celld/versions.env`](../deploy/celld/versions.env). `install-celld.sh` refuses anything else.
- Node.js (`.nvmrc`), pnpm (`packageManager` in `package.json`) and every package, esbuild among them, from `pnpm-lock.yaml`. `build.sh` refuses another Node.js major or pnpm, and bundles with the esbuild Wrangler would use.
- Caddy v2.11.7 and its SHA-256, for the proxy.

`build.sh` builds from `git archive` of one commit, never the working tree, and builds the web app in an environment emptied of everything but `PATH` and `HOME`, so no `VITE_*` variable or secret of the operator's can end up in the files it serves. It records the toolchain, a hash of `web/dist`, and the deployment version celld computes before any variable is added, in `build-info.json`. Two builds of one commit must give the same two hashes:

```sh
deploy/celld/build.sh "$COMMIT" /tmp/a && deploy/celld/build.sh "$COMMIT" /tmp/b
diff /tmp/a/build-info.json /tmp/b/build-info.json     # no output: the same build
```

## Install

On a Linux machine (x86-64 or ARM64) with ports 80 and 443 reachable, and DNS for your Pim's hostname pointing at it. Choose the hostname first: passkeys belong to it, and moving later means everyone makes new ones.

1. **A bucket.** One celld qualifies: Cloudflare R2, Amazon S3, Google Cloud Storage, Tigris or Azure Blob Storage (MinIO, Backblaze B2, Hetzner and DigitalOcean Spaces are not; see celld's [object storage](https://celld.dev/docs#configure-object-storage)). Make credentials that reach only this bucket.
2. **celld.** As root, from a checkout of this repository:

   ```sh
   deploy/celld/install-celld.sh /opt/celld        # checks the SHA-256, and the attestation if gh is signed in
   useradd --system --home-dir /var/lib/celld --shell /usr/sbin/nologin celld
   install -d -m 700 /etc/celld /etc/pim
   install -m 600 deploy/celld/env/celld.env.example /etc/celld/celld.env   # then fill in the bucket
   cp deploy/celld/systemd/celld.service /etc/systemd/system/
   ```

   `celld.env` keeps both of celld's listeners on loopback, trusts the proxy's `X-Forwarded-Host` and `-Proto`, and waits for the bucket on every write. Building and deploying also need git, and Node.js and pnpm at the pinned versions, on this machine or another that can reach the bucket.
3. **Build** a commit (any machine with the pinned toolchain; it touches no bucket):

   ```sh
   deploy/celld/build.sh "$(git rev-parse origin/main)"     # prints where it built, ~/.cache/pim-celld/builds/<commit>
   ```

   A second argument chooses where. `build.sh` deletes that directory first when it holds an earlier build, so it refuses a symbolic link, `/` and top-level directories, anything in or above the repository, your home directory and anything above it, and an existing directory without its marker.
4. **Variables and secrets.** Copy [`env/pim.env.example`](../deploy/celld/env/pim.env.example) to `/etc/pim/pim.env` and set `PIM_PUBLIC_URL`. Copy [`env/secrets.env.example`](../deploy/celld/env/secrets.env.example) to `/etc/pim/secrets.env` (`chmod 600`) if you use any secret. Make the ingress secret and the [app credentials key](#app_credentials_key), once each:

   ```sh
   deploy/celld/gen-ingress-secret.sh /etc/pim/ingress.env
   deploy/celld/gen-app-credentials-key.sh /etc/pim/app-credentials-key
   ```
5. **Deploy** the build:

   ```sh
   deploy/celld/deploy.sh ~/.cache/pim-celld/builds/<commit> --vars /etc/pim/pim.env \
     --ingress-secret /etc/pim/ingress.env --secrets /etc/pim/secrets.env \
     --app-credentials-key /etc/pim/app-credentials-key --celld-env /etc/celld/celld.env
   ```
6. **Start the node**, and check it locally: `systemctl enable --now celld`, then `curl -s 127.0.0.1:8080/.well-known/celld/health` gives `{"ok":true}`.
7. **The proxy.** Install Caddy v2.11.7 (your distribution's package if it is that version, or the release in `versions.env` with its SHA-256), copy [`caddy/Caddyfile`](../deploy/celld/caddy/Caddyfile) to `/etc/caddy/Caddyfile`, change the hostnames (and delete the content host's block if you don't use public links), install [`caddy/pim-ingress.conf`](../deploy/celld/caddy/pim-ingress.conf) as `/etc/systemd/system/caddy.service.d/pim-ingress.conf` so Caddy has the ingress secret, and start it. It gets certificates itself. Until Caddy runs with the secret, Pim answers 403.
8. **Claim the Pim.** Open your address. With no admin, the sign-in screen asks the Worker for a setup link; read it from the log and open it, within the hour:

   ```sh
   journalctl -u celld --since -10m | grep -o 'Pim setup link.*'
   ```

   Pick a username, save the recovery codes and make a passkey: you are the admin. The same command finds the admin's own setup link later, if they lose every passkey. Anyone who can read the journal can claim an unclaimed Pim, so keep it to admins (`systemd-journal` group).
9. **A model.** In Settings → Model → Providers, add one for everyone ([Models](#models)).

## Variables and secrets

There is no dashboard: `deploy.sh` reads four files on every deploy, and a change is a new deploy, which nodes adopt within 30 seconds without a restart. Settings → Deployment still shows the admin what each variable is and any Pim can't read.

- **`pim.env`**: the variables in [docs/reference.md's Deploy table](reference.md#deploy), such as `PIM_PUBLIC_URL`, `PIM_REGISTRATION` and the `PIM_LIMIT_*` limits, and `PIM_OIDC_ISSUER`. Nothing secret: `deploy.sh` refuses a name that looks like one there.
- **`secrets.env`**, mode 600: OAuth clients' IDs and secrets, apps' secrets, an OTLP collector's headers.
- **`ingress.env`**, mode 400: `PIM_INGRESS_SECRET`, alone, which Caddy reads too ([Trusted ingress](#trusted-ingress)).
- **`app-credentials-key`**, mode 400: [`APP_CREDENTIALS_KEY`](#app_credentials_key), alone.

**The format**, for these files and `celld.env` alike: one `NAME=value` per line, the name in capitals, the value exactly as written, and comments on lines of their own that start with `#`. A value can't hold quotes, backslashes, `$`, backticks, spaces or characters beyond ASCII, and a line can't start with whitespace or `export`, or end in a carriage return: those mean something different to systemd (which reads `celld.env` and `ingress.env`) or a shell, so they are refused, never changed. Don't `source` these files in a shell, where characters such as `;` or `&` that systemd keeps as they are mean something else; `deploy.sh` reads `celld.env` with the same rules and exports each value without a shell reading it.

`deploy.sh` refuses a secret file others can read, a name in two files, a name that is a binding's, `PIM_INGRESS_SECRET` and `APP_CREDENTIALS_KEY` anywhere but their own files, an ingress secret shorter than 32 visible ASCII characters or equal to the app credentials key, and `PIM_RUNTIME` anywhere (the profile sets it), and prints the names it sets, never their values.

### Where secrets go

celld v0.6.3 has no store for secrets: every variable is a plain-text binding in the deployment's manifest, `deploy/pim/<version>/manifest.json` in the bucket, and the Worker reads it from there. So:

- **In the bucket**, readable by whoever has its credentials, who already controls everything else in it, people's data among it. Each deployment's manifest keeps the values it was deployed with: deploying a new secret doesn't remove the old one from older manifests, and celld v0.6.3 has no command to delete an old deployment. After a leak, revoke the secret where it was issued, so the old value is useless.
- **In every copy of the bucket**, backups among them: encrypt them ([Backup](#backup-and-restore)).
- **Not** in this repository (only examples without values are committed, and `config.check.mjs` checks they stay so), **not** in the Worker's bundle (the profile has no `define`), **not** in the web app's files, and **not** on disk after a deploy: `deploy.sh` writes the configuration with them only inside the build, mode 600, and deletes it when `celld deploy` returns. `run-scratch.sh` checks the bucket and the build for three random secrets (a canary, the ingress secret and the app credentials key) after a deploy, and finds them in the manifest only.
- **In the operator's files** in `/etc/pim`, and on the machine that runs `deploy.sh`.

### APP_CREDENTIALS_KEY

The key that encrypts people's sign-ins to apps Pim implements (Gmail and Google Drive need it; Spotify's are encrypted with it once it's set). Make it once per Pim, on the machine that deploys:

```sh
deploy/celld/gen-app-credentials-key.sh /etc/pim/app-credentials-key     # prints its fingerprint
```

It never replaces an existing key. Back it up **apart from the bucket's backups**, such as in a password manager or offline, with its fingerprint: the bucket holds it too (in each manifest), but the copy you deploy from is yours to keep. To check a copy: `tr -d '\n' < COPY | sha256sum | cut -c1-16` prints the same fingerprint. Losing it, or deploying another, makes everyone connect those apps again; nothing else is lost.

## Models

celld has no Workers AI, so a fresh Pim has no model until someone adds one, and chats say so. In Settings → Model → Providers → Add provider (see [Model providers](reference.md#model-providers)):

- **A service's API**: Anthropic, OpenAI API, Google Gemini, OpenRouter, DeepSeek, Mistral, Groq or xAI, with its API key. The admin can add it for everyone ("Everyone on this Pim can use it"); its tokens then count against members' limits.
- **A model on your network**: a custom endpoint speaking OpenAI's `/chat/completions`, such as llama.cpp's `llama-server` (with `--jinja` and a large `-c`), LM Studio, Ollama or vLLM, at an address the celld machine reaches, such as `http://192.168.1.20:8080/v1`. Pim talks with tool calls, so the model needs dependable tool calling and a large context.
- **The ChatGPT plan**, each person in their own Settings (see [ChatGPT plan](instance.md#joining) for OpenAI's terms).

Side jobs such as naming chats use a provider's model that answers in a JSON schema, once someone picks one as the utility model. Image generation stays off: it is Workers AI's.

The first provider's first model is the default until someone chooses another. Only the custom-endpoint path has been exercised on celld, with a stand-in.

## Public artifact links

Links are off until `PIM_CONTENT_ORIGIN` names a second hostname that shares no cookies with the app's (another registrable domain is best; see [artifacts](artifacts.md#public-links)). The Caddyfile's second site sends only its `/p/*` and `/artifact-runtime/*` to celld and answers everything else with 404, so nothing of the app, its API or its sign-in is served there.

## The proxy

[`caddy/Caddyfile`](../deploy/celld/caddy/Caddyfile) is the only way in:

- **Listeners.** celld's public listener and its peer and operator API (which has no authentication) are on loopback, and Caddy's admin API on `localhost:2019`. With the proxy on another machine, put `CELLD_ADDR` on a private address (WireGuard, Tailscale), never a public one, and keep `CELLD_INTERNAL_ADDR` on loopback. celld's own `/.well-known/celld/health` is answered 404 from outside; check it on the machine.
- **Ingress secret and client address.** On every request it sets `X-Pim-Ingress-Secret` from its environment and `X-Pim-Client-IP` to the connection's address, one bare IPv4 or IPv6 address, replacing whatever the client sent. It drops `CF-Connecting-IP` and every other header a client could use to claim an address (`True-Client-IP`, `X-Real-IP`, `Forwarded`, `CF-IPCountry` and the like). Behind another proxy (a router's, a tunnel's) the address Pim sees is that proxy's.
- **Scheme and host.** It replaces `X-Forwarded-For`, `-Host` and `-Proto` with its own, and celld must trust the last two (`CELLD_TRUST_FORWARDED_HEADERS=1`). Checked on celld v0.6.3: without it, `request.url` stays `http://` even with `X-Forwarded-Proto: https`, so Pim, at an `https://` address, refuses everything (421); with it, celld takes the last value of each header, so the proxy's replaces any a client sent.
- **Streams and WebSockets.** Responses go out as they come (`flush_interval -1`); WebSockets pass through, and survive a reload for 5 minutes. Only the web app's files are compressed: compressing an event stream would hold its events back.

`deploy/celld/test/proxy.check.mjs` runs this file as it is in front of a stand-in for celld and checks each of these.

## Trusted ingress

With `PIM_RUNTIME=celld`, which the profile sets, Pim answers only requests that come through your proxy:

- Each request must carry `X-Pim-Ingress-Secret` with `PIM_INGRESS_SECRET`, at least 32 visible ASCII characters and not the app credentials key. Without it, or with another, Pim answers 403.
- The client's address is `X-Pim-Client-IP`, set by the proxy: one bare IPv4 or IPv6 address, never a list. Anything else is 400. An IPv4 address mapped into IPv6 counts as the IPv4 address, and an IPv6 address counts by its /64.
- Pim strips `X-Pim-Ingress-Secret`, `X-Pim-Client-IP` and `CF-Connecting-IP` before anything else reads the request, so none reaches a person's space or an app.
- A missing or unreadable `PIM_INGRESS_SECRET` is a configuration error: 503 for everything. `deploy.sh` refuses to deploy without one.

So even a mistake in the network, such as celld's listener reachable from the LAN, doesn't let anyone claim another address or skip the proxy into the Worker. The web app's own files (`/`, `/assets/*`), which celld serves without the Worker, answer there regardless; they hold nothing of anyone's. The secret lives in `/etc/pim/ingress.env` (mode 400, root's), which `deploy.sh` and Caddy (through its systemd drop-in) both read, and in the deployment's manifest in the bucket. Back it up with `/etc/pim`; losing it costs nothing but making a new one.

**Rotating it** briefly refuses requests, because Pim takes one secret at a time: make a new file, deploy, and restart Caddy right after.

```sh
deploy/celld/gen-ingress-secret.sh /etc/pim/ingress.env.new && mv /etc/pim/ingress.env.new /etc/pim/ingress.env
deploy/celld/deploy.sh <build> ... --ingress-secret /etc/pim/ingress.env && systemctl restart caddy
```

Until the node adopts the new deployment (up to 30 seconds), requests with the new secret get 403; a `POST 127.0.0.1:8081/reload` on the machine adopts it at once. The old secret stays in the older deployment's manifest, where it opens nothing.

What has been checked: `proxy.check.mjs` checks the Caddyfile's side (both headers always set, the client's values never passed on, a bare `::1` for an IPv6 client, and the secret absent from the config Caddy's admin API serves). `run-scratch.sh` checks Pim's side past the proxy: 403, 400 and 421 as above, and the Directory's sign-in limit (30 attempts a minute per address, an IPv6 /64 counted as one, an IPv4-mapped IPv6 address as its IPv4 address). Both passed with the runtime applied ([What has been checked](#what-has-been-checked)). The 503 for a missing secret is covered by the Worker's tests, not here: `deploy.sh` won't deploy one.

## Updating

**Pim.** Build the new commit and deploy it. Nodes adopt it within `CELLD_DEPLOY_POLL_S` (30 s); requests under way finish on the old version, and a Durable Object moves when it is idle (at most 60 s later, when celld closes its WebSockets with 1012 and the app reconnects). Going back is deploying an older build, but celld doesn't migrate stored data back, and Pim changes its tables in place as it starts (adding and renaming columns), which an older version may not read. Take a backup before every update, read the commits between the two before going back, and restore the backup if they changed how Pim stores anything. Going back hasn't been tested.

**celld.** Read its [upgrade notes](https://celld.dev/docs#upgrade-notes) between the two versions, update `versions.env`, run `run-scratch.sh` with the new binary, then on the machine: `systemctl stop celld`, `install-celld.sh`, `systemctl start celld`. The old release stays in `/opt/celld/releases` for going back, which the notes must allow. Rebuild Pim with the new celld before its next deploy (`deploy.sh` refuses a build made with another).

## Backup and restore

Everything is in the bucket, under the prefix: each Durable Object's database (as celld's replication log), the R2 buckets (`r2/pim-blobs/`, `r2/pim-artifacts/`), the KV namespace, the deployments with their secrets, and celld's own records, its fleet secret among them. `/var/lib/celld` is a working copy the node rebuilds; it isn't a backup.

**Cold backup** (the one that has been tested): stop the node, which drains, makes every write durable and publishes a final snapshot of each database (up to 40 seconds); copy the whole prefix to another bucket with server-side copies that keep each object's metadata (celld keeps R2 objects' metadata there), such as `rclone sync` or `aws s3 sync` between buckets; start the node. Pim is down for the copy.

```sh
systemctl stop celld
rclone sync --metadata pimbucket:YOUR-BUCKET/pim backupbucket:pim-backups/$(date -u +%F)/pim
systemctl start celld
```

**Restore** into an empty prefix, never over the prefix a node uses: copy the backup there, point `CELLD_BUCKET` at it, empty `CELLD_WATCH`, and start the node. Then check: `/health`, signing in, a chat's history, an image in it, and a new message. The scratch run does this, with server-side copies on its stand-in bucket, and every check passed on the restored node; a copy through another tool or to another provider is yours to test the same way.

What this is and isn't:

- **All or nothing.** A restore takes every person back to the backup's moment. There is no restoring one person, and no point in time between backups.
- **Copies of a running node aren't consistent.** A copy made while celld writes can catch databases mid-history; nothing here claims it restores. Bucket versioning or object lock at your provider protect against deletion, but restoring from them hasn't been tested.
- **A person's export is not a backup.** Settings' export (`pim.exported`) is a copy for the person to keep. Pim can't import it, and it leaves out credentials and apps' sign-ins.
- **Backups hold secrets**: every deployment's variables and celld's fleet secret. Encrypt them (`rclone crypt`, or provider-side encryption with your own key) and keep their credentials apart from the live bucket's.
- **The bucket grows.** With `CELLD_LTX_RETENTION_SECS` unset, celld keeps every activation's history; backups grow with it. Turning on epoch GC is your decision ([celld's guarantees](https://celld.dev/docs/guarantees#epoch-gc)), and hasn't been tested with Pim.
- **Practice.** Restore into a scratch prefix and start a second node on other ports against it, now and then. Never start two nodes on the same prefix with different `CELLD_WATCH` directories at once, and never let the restored node's Pim send anything real while you test.

Keep `APP_CREDENTIALS_KEY`, `/etc/pim` and `/etc/celld` backed up apart from the bucket.

## Operating

- **Logs.** `journalctl -u celld`: celld's own lines, and the Worker's JSON lines. Filter on `"event":"pim.` for Pim's events, as in [Monitoring](instance.md#running-it), and alert on `pim.cleanup_failed` and `pim.misrouted`.
- **Health.** `curl 127.0.0.1:8080/.well-known/celld/health` (celld; 503 while starting or draining) and `https://pim.example.com/health` (Pim, through the proxy).
- **celld.** `celld diagnose` and `celld cell list` read the bucket ([Diagnose a fleet](https://celld.dev/docs#diagnose-a-fleet)); `GET 127.0.0.1:8081/state` shows the node.
- **Stopping.** systemd sends SIGTERM and waits 60 seconds, longer than celld's 40-second drain; SIGKILL before then can leave the next start to recover writes.

## What has been checked

`deploy/celld/test/` holds four checks. The first three run in seconds; the last takes a few minutes and a scratch machine.

- `node --test deploy/celld/test/config.check.mjs`: the profile against what celld v0.6.3 accepts and against `wrangler.jsonc`, its Durable Objects against `src/index.ts`'s exports, the committed examples hold no secret, JSONC parsing that leaves strings alone, and how variables and secrets are read and refused.
- `node --test deploy/celld/test/build-paths.check.mjs`: each OUT `build.sh` must refuse to delete, with a sentinel file that must survive.
- `CADDY=... node --test deploy/celld/test/proxy.check.mjs`: the Caddyfile, as above.
- `CELLD=... deploy/celld/test/run-scratch.sh [REF]`: the whole install on one machine, with [moto](https://github.com/getmoto/moto) as a throwaway S3 (not a qualified store), random canary secrets, and [`mock-model.mjs`](../deploy/celld/test/mock-model.mjs) as a custom-endpoint model. It builds and deploys the commit, starts celld v0.6.3 and the Caddyfile, then checks through the proxy: `/health`; `/`, a page of the app and a script are the build's files; `/api` goes to the Worker; past the proxy, Pim refuses a missing or wrong ingress secret (403), a bad client address (400) and `http://` (421); claiming from the setup link in celld's log; a passkey (a software one, as the Worker's tests make), an API token, a provider, a chat with an image kept in R2, a goal, a WebSocket. It restarts the node gracefully and checks it all again, searches all of the bucket and the build for the canaries (found in the deployment's manifest only), then restores a cold backup into an empty prefix on a fresh node and checks it all again. It refuses a commit without Pim's celld runtime unless `ALLOW_PRE_RUNTIME=1`, which runs everything but the ingress checks. Without that override, it has passed on the integration candidate, `review/linus-celld-integrated` (the celld security change from `9c79fe6`, these deploy changes, and main merged in), along with the ingress and rate-limit checks above. It hasn't run on main itself, which doesn't have the runtime yet.

Not checked on celld, and each needs a real deployment: a qualified bucket's latency and errors, Caddy's real certificates, passkeys in browsers, Google/GitHub/OIDC sign-in, apps' OAuth and encrypted credentials in use, real model providers, the ChatGPT plan, MCP clients, the computer companion, alarms that fire across a restart, push notifications, sustained load, and the bucket's growth over months.
