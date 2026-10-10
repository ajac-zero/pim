# Hosting Pimling

Pimling runs Pim for many people from one Cloudflare account. Each person gets their own Pim at `<username>.<domain>`, with its own conversations, memories, goals, schedules, connected apps, ChatGPT sign-in, passkeys and API tokens. Self-hosting is unchanged: `wrangler.jsonc` still deploys one Pim for one person.

This is Phase 1: a personal assistant service. It runs no code that people or their agents write. Artifacts, coding sandboxes, app hosting and self-extension are later phases.

## How it works

```
 Browser, bot, app                          Cloudflare: Worker "pimling" (src/hosted/index.ts)
┌──────────────────────────┐  HTTPS / WS  ┌────────────────────────────────────────────────────┐
│ pimling.com              │─────────────▶│ Front door: registration, /admin                   │
│ alice.pimling.com        │─────────────▶│ alice's Pim: web app, /auth, /api, /mcp callbacks  │
└──────────────────────────┘              │  │  (src/gateway.ts, the same as self-hosting)     │
                                          │  ▼                                                 │
                                          │ Directory DO (one): username → owner ID, status    │
                                          │ Auth DO (one per owner): passkeys, recovery codes, │
                                          │   API tokens, cookie key                           │
                                          │ Pim DO (one per owner): the agent, as self-hosted  │
                                          └────────────────────────────────────────────────────┘
```

- **Owners.** Registration gives each person a random, permanent owner ID (`o_` and 26 base32 characters). Their Pim and Auth Durable Objects are named by it, never by the username.
- **Hostnames choose and never authorize.** The hostname only picks whose credentials a request must carry. Session cookies are host-only, sealed with that owner's key, and name the owner. API tokens are looked up in that owner's Auth object. The agent refuses any request whose forwarded owner isn't its own name. `PIM_API_TOKEN`, the claim window after a deploy, and setup links in the logs are all off.
- **Usernames** are one DNS label, 3 to 32 lowercase letters, digits and single hyphens. A list of names is reserved. A username is never reused once its account is active, even after deletion: apps sent sign-ins and events to its hostname. A registration that never makes a passkey gives back its username, its place under `PIMLING_MAX_ACCOUNTS` and its invite code: at once if setting it up fails, otherwise after a day. Whatever it made is erased by a cleanup job.
- **Registration** (`POST /auth/register` on the front door) can be `open`, `invite` (single-use codes from the admin API) or `closed`, and is limited per IP address per day and, optionally, in total. It provisions the agent, sets its time zone from the browser, and returns a one-time setup link (good for a day) and ten recovery codes. Opening the link on the person's host creates their first passkey and activates the account.
- **Recovery.** A recovery code creates one passkey, once. People can replace their codes in Settings. An operator can issue a one-hour setup link with the admin API after verifying the person some other way.
- **Approvals** default to `explicit`: a request nobody answers is denied after 5 minutes. People can switch to `auto` (approved after 30 seconds) in Settings.
- **Usage and limits.** Every model request goes through a metered model catalog. Requests and runs are checked and counted in one step before they start, so concurrent ones can't all take the last slot. Tokens are known only when a request ends, so requests already under way can take a day past `dailyTokens`; the next one is refused. Tokens are counted by the day the request was sent, and by provider. Tokens on someone's own ChatGPT plan are counted apart and never use up the platform's allowance. `PIM_LIMITS` sets everyone's limits; the admin API sets one person's. Running out stops the model request with a non-retryable "quota exceeded" error, refuses new runs with `429`, and skips scheduled tasks with one notification a day. Billing is out of scope: usage is recorded, not charged.
- **ChatGPT plan.** Each person signs in with ChatGPT in their own Settings. Their tokens, refreshes and agent host ID live in their own Pim. OpenAI's [token-sharing docs](https://developers.openai.com/siwc/token-sharing-open-source) cover open-source and locally hosted apps, and ask paid or remotely hosted apps to fill in an interest form. Check your eligibility with OpenAI before offering this in a hosted service.

## Prerequisites

1. **Workers Paid plan.** It covers Durable Objects at this scale, rate limiting and Workers Logs.
2. **A zone** for the service, such as `pimling.com`, on Cloudflare with full DNS setup.
   - Add a proxied wildcard record `*` (and the apex) pointing anywhere, such as `AAAA 100::`. Universal SSL covers the apex and `*.pimling.com`, one label deep, which is all Pimling serves. Deeper names are not served.
   - Passkeys belong to each person's own hostname, so adding the zone to the Public Suffix List later won't break them. Keep untrusted content from later phases on a separate domain.
3. **Edit `wrangler.hosted.jsonc`:**
   - `routes`: replace `pimling.com` with your zone (both the apex and `*.` patterns).
   - `PIMLING_DOMAIN`: your zone.
   - `ratelimits[].namespace_id`: positive integers unique in your account.
   - `PIM_LIMITS`, `PIM_MODELS`, `PIMLING_REGISTRATION`, `PIMLING_MAX_ACCOUNTS`: your policy.
