# Running a Pim for several people

A Pim is one Worker for everyone on it. Each person has their own space: one Durable Object `Pim` holding their memory, connectors and agents, plus their own conversations, goals, schedules, ChatGPT sign-in, passkeys, linked accounts and API tokens. The person who sets it up is its admin: they invite the others, and help them back in when they lose every passkey. A Pim for one person is the same thing with one account.

People on the same Pim can share with each other: circles let others message your agent from their own space (see [Sharing](reference.md#sharing)), and Discover lists the templates people published. Nothing crosses from one deployment to another.

## How it works

```
 Browser, bot, app                          Cloudflare: Worker "pim" (src/index.ts)
┌──────────────────────────┐  HTTPS / WS  ┌────────────────────────────────────────────────────┐
│ pim.example.com          │─────────────▶│ src/gateway.ts: whose request is this?             │
│  session cookie, or      │              │  session cookie ─▶ owner, passkey or identity      │
│  API token pim_<owner>_… │              │  API token      ─▶ owner                           │
└──────────────────────────┘              │  app callback   ─▶ owner in the path               │
                                          │  │                                                 │
                                          │  ▼                                                 │
                                          │ Directory DO (one): accounts, admin, invites,      │
                                          │   erasure jobs, the key that seals cookies,        │
                                          │   sign-in providers, whose each identity is        │
                                          │ Auth DO (one per owner): passkeys, identities,     │
                                          │   recovery codes, API tokens, setup/device links   │
                                          │ Pim DO (one per owner): their space               │
                                          │ Gallery DO (one): profiles, published templates    │
                                          └────────────────────────────────────────────────────┘
```

- **Owners.** Joining gives each person a random, permanent owner ID (`o_` and 26 base32 characters). Their `Pim` and `Auth` Durable Objects are named by it, never by the username.
- **The request names its owner; the owner's own sign-in checks it.** A URL never chooses whose agent answers.
  - A session cookie is sealed with the instance's key (kept in the Directory) and names the owner and the credential it was made with: a passkey or a linked identity. Every request checks that credential is still one of that owner's, so removing it, or deleting the account, ends the session.
  - Signing in reads the owner from the passkey's user handle, which is the owner ID the passkey was made for, then checks the signature with that owner's passkey. A passkey that names someone else isn't one of theirs.
  - Signing in with Google, GitHub or a custom OpenID Connect provider finds the owner in the Directory by the provider's issuer and user ID (never the email), then checks that owner's Auth object has that identity. The provider's ID token comes straight from its token endpoint, in exchange for a code and a PKCE verifier only this sign-in knows; its issuer, audience, nonce and expiry are checked. The flow's state rides in a sealed, `SameSite=Lax` cookie, so a sign-in finishes only in the browser that started it.
  - An API token is `pim_<owner>_<secret>`, checked in that owner's Auth object.
  - An MCP client's OAuth grant names its owner, the person signed in to the app who allowed it on `/authorize`; its access tokens, checked in `OAUTH_KV`, open only that owner's `/mcp` (see [src/mcp-auth.ts](../src/mcp-auth.ts)).
  - Setup and device links carry their owner before the code (`#setup=<owner>.<code>`). A recovery code comes with the person's username.
  - Connectors' sign-ins return to `/mcp/callback/<owner>`, matched by the agent against the OAuth state; event webhooks go to `/mcp/events/<owner>/<key>`, checked against the signing secret of the trigger's subscription the key names.
  - The agent refuses any request whose forwarded owner isn't its own name (`pim.misrouted`).
- **Usernames** are 3 to 32 lowercase letters, digits and single hyphens. A list of names is reserved. A username is never reused once its account is active, even after deletion, so nobody inherits what others knew by that name. A registration that never makes a passkey gives back its username, its place under `PIM_MAX_ACCOUNTS` and its invite: at once if setting it up fails, otherwise after a day. Whatever it made is erased by a cleanup job.
- **One origin for everyone.** Only Pim's own app code runs on it. Apps are served with a CSP sandbox that gives them an opaque origin (see [apps.md](apps.md)), so they can't read anyone's cookies or call the API. Anything later that runs code people or their agents wrote must live on another domain.

## Joining

- **The admin.** While a Pim has no admin, the only way to make an account is to claim it, and that account is the admin's. Anyone who opens the Pim in the 15 minutes after a deploy can, so open it right after deploying. After that, the sign-in screen asks the Worker to write a setup link to its logs (`#claim=<code>`, one hour), which only someone signed in to the Cloudflare account can read. If the admin's registration lapses without a passkey, or the admin deletes their account, the Pim can be claimed again the same ways.
- **Everyone else** joins as `PIM_REGISTRATION` says: `invite` (the default) takes a single-use invite link the admin makes in Settings (`#invite=<code>`), `open` takes anyone, `closed` nobody. Registrations are limited per address per day (`PIM_REGISTRATIONS_PER_ADDRESS`, default 3) and, optionally, in total (`PIM_MAX_ACCOUNTS`).
- **Registering** (`POST /auth/register`) provisions the person's space, gives them a copy of the agent the admin chose for everyone, if any (see [Your agents](reference.md#your-agents)), sets its time zone from the browser, and returns ten recovery codes and a one-time setup code (good for a day). The web app shows the codes, then makes the first passkey with the setup code, which activates the account. Signed in, the person names their [majordomo](reference.md#your-majordomo).
- **Recovery.** A recovery code, with its username, makes one passkey, once. People can replace their codes in Settings. The admin can make anyone a one-hour setup link from Settings, after checking who they are some other way, and gets one for themselves from the logs.
- **Approvals** default to `PIM_APPROVAL_POLICY`; each person can change theirs.
- **Usage and limits.** Every model request goes through a metered model catalog. Requests and runs are checked and counted in one step before they start, so concurrent ones can't all take the last slot. Tokens are known only when a request ends, so requests already under way can take a day past `dailyTokens`; the next one is refused. Tokens are counted by the day the request was sent, and by provider. Tokens on someone's own ChatGPT plan are counted apart and never use up the deployment's allowance. The `PIM_LIMIT_*` variables set members' limits; the admin has none. The admin can set one person's in the admin API. Running out fails the model request with a non-retryable "quota exceeded" error, which holds the run until the person asks again, refuses new runs with `429`, and skips scheduled tasks with one notification a day. Usage is recorded, not charged.
- **Sharing.** Adding someone to a circle is answered by the Worker (`POST /api/circles/:id/members`), because only the Directory knows whose space a username is. Everything after is between the two spaces, by Durable Object RPC: the owner's tells the guest's it is shared (`shareReceived`), the guest's asks for a brief before each turn (`guestBrief`) and makes every tool call through `guestCall`, which checks the circle and the tool's permission each time, and the owner's sends decisions back (`visitAnswer`). A guest's conversation runs in their own space, so it is metered against their own limits. Each guest has 200 calls a day into one space; a circle can hold up to 200 people.
- **Profiles and templates** live in the Gallery: profiles, Discover's search, someone's page, publishing an agent (a copy of its name, description, instructions and suggested connectors) and making one your own. Deleting an account forgets its profile and everything it published, in the same cleanup job that erases its space; the job is done only once the Gallery holds nothing of it. The admin can take a published template down.
- **Connectors the admin adds** live in the Gallery too, next to the extensions' connectors in code. Each person's space reads them again at most once a minute, when a request comes in, and keeps the last list it read, so scheduled work has them without asking. A request waits at most 2 s for that read: a slow Gallery leaves the last list in use until it answers. Connections and their sign-ins stay in each person's own space.
- **ChatGPT plan.** Each person signs in with ChatGPT in their own Settings. Their tokens, refreshes and agent host ID live in their own space. OpenAI's [token-sharing docs](https://developers.openai.com/siwc/token-sharing-open-source) cover open-source and locally hosted apps, and ask paid or remotely hosted apps to fill in an interest form. If you run a Pim for people outside your household, check with OpenAI first.

## Running it

How the Pim runs for everyone is its variables, set in the Cloudflare dashboard (see [Deploy](reference.md#deploy)); Settings → Deployment shows the admin each one and any Pim can't read, and its Apps group is where the admin chooses which of Pim's built-in apps, such as [Notes](apps.md#notes), everyone gets. The admin manages people in Settings → Members: invite someone, make a setup link, suspend or restore an account, delete one. The same tab shows which of Google, GitHub and a custom OpenID Connect provider the deployment's `PIM_<PROVIDER>_*` secrets turn on, and how to set one up (see [Deploy](reference.md#deploy)). The same is in the API, under `/api/admin`, for the admin signed in to the app; an API token can't run the instance:

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

**Monitoring.** Workers Logs has one JSON line per event. Filter on `event`:

| Event | Means |
| --- | --- |
| `pim.registered`, `pim.activated` | A registration (with its `role`), and its first passkey |
| `pim.registration_refused`, `pim.registration_failed` | Refused by policy, limits or a taken name; or failed while provisioning (the name is given back) |
| `pim.rate_limited` | `AUTH_LIMITER` (per address) or `API_LIMITER` (per owner) refused a request |
| `pim.suspended`, `pim.unsuspended`, `pim.limits_changed`, `pim.setup_link_issued`, `pim.invites_created` | The admin's actions |
| `pim.exported`, `pim.deletion_requested`, `pim.deleted` | Exports; deletions asked for (`by`: owner or admin) and finished (agent and sign-in checked empty) |
| `pim.cleanup_failed` | A cleanup attempt failed and is queued again, with `attempts` and `error`. Alert when `attempts` keeps climbing |
| `pim.registration_released`, `pim.released` | A registration given back (`why`: setup failed or lapsed), and its objects erased |
| `pim.limit` | A person hit a limit: `limit` is `model` or `run` |
| `pim.model_error` | A model request failed: `provider`, `model`, the `stopReason` when it ended and the provider's `error` text, which chats never show |
| `pim.task_failed` | A task faulted while a person watched its chat, with its `kind` and `error` text, which chats never show |
| `pim.passkey_created`, `pim.device_link_issued`, `pim.recovery_codes_replaced` | A passkey made from a setup link, recovery code or device link; a device link made; codes replaced |
| `pim.identity_linked`, `pim.identity_unlinked` | Someone linked or unlinked an account at a `provider` |
| `pim.circle_member_added` | Someone put another person in a circle |
| `pim.template_published`, `pim.template_used`, `pim.template_removed` | An agent published (or updated), made someone's own, or taken down by the admin |
| `pim.default_agent_set` | The admin chose the agent everyone who joins gets (`agent`), or went back to none (`agent: null`) |
| `pim.misrouted` | A request reached the wrong agent. This should never happen: investigate |
| `pim.do_start` | A person's space started, with how long its own start took (`ms`) and how many sockets' `watches` it restored |
| `pim.slow_request` | A request to a person's space took more than 5 s: its `method` and route (`path`, without ids), logged as it passes 5 s (`status: null`) and again as it ends, with `ms` and `status` |
| `pim.slow_refresh` | Reading the admin's connectors and providers from the Gallery took more than 2 s: logged once as a request stops waiting for it (`done: false`), and as it ends (`done: true`, with `ms`) |
| `pim.watch_lost` | A socket's chat events stopped (`reason`), so it was closed for the app to connect again |

**Abuse and limits.** Per address: `AUTH_LIMITER` (30 sign-in, recovery and registration attempts a minute in `wrangler.jsonc`) and `PIM_REGISTRATIONS_PER_ADDRESS`. Per person: `API_LIMITER` (600 requests a minute), the `PIM_LIMIT_*` variables (tokens, model requests, runs, chats, schedules, storage, apps), and `PIM_MODELS`, so only models you pay for can be chosen.

**Deleting an account** makes it `deleting` in the Directory first, so it opens nothing at once (`410`), and queues a cleanup job there. The job wipes the agent (runs aborted, connector event subscriptions stopped, sockets closed, storage and alarms deleted, schedules and credentials with them), writes an erased mark into the empty storage, flushes it, and ends the agent's instance so nothing under way there can write afterwards. Every later instance finds the mark and refuses everything: requests (`410`), sockets, alarms and the Worker's own writes. That makes the agent itself the fence: a request a Worker authorized just before the deletion, or with an account it still had cached, can't write after it. The job then checks a fresh instance is marked and holds nothing, and wipes and checks the Auth object. Only then is the account `deleted`; a request that slipped in before the mark makes the check fail, and the retry wipes it.

What the fence stops, each covered by a test in `test/people.test.ts` ("erasure boundaries"):

- **Open sockets** are closed (code `4010`), and nothing sent on them afterwards is taken.
- **A request already inside the agent** when erasure starts can't write. If its handler goes on while the erasure runs, the handler checks the fence again and refuses (`410`). If it is still waiting when the instance ends, it never goes on: the request gets `503`, and a retry gets `410`.
- **A model request under way** can't write its answer, whether the answer arrives during the erasure or never does, and can't hold up the deletion: stopping runs and ending connectors' subscriptions get 3 seconds before the wipe goes ahead regardless.
- **Approval timers** that outlive the agent decide nothing: under `auto`, an approval due after the deletion never runs its action.
- **Scheduled work** due afterwards never runs: the wipe clears the alarm, and an alarm that fires anyway does nothing.
- **A Worker with the account still cached**, its already-authorized requests and sockets, connector event callbacks, and the Worker's own writes (`provision`, settings, limits, runs) all get `410`. Destroying an agent ends the call that asked for it, so that call's result is never trusted either way: the check decides. A failed attempt is retried on the Directory's alarm after 1, 5 and 30 minutes, 2 hours, then every 6 hours, and the person is told the account is closed and still being erased (`202`). The username stays taken.

## Before inviting people

1. **Domain.** Passkeys belong to the hostname, so pick the address people will use before anyone joins: moving later means everyone makes new passkeys and reconnects their connectors. Attach it to the Worker and set `PIM_PUBLIC_URL` to it, both in the dashboard.
   For public app links, add a second hostname that isn't under the first one's cookies (another domain is best), route its `/p/*` and `/artifact-runtime/*` to the Worker, and set `PIM_CONTENT_ORIGIN` to it in the dashboard (see [apps](apps.md#public-links)).
   For apps with a backend at addresses of their own, add a wildcard hostname under another domain (`*.apps.example.net`), route it to the Worker, and set `PIM_APPS_ORIGIN` to its base (`https://apps.example.net`; see [apps](apps.md#apps-with-a-backend)). Apps are served from every path at their own hostnames, `/` included, so the Worker must see requests before the static files do: set `run_worker_first` to `true` in `wrangler.jsonc`, and add `/hosted/*` to the list in `web/public/sw.js` if you keep a list.
2. **OpenAI:** for people outside your household, confirm with OpenAI that they may use ChatGPT-plan sign-in through your Pim.
3. **Data residency:** agents are created without a jurisdiction. Choosing one (for example `eu`) must happen before anyone joins, because an object can't move.
4. **Policy:** `PIM_REGISTRATION`, the `PIM_LIMIT_*` variables and `PIM_MODELS` for what you're willing to pay for.
5. **Monitoring:** alerts in Workers Logs on `pim.cleanup_failed` (with rising `attempts`) and `pim.misrouted` (which should never happen), and a watch on `pim.limit` and `pim.rate_limited`.
6. **Computers**, if Pim should keep one for everyone: a Linux machine with KVM or a Mac with Apple silicon, whose computers are VMs, or Linux without KVM, whose computers are containers (which can't run Docker inside), with room for 4 vCPUs and 8 GB of memory per person unless you give them less. Pair it in Settings → Deployment → Computers and run the one command shown there on it (see [Computers Pim keeps](reference.md#computers-pim-keeps)).

## Preview locally

`pnpm preview` builds the web app and serves a Pim at <http://localhost:8787> from `wrangler.preview.jsonc` and [`preview/worker.ts`](../preview/worker.ts), with open registration. It rebuilds the web app when `web/src` changes and reloads the Worker when its code does. It runs `wrangler dev --local` with no remote bindings, so it stays on your machine and touches no Cloudflare account, even when `wrangler` is logged in. It is never deployed: there is no deploy script for it. Its state is kept in `.wrangler/state-preview`. Use `localhost`, not `127.0.0.1`: passkeys don't work on an IP address, and the preview serves `127.0.0.1` as its content origin, for public app links.

- **Signing in.** <http://localhost:8787/__dev/sign-in/ada> signs the browser in as `ada`, making the account if it's new (the first one is the admin), and `?returnTo=/settings` picks where it lands. It makes a passkey on the server, so it works in any browser and with `curl -c cookies`.
- **Passkeys.** To try the passkey screens themselves: Chrome, Safari and Edge on a laptop or phone use their own. On a machine without one (a Linux desktop, a headless browser), start Chrome with `--remote-debugging-port=9222` and run `node scripts/virtual-authenticator.mjs 9222`: it gives every tab a virtual passkey that answers at once. Or use DevTools → More tools → WebAuthn.
- **Models.** Workers AI needs an account, so the preview answers with a stand-in model. It echoes what you say, and calls a tool when told to: `/tool create_goal {"title": "Run a 5k", "steps": ["Run 2k"]}`, or `/tool http_request {"method": "GET", "url": "https://example.com"}` for an approval. After a tool runs, it sends you the result. Connect a ChatGPT plan in Settings to chat with a real model.

Workers Builds' Preview builds run `wrangler preview`, which reads the `previews` block of `wrangler.jsonc`. A Preview gets its own Durable Objects but not `OAUTH_KV`, `BLOBS` or `ARTIFACTS`, so it runs without them until you add test namespaces and buckets there; never bind production's.

## Known limits

- **Usernames can't change** yet. Nothing about them is tied to an address anymore, so renaming only needs building.
- **Import** of an export is not built.
- **Data residency**: agents are created without a jurisdiction (see above).
- **Account cache**: each Worker isolate trusts what it read about an account for up to 30 seconds. Suspensions reach the agent at once regardless. Deletions wipe credentials, so a stale cache can't open a deleted account.
- **Directory**: one Durable Object holds every account and runs every cleanup. That is plenty for a household or a team, since lookups are cached.
- **Email** is optional, and only for Pim's messages to each person (see [Email](reference.md#email)). Accounts have no email: recovery is codes, or the admin's setup link.
- **One admin.** More admins, or handing the role over, aren't built.
