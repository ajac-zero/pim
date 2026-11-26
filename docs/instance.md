# Running a Pim for several people

A Pim is one server for everyone on it. Each person has their own space: their memory, connectors and agents, plus their own conversations, goals, schedules, ChatGPT sign-in, passkeys, linked accounts and API tokens, which are the rows of one owner in PostgreSQL, kept apart by row-level security. The person who sets it up is its admin: they invite the others, and help them back in when they lose every passkey. A Pim for one person is the same thing with one account.

People on the same Pim can share with each other: circles let others message your agent from their own space (see [Sharing](reference.md#sharing)), and Discover lists the templates people published. Nothing crosses from one deployment to another.

## How it works

```
 Browser, bot, app                      Your server (Compose or Kubernetes)
┌──────────────────────────┐  HTTPS / WS  ┌────────────────────────────────────────────────────┐
│ pim.example.com          │─────────────▶│ the proxy (Caddy / ingress) ─▶ the Gate:           │
│  session cookie, or      │              │  whose request is this?                            │
│  API token pim_<owner>_… │              │  session cookie ─▶ owner, passkey or identity      │
└──────────────────────────┘              │  API token      ─▶ owner                           │
                                          │  app callback   ─▶ owner in the path               │
                                          │  │                                                 │
                                          │  ▼ every query runs as that owner                  │
                                          │ PostgreSQL: accounts, the admin, invites, passkeys,│
                                          │   identities, recovery codes, tokens, spaces,      │
                                          │   profiles and published templates (row-level      │
                                          │   security by owner)                               │
                                          │ Runner, Live, Forge, maintenance: the other roles  │
                                          └────────────────────────────────────────────────────┘
```

- **Owners.** Joining gives each person a random, permanent owner ID (`o_` and 26 base32 characters). Every row of their space carries it, and each transaction sets it (`pim_current_owner_id()`), so a query for one person's space cannot read another's; it is never the username.
- **The request names its owner; the owner's own sign-in checks it.** A URL never chooses whose agent answers.
  - A session cookie names the owner and the credential it was made with: a passkey or a linked identity. Every request checks that credential is still one of that owner's, so removing it, or deleting the account, ends the session.
  - Signing in reads the owner from the passkey's user handle, which is the owner ID the passkey was made for, then checks the signature with that owner's passkey. A passkey that names someone else isn't one of theirs.
  - Signing in with Google, GitHub or a custom OpenID Connect provider finds the owner by the provider's issuer and user ID (never the email), then checks that owner has that identity. The provider's ID token comes straight from its token endpoint, in exchange for a code and a PKCE verifier only this sign-in knows; its issuer, audience, nonce and expiry are checked. The flow's state rides in a `SameSite=Lax` cookie, so a sign-in finishes only in the browser that started it.
  - An API token is `pim_<owner>_<secret>`, kept as a digest.
  - An MCP client's OAuth grant names its owner, the person signed in to the app who allowed it on `/authorize`; its access tokens open only that owner's `/mcp` (see [mcp.ts](../packages/v2-app/src/mcp.ts)).
  - Setup and device links carry their owner before the code (`#setup=<owner>.<code>`). A recovery code comes with the person's username.
  - Connectors' sign-ins return to `/mcp/callback/<owner>`, matched against the OAuth state; event webhooks go to `/mcp/events/<owner>/<key>`, checked against the signing secret of the trigger's subscription the key names.
- **Usernames** are 3 to 32 lowercase letters, digits and single hyphens. A list of names is reserved. A username is never reused once its account is active, even after deletion, so nobody inherits what others knew by that name. A registration that never makes a passkey gives back its username, its place under `PIM_MAX_ACCOUNTS` and its invite after a day, and what it made is erased.
- **One origin for everyone.** Only Pim's own app code runs on it. Apps are served with a CSP sandbox that gives them an opaque origin (see [apps.md](apps.md)), so they can't read anyone's cookies or call the API. Anything later that runs code people or their agents wrote must live on another domain.

## Joining

- **The admin.** While a Pim has no admin, the only way to make an account is to claim it, and that account is the admin's. Whoever asks the Gate for a setup link (`POST /auth/setup-link`, which the sign-in screen does) can, so ask right after starting. The Gate writes the link to its log (`#claim=<code>`, one-time, good for 15 minutes), which only someone with access to the server's logs can read (`deploy/compose/pim.sh logs gate`). If the admin's registration lapses without a passkey, or the admin deletes their account, the Pim can be claimed again the same ways.
- **Everyone else** joins as `PIM_REGISTRATION` says: `invite` (the default) takes a single-use invite link the admin makes in Settings (`#invite=<code>`), `open` takes anyone, `closed` nobody. Registrations are limited per address per day (`PIM_REGISTRATIONS_PER_ADDRESS`, default 3) and, optionally, in total (`PIM_MAX_ACCOUNTS`).
- **Registering** (`POST /auth/register`) provisions the person's space, gives them a copy of the agent the admin chose for everyone, if any (see [Your agents](reference.md#your-agents)), sets its time zone from the browser, and returns ten recovery codes and a one-time setup code (good for a day). The web app shows the codes, then makes the first passkey with the setup code, which activates the account. Signed in, the person names their [majordomo](reference.md#your-majordomo).
- **Recovery.** A recovery code, with its username, makes one passkey, once. People can replace their codes in Settings. The admin can make anyone a one-hour setup link from Settings, after checking who they are some other way, and gets one for themselves from the Gate's log.
- **Approvals** default to `PIM_APPROVAL_POLICY`; each person can change theirs.
- **Usage and limits.** Requests and runs are checked and counted in one step before they start, so concurrent ones can't all take the last slot. Tokens are known only when a request ends, so requests already under way can take a day past `dailyTokens`; the next one is refused. Tokens are counted by the day the request was sent, and by provider. Tokens on someone's own ChatGPT plan are counted apart and never use up the deployment's allowance. The `PIM_LIMIT_*` variables set members' limits; the admin has none. The admin can set one person's in the admin API. Running out fails the model request with a non-retryable "quota exceeded" error, which holds the run until the person asks again, refuses new runs with `429`, and skips scheduled tasks with one notification a day. Usage is recorded, not charged.
- **Sharing.** Adding someone to a circle is answered by the Gate (`POST /api/circles/:id/members`), which knows whose space a username is. After that the two spaces are only joined by rows each owner's row-level security lets the other read: the guest's chat asks for a brief before each turn, and makes every tool call through a check of the circle and the tool's permission each time, and the owner's decisions go back the same way. A guest's conversation runs in their own space, so it is metered against their own limits. Each guest has 200 calls a day into one space; a circle can hold up to 200 people.
- **Profiles and templates** live in the gallery: profiles, Discover's search, someone's page, publishing an agent (a copy of its name, description, instructions and suggested connectors) and making one your own. Deleting an account forgets its profile and everything it published, in the same purge that erases its space. The admin can take a published template down.
- **Connectors the admin adds** are kept with the deployment's own settings, next to the connectors that come with Pim. Connections and their sign-ins stay in each person's own space.
- **ChatGPT plan.** Each person signs in with ChatGPT in their own Settings. Their tokens, refreshes and agent host ID live in their own space, sealed under the key ring. OpenAI's [token-sharing docs](https://developers.openai.com/siwc/token-sharing-open-source) cover open-source and locally hosted apps, and ask paid or remotely hosted apps to fill in an interest form. If you run a Pim for people outside your household, check with OpenAI first.

## Running it

How the Pim runs for everyone is its variables, set in `deploy/compose/.env` (see [Deploy](reference.md#deploy)); Settings → Deployment shows the admin each one and any Pim can't read, and its Apps group is where the admin chooses which of Pim's built-in apps, such as [Notes](apps.md#notes), everyone gets. The admin manages people in Settings → Members: invite someone, make a setup link, suspend or restore an account, delete one. The same tab shows which of Google, GitHub and a custom OpenID Connect provider the deployment's `PIM_<PROVIDER>_*` variables turn on, and how to set one up (see [Deploy](reference.md#deploy)). The same is in the API, under `/api/admin`, for the admin signed in to the app; an API token can't run the instance:

| Method | Path | Body | Does |
| --- | --- | --- | --- |
| GET | `/api/admin/stats` | | Accounts by status, registrations in the last day, unused invites, queued and failing cleanups, and this month's sandbox minutes by provider and person (`compute`) |
| GET | `/api/admin/accounts` | `?status=&after=&limit=` | Accounts, by username |
| GET | `/api/admin/accounts/:username` | | The account, its usage, and its cleanup job if one is queued |
| POST | `/api/admin/accounts/:username/suspend` | `{ reason? }` | Stops the agent at once: its runs abort, sockets close, requests get `403` |
| POST | `/api/admin/accounts/:username/unsuspend` | | Restores it |
| GET | `/api/admin/deployment` | | How the deployment runs, from its variables, and why Pim can't read any it can't |
| GET, POST, DELETE | `/api/admin/computer-host` | | The machine that keeps everyone's computers: its status; pairing it, which returns its token once; or forgetting it (see [Computers Pim keeps](reference.md#computers-pim-keeps)) |
| PUT | `/api/admin/accounts/:username/limits` | `{ limits }` or `{ limits: null }` | One person's limits over the `PIM_LIMIT_*` variables |
| PUT | `/api/admin/accounts/:username/compute-quota` | `{ quota }` or `{ quota: null }` | One person's compute quota over the deployment's (see [Compute](reference.md#compute-providers-and-quotas)) |
| GET | `/api/admin/compute` | | The compute providers (never their credentials), the kinds that can be added, the default quota, and everyone's usage this month |
| POST, PUT, DELETE | `/api/admin/compute/providers[/:id]` | `{ kind, name?, settings?, credentials?, codingSandbox?, agentComputer? }` | Adds, changes or removes a compute provider; a credential left out stays, an empty one is removed |
| POST | `/api/admin/compute/providers/:id/validate` | | One cheap read against the provider: `{ health: { ok, message, ms } }` |
| PUT | `/api/admin/compute/quota` | `{ quota }` | The default quota for everyone: `maxConcurrentWorkspaces`, `monthlySandboxMinutes`, `maxSessionMinutes`, each a whole number or null for no limit |
| GET, POST | `/api/admin/coding/pools` | `{ id, provider, size, priority, enabled?, config? }` (POST) | The sandbox pools, each with its live state, or adds one (see [coding-pools.md](coding-pools.md#admin-routes-and-page)) |
| PATCH, DELETE | `/api/admin/coding/pools/:id` | `{ size?, priority?, enabled?, config?, provider? }` (PATCH) | Changes or removes a pool; the last enabled pool with an available provider can't be removed or switched off (`409`) |
| POST | `/api/admin/accounts/:username/setup-link` | | A one-hour link that adds a passkey, for recovery |
| DELETE | `/api/admin/accounts/:username` | `{ reason? }` | Deletes it as the owner would: `200` once erased, `202` while the cleanup is still queued. Run it again to retry at once |
| DELETE | `/api/admin/templates/:id` | | Takes a published agent out of Discover |
| POST | `/api/admin/apps` | `{ name, description?, url }` | Adds a connector everyone can connect: a remote MCP server, named `custom/<id>` after its name (`201` with `{ app }`) |
| DELETE | `/api/admin/apps/:id` | | Takes it out of the directory. People's connections to it stay until they disconnect them |
| GET | `/api/admin/builtin-apps` | | Pim's built-in apps, and which are on for everyone |
| PUT | `/api/admin/builtin-apps/:id` | `{ enabled }` | Turns one on or off for everyone; people's spaces see it within a minute |
| POST | `/api/admin/providers` | `{ name, url, key?, models? }` | Adds a model provider everyone can use: a server that speaks OpenAI's chat completions (`201` with `{ provider }`, never the key). See [Model providers](reference.md#model-providers) |
| PUT, DELETE | `/api/admin/providers/:id` | PUT: `{ name?, url?, key?, models? }` | Changes it and reads its models again, or takes it away from everyone |
| GET, PUT, DELETE | `/api/admin/default-agent` | PUT: `{ agent }`, one of the admin's agents | The agent everyone who joins gets a copy of besides their majordomo (`{ agent }`, null for none). PUT copies the admin's agent as it is now; choosing again replaces it. DELETE goes back to none |
| POST | `/api/admin/invites` | `{ count?, note? }` | Single-use invite codes and links (up to 100) |

The admin can't suspend or delete their own account from here; deleting it from Settings leaves the Pim to be claimed again.

**Monitoring.** Every role writes JSON lines to its standard output (`deploy/compose/pim.sh logs <role>`; a few carry an `event` field, such as `pim.started`, `pim.migrate` and `pim.limit` when a person hits a limit), and serves Prometheus metrics on `PIM_METRICS_PORT`. The signals that matter for running a Pim for several people (request latency, queues, partition ownership, projection and Live lag, model errors and spend) and the 19 alert rules with their runbooks are in [v2-operations.md](v2-operations.md#observability) and `deploy/observability/`. The metrics carry no label that can identify a person, a chat or content.

**Abuse and limits.** Per address: `PIM_RATE_AUTH` (30 sign-in, recovery and registration attempts a minute) and `PIM_REGISTRATIONS_PER_ADDRESS`. Per person: `PIM_RATE_API` (600 requests a minute), the `PIM_LIMIT_*` variables (tokens, model requests, runs, chats, schedules, storage, apps), and `PIM_MODELS`, so only models you pay for can be chosen.

**Deleting an account** makes it `deleting` first, so it opens nothing at once, and the maintenance role purges it: every row of the owner's space (runs, connector subscriptions, schedules, credentials, files and apps with it) is removed in passes until nothing references what is left, and the account row stays as a tombstone, `deleted`, so its username is never given to someone else. The purge is repeatable, so a failed attempt is picked up again. Every request re-checks the account's status, so a request that was already under way when the deletion began finds a closed account and writes nothing further.

## Before inviting people

1. **Domain.** Passkeys belong to the hostname, so pick the address people will use before anyone joins: moving later means everyone makes new passkeys and reconnects their connectors. Point it at the stack and set `PIM_PUBLIC_URL` to it (`deploy/compose/init-env.sh https://pim.example.com` does both for Compose).
   For public app links, add a second hostname that isn't under the first one's cookies (another domain is best), route its `/p/*` to the Gate and its `/artifact-runtime/*` to the web app (answer nothing else there), and set `PIM_CONTENT_ORIGIN` to it (see [apps](apps.md#public-links)); the Compose Caddy file does it for `PIM_CONTENT_DOMAIN`.
   For apps with a backend at addresses of their own, add a wildcard hostname under another domain (`*.apps.example.net`), route it to the Gate, and set `PIM_APPS_ORIGIN` to its base (`https://apps.example.net`; see [apps](apps.md#apps-with-a-backend)); the Compose Caddy file does it for `PIM_APPS_DOMAIN`.
2. **OpenAI:** for people outside your household, confirm with OpenAI that they may use ChatGPT-plan sign-in through your Pim.
3. **Policy:** `PIM_REGISTRATION`, the `PIM_LIMIT_*` variables and `PIM_MODELS` for what you're willing to pay for.
4. **Backups and keys:** take a backup and keep the key ring (`PIM_KEK_*`) with it ([v2-operations.md](v2-operations.md#backup-and-restore)); sealed credentials are unreadable without it.
5. **Monitoring:** the alerts in `deploy/observability/`, and a watch on the logs for `pim.limit`.
6. **Computers**, if Pim should keep one for everyone: a Linux machine with KVM or a Mac with Apple silicon, whose computers are VMs, or Linux without KVM, whose computers are containers (which can't run Docker inside), with room for 4 vCPUs and 8 GB of memory per person unless you give them less. Pair it in Settings → Deployment → Computers and run the one command shown there on it (see [Computers Pim keeps](reference.md#computers-pim-keeps)).

## Preview locally

`node scripts/v2-dev/preview.mjs` (in an orb, `amp orb services ensure`) serves a Pim at <http://localhost:8787>: the v2 stack without Docker, a private PostgreSQL cluster, nats-server, an S3 server, a stand-in model and one process that runs every role, with open registration and a passkey-free sign-in. It rebuilds the web app when `web/src` changes. Its state is kept in `.wrangler/state-v2-dev`. [AGENTS.md](../AGENTS.md#running-pim) has the details of running it. Use `localhost`, not `127.0.0.1`: passkeys don't work on an IP address, and the preview serves `127.0.0.1` as its content origin, for public app links.

- **Signing in.** <http://localhost:8787/__dev/sign-in/ada> signs the browser in as `ada`, making the account if it's new (the first one is the admin), and `?returnTo=/settings` picks where it lands. It makes a passkey on the server, so it works in any browser and with `curl -c cookies`.
- **Passkeys.** To try the passkey screens themselves: Chrome, Safari and Edge on a laptop or phone use their own. On a machine without one (a Linux desktop, a headless browser), start Chrome with `--remote-debugging-port=9222` and run `node scripts/virtual-authenticator.mjs 9222`: it gives every tab a virtual passkey that answers at once. Or use DevTools → More tools → WebAuthn.
- **Models.** The preview answers with a stand-in model. It echoes what you say, and calls a tool when told to: `/tool create_goal {"title": "Run a 5k", "steps": ["Run 2k"]}`, or `/tool http_request {"method": "GET", "url": "https://example.com"}` for an approval. After a tool runs, it sends you the result. Connect a ChatGPT plan in Settings to chat with a real model.

## Known limits

- **Usernames can't change** yet. Nothing about them is tied to an address anymore, so renaming only needs building.
- **Import** of an export into a running Pim is not built; moving from the Cloudflare version is the cutover in [v2-operations.md](v2-operations.md#cutover-from-the-cloudflare-deployment).
- **Email** is not built (see [Email](reference.md#email)). Accounts have no email: recovery is codes, or the admin's setup link.
- **One admin.** More admins, or handing the role over, aren't built.