4. **Secret:** `pnpm wrangler secret put PIMLING_ADMIN_TOKEN --config wrangler.hosted.jsonc`. Without it the admin API is off.
5. **Never set** `PIM_API_TOKEN` or `PIM_NOTIFY_WEBHOOK` for Pimling. The first is ignored. The second makes the Worker refuse every request, because it would send everyone's notifications to one address.

## Deploy

```sh
pnpm install
pnpm wrangler login
pnpm run deploy:hosted   # builds web/, then deploys the "pimling" Worker
```

`pnpm wrangler deploy --dry-run --config wrangler.hosted.jsonc` checks the bundle without touching your account.

## Preview locally

`pnpm preview:hosted` builds the web app and serves Pimling at <http://pimling.localhost:8787> from `wrangler.preview.jsonc`. Browsers send every `*.localhost` name to your machine, so `alice.pimling.localhost:8787` works without DNS. The preview uses no remote bindings, so it touches no Cloudflare account, even when `wrangler` is logged in. Its state is kept in `.wrangler/state-preview`.

- **Passkeys.** Chrome, Safari and Edge on a laptop or phone use their own. On a machine without one (a Linux desktop, a headless browser), start Chrome with `--remote-debugging-port=9222` and run `node scripts/virtual-authenticator.mjs 9222`: it gives every tab a virtual passkey that answers at once. Or use DevTools → More tools → WebAuthn.
- **Models.** Workers AI needs an account, so the preview binds a stand-in. Chats on the platform model end with "Not answered: model_error". Connect a ChatGPT plan in Settings to chat for real.
- **Operator.** The admin API answers `Authorization: Bearer preview-admin`, for example `curl -H "Authorization: Bearer preview-admin" http://pimling.localhost:8787/admin/stats`.
- **Never deploy `wrangler.preview.jsonc`.** It has no routes, but also open registration and a known admin token.

The first deploy creates the `Pim`, `Auth` and `Directory` classes (migrations `v1` to `v3`). The `pimling` Worker is separate from any self-hosted `pim` Worker and shares no data with it.

## Migrating a self-hosted Pim

There is no automatic migration, deliberately: a self-hosted Pim's data lives in its owner's own Cloudflare account. Both export the same format: `GET /api/export` on a self-hosted Pim, and `GET /api/account/export` (Settings → Export my data) on Pimling, which adds the account. Importing an export is not built yet.

The code changes are backward compatible for self-hosters:

- The agent and sign-in objects keep their names (`pim` and `auth`), so existing data, passkeys and session cookies keep working.
- New SQLite columns and tables (`pim_approvals.on_timeout`, `pim_approvals.decided_by`, `pim_usage_*`, `auth_tokens`, `auth_recovery_codes`) are added on start.
- New variables default to today's behavior: `PIM_APPROVAL_POLICY=auto`, no `PIM_LIMITS`, any model.

## Operating it

The admin API is on the front door, with `Authorization: Bearer $PIMLING_ADMIN_TOKEN`:

| Method | Path | Body | Does |
| --- | --- | --- | --- |
| GET | `/admin/stats` | | Accounts by status, registrations in the last day, unused invites, queued and failing cleanups |
| GET | `/admin/accounts` | `?status=&after=&limit=` | Accounts, by username |
| GET | `/admin/accounts/:username` | | The account, its usage, and its cleanup job if one is queued |
| POST | `/admin/accounts/:username/suspend` | `{ reason? }` | Stops the agent at once: its runs abort, sockets close, requests get `403` |
| POST | `/admin/accounts/:username/unsuspend` | | Restores it |
| PUT | `/admin/accounts/:username/limits` | `{ limits }` or `{ limits: null }` | One person's limits over `PIM_LIMITS` |
| POST | `/admin/accounts/:username/setup-link` | | A one-hour link that adds a passkey, for recovery |
| DELETE | `/admin/accounts/:username` | `{ reason? }` | Deletes it as the owner would: `200` once erased, `202` while the cleanup is still queued. Run it again to retry at once |
| POST | `/admin/invites` | `{ count?, note? }` | Single-use invite codes (up to 100) |

**Monitoring.** Workers Logs has one JSON line per event. Filter on `event`:

