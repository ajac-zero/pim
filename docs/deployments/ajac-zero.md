# Pimling at pimling.ajac-zero.com

The owner's private test deployment of Pimling: invite-only, with small limits. Not a public launch.

- **Front door:** <https://pimling.ajac-zero.com>
- **Each person:** `https://<username>.pimling.ajac-zero.com`
- **Worker:** `pimling` in the account `50fc740fb96dd3b4d9aeacd257575377`, zone `ajac-zero.com` (`17127fc4b18698c7c9a609d4ca36a628`, Free plan)
- **Config:** [`wrangler.ajac-zero.jsonc`](../../wrangler.ajac-zero.jsonc); deploy with `pnpm run deploy:ajac-zero`
- **Separate from** the self-hosted Pim at `pim.ajac-zero.com` (Worker `pim`), which this deployment doesn't touch.

## TLS for `*.pimling.ajac-zero.com`

Universal SSL covers `ajac-zero.com` and `*.ajac-zero.com`, one level deep: the front door, but not the tenants. The zone has no Advanced Certificate Manager quota (`allocated: 0`) and no SSL for SaaS, and Total TLS is off.

Making `pimling.ajac-zero.com` a Workers Custom Domain gave it an advanced certificate, at no charge, for `ajac-zero.com`, `pimling.ajac-zero.com` and `*.pimling.ajac-zero.com` (pack `fbaf98c3-32fe-4a27-872d-34a24e4f5ab1`, Google Trust Services, TXT validation that Cloudflare manages). Every other custom domain in the zone has the same shape. Tenants are then routed by `*.pimling.ajac-zero.com/*` with a proxied wildcard record. Names two labels under `pimling` have no certificate and are not served.

Cloudflare renews the certificate along with the custom domain. If the custom domain is removed, the tenant certificate goes with it. The fallback is Advanced Certificate Manager on the zone, which is paid (check the current price in the dashboard before buying).

## Current state