| Event | Means |
| --- | --- |
| `pimling.registered`, `pimling.activated` | A registration, and its first passkey |
| `pimling.registration_refused`, `pimling.registration_failed` | Refused by policy, limits or a taken name; or failed while provisioning (the name is given back) |
| `pimling.rate_limited` | `AUTH_LIMITER` (per address) or `API_LIMITER` (per owner) refused a request |
| `pimling.suspended`, `pimling.unsuspended`, `pimling.limits_changed`, `pimling.setup_link_issued`, `pimling.invites_created`, `pimling.admin_refused` | Operator actions, and refused admin calls |
| `pimling.exported`, `pimling.deletion_requested`, `pimling.deleted` | Exports; deletions asked for (`by`: owner or operator) and finished (agent and sign-in checked empty) |
| `pimling.cleanup_failed` | A cleanup attempt failed and is queued again, with `attempts` and `error`. Alert when `attempts` keeps climbing |
| `pimling.registration_released`, `pimling.released` | A registration given back (`why`: setup failed or lapsed), and its objects erased |
| `pim.limit` | A person hit a limit: `limit` is `model` or `run` |
| `pim.passkey_created`, `pim.recovery_codes_replaced` | A passkey made from a setup link or recovery code; codes replaced |
| `pim.misrouted` | A request reached the wrong agent. This should never happen: investigate |

**Abuse and limits.** Per address: `AUTH_LIMITER` (30 sign-in, recovery and registration attempts a minute) and `PIMLING_REGISTRATIONS_PER_ADDRESS` (3 a day). Per person: `API_LIMITER` (600 requests a minute), `PIM_LIMITS` (tokens, model requests, runs, chats, schedules, apps, storage), and `PIM_MODELS`, so only models you pay for can be chosen. Paid `web_search` stays off.

**Deleting an account** makes it `deleting` in the Directory first, so its hostname stops working at once (`410`), and queues a cleanup job there. The job wipes the agent (runs aborted, app event subscriptions stopped, sockets closed, storage and alarms deleted, schedules and credentials with them), writes an erased mark into the empty storage, flushes it, and ends the agent's instance so nothing under way there can write afterwards. Every later instance finds the mark and refuses everything: requests (`410`), sockets, alarms and the service's own writes. That makes the agent itself the fence: a request a Worker authorized just before the deletion, or with an account it still had cached, can't write after it. The job then checks a fresh instance is marked and holds nothing, and wipes and checks the Auth object. Only then is the account `deleted`; a request that slipped in before the mark makes the check fail, and the retry wipes it.

What the fence stops, each covered by a test in `test/hosted/hosted.test.ts` ("erasure boundaries"):

- **Open sockets** are closed (code `4010`), and nothing sent on them afterwards is taken.
- **A request already inside the agent** when erasure starts ends with the instance: it gets `503`, a retry gets `410`, and its write never lands.
- **A model request under way** can't write its answer, and can't hold up the deletion: stopping runs and ending apps' subscriptions get 3 seconds before the wipe goes ahead regardless.
- **Approval timers** that outlive the agent decide nothing: under `auto`, an approval due after the deletion never runs its action.
- **Scheduled work** due afterwards never runs: the wipe clears the alarm, and an alarm that fires anyway does nothing.
- **A Worker with the account still cached**, its already-authorized requests and sockets, app event callbacks, and the service's own writes (`provision`, settings, limits, runs) all get `410`. Destroying an agent ends the call that asked for it, so that call's result is never trusted either way: the check decides. A failed attempt is retried on the Directory's alarm after 1, 5 and 30 minutes, 2 hours, then every 6 hours, and the person is told the account is closed and still being erased (`202`). The username stays taken.

## Before launch

The code is ready for review; these are not code, and are needed before real people use it:

1. **Cloudflare:** Workers Paid; the zone with a proxied wildcard record; `routes` and `PIMLING_DOMAIN` edited; rate-limit namespace IDs; the `PIMLING_ADMIN_TOKEN` secret.
2. **OpenAI:** confirm the hosted service may use ChatGPT-plan sign-in (OpenAI asks paid or remotely hosted apps to fill in its interest form), or turn that card off before launch.
3. **Data residency:** decide on a Durable Object jurisdiction before the first registration; objects can't move later.
4. **Passkeys on the real domain:** create, sign in and recover on real devices (iOS, Android, macOS, Windows) over HTTPS. The tests and the preview use software and virtual authenticators on `*.localhost`.
5. **Policy:** registration mode, invites and `PIM_LIMITS` for the expected cost, terms of service, privacy policy, and an abuse contact.
6. **Monitoring:** alerts in Workers Logs on `pimling.cleanup_failed` (with rising `attempts`) and `pim.misrouted` (which should never happen), and a watch on `pim.limit` and `pimling.rate_limited`.

## Known limits of Phase 1

- **Usernames can't change.** Passkeys belong to the hostname, and apps were given callback URLs on it. Renaming needs a central sign-in origin and permanent aliases.
- **Import** of an export is not built.
- **Data residency**: agents are created without a jurisdiction. Choosing one (for example `eu`) must happen before anyone registers, because an object can't move.
- **Account cache**: each Worker isolate trusts what it read about an account for up to 30 seconds. Suspensions reach the agent at once regardless. Deletions wipe credentials, so a stale cache can't open a deleted Pimling.
- **Directory**: one Durable Object holds every account and runs every cleanup. That is plenty for registration and lookups at moderate scale, since lookups are cached. Shard it by username before it becomes hot.
- **Email**: there is none. Recovery is codes, or the operator's setup link.