| | |
| --- | --- |
| Serving | `ce9b2eae-0edc-4dc9-9b85-97ca8dbbcd75` (100%), deployed 2026-10-10 09:15 UTC from `main` at [`b2df73f`](https://github.com/ajac-zero/pim/commit/b2df73fb0393d0a553caafe65c2afd0a7f1d4d4a) (merge of #6) |
| Rollback target | `096158e7-b612-40dc-a667-dced2a1fe6fc` (#5 at `8fc824c`, serving until the #6 deploy) |
| Route `*.pimling.ajac-zero.com/*` | `527b24a6091b429d966537aa01ac254d`; wrangler recreates it on each deploy, with a new ID and the same pattern and script |
| Accounts | the owner's, plus `deleted` tombstones of test accounts |

## History

| Version | Deployed | From | Notes |
| --- | --- | --- | --- |
| `0e8a60a3-0bf5-4f9f-9e2a-25712ec656b6` | 2026-10-10 06:37 | `main` `9c0a423` (#2) | First upload |
| `d88a37fc-99f9-4dbf-85b5-76a420c47b08` | 2026-10-10 06:38 | the same bundle | `PIMLING_ADMIN_TOKEN` set |
| `096158e7-b612-40dc-a667-dced2a1fe6fc` | 2026-10-10 07:58 | `main` `8fc824c` (#5) | Add another device, front-door sign-in, #4's copy |
| `ce9b2eae-0edc-4dc9-9b85-97ca8dbbcd75` | 2026-10-10 09:15 | `main` `b2df73f` (#6) | Add another device: Done waits for revocation, passkey list refreshes, a device with a passkey can sign in; the live smoke script's cleanup and checks |

## What was changed (2026-10-10)

| Change | ID | Made by |
| --- | --- | --- |
| Worker `pimling` with Durable Objects `Pim`, `Auth`, `Directory` (migrations v1–v3), rate limits `71420101`, `71420102` | First version `0e8a60a3-0bf5-4f9f-9e2a-25712ec656b6` | `pnpm run deploy:ajac-zero` |
| Custom domain `pimling.ajac-zero.com` → `pimling` | `e188214063dbb191c911b164ae6189cea32d4dc7` | wrangler (`custom_domain: true`) |
| DNS `AAAA pimling.ajac-zero.com` (proxied) | `19fe94b9ae5bbfd5055cde0d7b76ae09` | Created with the custom domain |
| Certificate pack for `pimling` and `*.pimling` | `fbaf98c3-32fe-4a27-872d-34a24e4f5ab1` | Created with the custom domain |
| Route `*.pimling.ajac-zero.com/*` → `pimling` | `2e20f82bce114f189580235400c048fe` at first; `21daa95d2ba14a6ab3f2ff4c496cb0bf` from the #5 deploy; `527b24a6091b429d966537aa01ac254d` since the #6 deploy (wrangler recreates it) | wrangler (`routes`) |
| DNS `AAAA *.pimling.ajac-zero.com` → `100::` (proxied) | `16774988657fb34e6ee8d4b8eb02ef3b` | API, by hand (not in the config) |
| Secret `PIMLING_ADMIN_TOKEN` | Serving version `d88a37fc-99f9-4dbf-85b5-76a420c47b08` (the same bundle, with the secret) | `wrangler secret put` |

Nothing else in the zone changed. All 26 DNS records, the `packages.ajac-zero.com/*` route, and the other 10 custom domains are as they were.

## Setup for the owner

1. **The admin token** is in the orb that deployed this, at `~/pimling-deploy/admin-token` (mode 600). Copy it somewhere safe, such as a password manager. To replace it, run `pnpm wrangler secret put PIMLING_ADMIN_TOKEN --config wrangler.ajac-zero.jsonc` with a new random value. Never paste it into a chat, an issue or a commit.
2. **Invite someone** (codes are single-use):
   ```sh
   curl -X POST https://pimling.ajac-zero.com/admin/invites \
     -H "Authorization: Bearer $PIMLING_ADMIN_TOKEN" -H "content-type: application/json" \
     -d '{"count": 1, "note": "for …"}'
   ```
3. **Register** at <https://pimling.ajac-zero.com> with a username and the invite. Save the recovery codes, then continue to the new Pimling and create a passkey on your device.
4. **Models.** Chats run on Workers AI (`@cf/zai-org/glm-4.7-flash`), billed to this account and capped by `PIM_LIMITS`. Settings → "Use your ChatGPT plan" connects a person's own plan. OpenAI's token-sharing docs ask remotely hosted apps to fill in its interest form; this test deployment keeps the feature on, as the owner asked.
5. **Operate** with the admin API in [hosting.md](../hosting.md#operating-it): stats, accounts, suspend, limits, setup links, delete. Watch Workers Logs for the events listed there.

## Limits here

Invite-only; at most 25 accounts and 3 registrations per address a day. Per person, each day: 300,000 tokens, 300 model requests and 100 runs; at most 100 chats, 20 schedules, 10 apps and 200 MB. Rate limits: 20 sign-in, recovery and registration attempts a minute per address, and 300 API requests a minute per person. Approvals are explicit: unanswered ones are denied after 5 minutes.

## Rollback

- **To an earlier version:** `pnpm wrangler rollback 096158e7-b612-40dc-a667-dced2a1fe6fc --name pimling --message "…"` (the version before #6; #6 changed only the web app and the smoke script, with no new Durable Object migration), `d88a37fc-99f9-4dbf-85b5-76a420c47b08` (before #5), or `pnpm wrangler versions list --name pimling` for others. A rollback changes code only: Durable Object data, the route, the custom domain and the secret stay as they are. Devices added with #5 keep their passkeys, which work with any version.
- **To remove the deployment entirely,** which erases every Pimling's data:
  1. `pnpm wrangler delete --name pimling`. This removes the Worker, its route and custom domain, and its Durable Objects with all their data.
  2. Delete DNS record `16774988657fb34e6ee8d4b8eb02ef3b` (`*.pimling.ajac-zero.com`).
  3. Delete DNS record `19fe94b9ae5bbfd5055cde0d7b76ae09` (`pimling.ajac-zero.com`) if the custom domain didn't take it.

  The certificate pack goes with the custom domain.

## Acceptance of version `ce9b2eae` (2026-10-10)

- **Merge:** #6 merged at its reviewed head [`27d1d87`](https://github.com/ajac-zero/pim/commit/27d1d87e35831be2ef8b7e9787f2761aefae61ff) as [`b2df73f`](https://github.com/ajac-zero/pim/commit/b2df73fb0393d0a553caafe65c2afd0a7f1d4d4a); both have tree `71177dabfdb1f714aaf37b885f17705bee097fdd`. Deployed from a clean checkout of that commit, with the config, secret and limits unchanged.
- **Before merging, on the reviewed head** (independently repeated by the reviewers): typecheck; 177 Worker tests and 15 web tests; web build; web lint with only the existing warnings; `wrangler deploy --dry-run` for this config and the self-hosted one; `node --check scripts/live-device-smoke.mjs`. On a local preview, the smoke script passed 30 of 30, and its error paths were checked with temporary server mutations:
  - deletion forced to answer `202`: accepted (the script before #6's last round failed it);
  - deletion answering `500` (a malformed version of that mutation): failed;
  - the write before deletion forced to `500`, and the write after it forced to `201`: each failed;
  - registration forced to `500`, then admin cleanup: a `404` naming `No account <username>` counted as cleaned, while a plain `Not found` (admin API off) gave `CLEANUP NEEDED` and exit `2`.

  Separately, cleaning up an account already deleted elsewhere got `410`, which counted as closed.
- **Live, read-only, after deploying:** `/health` `200`; the front door `200`; front-door lookup `200` for the owner's username and `404` for an unknown name and for `x@evil.com#`; `/admin/stats` `401` with no token and with a wrong one; an unknown tenant `404`; the deleted `smoke-dev3` `410`; the owner's host serves the app (`200`) and refuses an anonymous API request (`401`); the live bundle matches the local build (`assets/index-DvLwDMRG.js`); the tenant certificate covers `ajac-zero.com`, `pimling.ajac-zero.com` and `*.pimling.ajac-zero.com`, until 2027-01-08.
- **No disposable live run:** #6 changed only web flows and the smoke script, covered above, so no invite or account was made. Admin stats afterwards: 1 active account (the owner's), 0 pending, 0 deleting, 4 deleted, 2 unused invites, no cleanup queued or failing. The owner's account wasn't touched.
- **Cloudflare:** only the tenant route was recreated (new ID above). The `packages.ajac-zero.com/*` route and the other 10 custom domains were present after the deploy.

## Acceptance of version `096158e7` (2026-10-10)

- **Owner, on real devices:** memory, scheduling, approvals, and signing in on a phone with Add another device all work.
- **Scripted, over real HTTPS, from a second orb** (the first had used up its daily registration limit): 29 of 30 checks with the disposable account `smoke-dev3`, which was deleted.
  - **What passed:** lookup; the desktop passkey; the QR code (decoded from a screenshot); the phone naming the Pimling, the code cleared from the address bar and never sent in a URL; the phone's own passkey and signing in with it alone; replay refused; the desktop, its passkey and all 10 recovery codes untouched; deletion, then `410`.
  - **The one failure** was the last check, "phone's session is gone too". The phone had already signed out by then, and its request didn't get `410` at that moment; 20 seconds later it did. That fits the gateway's 30-second account cache: an anonymous request served from a cache that still thinks the account is active gets `401`, not `410`. A signed-in request is refused by the agent either way.
- **[`scripts/live-device-smoke.mjs`](../../scripts/live-device-smoke.mjs)** now:
  - keeps the phone signed in through the deletion;
  - records exact statuses;
  - checks refusal at once and `410` after the cache window separately;
  - bounds every browser operation (`--cdp-timeout-ms`, default 30 s), so cleanup still runs when a browser hangs;
  - writes once before deleting (expecting `201`), so the refusal afterwards (`401`, `403` or `410` only) means something;
  - on a failure, including a registration whose answer was lost, tries to delete the disposable account with the desktop's session, at the Pimling's own host. That session exists only after the desktop's first passkey. With `--admin-token-file`, it falls back to the admin API, which also deletes an account that never got a passkey. For cleanup, `200`, `202` and `410` all count as closed; the run's own deletion must answer `200` or `202` (closed, still being erased). The admin API's `404` counts only as `No account <username>`; a plain `Not found` (admin API off, wrong route) doesn't. Without that file, a failure before the first passkey leaves a pending account (it lapses in a day).
  - says `CLEANUP NEEDED` and exits `2` whenever the account may be left behind. It never prints the token or any code.

  Run it from a network that hasn't used up the registration limit:

  ```sh
  node scripts/live-device-smoke.mjs --domain pimling.ajac-zero.com --username smoke-devN \
    --invite-file ./invite --admin-token-file ~/pimling-deploy/admin-token \
    --desktop-port 9351 --phone-port 9352
  ```

## Smoke test (2026-10-10, version `d88a37fc`)

Over real HTTPS, with disposable accounts `smoke-a1`, `smoke-b1` and `smoke-browser`, which were all deleted afterwards (29 of 29 scripted checks, plus a browser run):

- **Front door and TLS:** the front door serves the Universal SSL certificate; tenant hosts serve the `*.pimling.ajac-zero.com` certificate; an unknown tenant gets `404`.
- **Registration:** refused without an invite; each invite works once; a passkey is made from the setup link; the account becomes active with a distinct owner ID.
- **Isolation:**
  - a session cookie and an API token each open nothing at another person's host;
  - a hostname alone opens nothing;
  - memories don't cross between people;
  - ChatGPT-plan sign-in starts per person, with distinct agent host IDs.
- **Settings and limits:** the time zone comes from registration, approvals are explicit, and the limits above apply.
- **Model path:** a Workers AI answer in 2.7 s, metered (1 request, 3,284 tokens).
- **Recovery:** a recovery code makes a passkey once.
- **Deletion:** `200 { deleted: true }`, then the host answers `410`, admin shows `deleted` with no cleanup left, and the account's token stops working.
- **In Chrome**, with a virtual authenticator: registration, a real WebAuthn passkey on the tenant host, a chat answered by the model, and deletion from Settings.

Deleted usernames stay reserved by design. The three test usernames remain as `deleted` tombstones, with no data in them.
