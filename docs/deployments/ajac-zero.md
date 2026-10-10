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

## What was changed (2026-10-10)

| Change | ID | Made by |
| --- | --- | --- |
| Worker `pimling` with Durable Objects `Pim`, `Auth`, `Directory` (migrations v1–v3), rate limits `71420101`, `71420102` | First version `0e8a60a3-0bf5-4f9f-9e2a-25712ec656b6` | `pnpm run deploy:ajac-zero` |
| Custom domain `pimling.ajac-zero.com` → `pimling` | `e188214063dbb191c911b164ae6189cea32d4dc7` | wrangler (`custom_domain: true`) |
| DNS `AAAA pimling.ajac-zero.com` (proxied) | `19fe94b9ae5bbfd5055cde0d7b76ae09` | Created with the custom domain |
| Certificate pack for `pimling` and `*.pimling` | `fbaf98c3-32fe-4a27-872d-34a24e4f5ab1` | Created with the custom domain |
| Route `*.pimling.ajac-zero.com/*` → `pimling` | `2e20f82bce114f189580235400c048fe` | wrangler (`routes`) |
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

- **To an earlier version:** `pnpm wrangler rollback --name pimling` (or `pnpm wrangler versions list --name pimling` and roll back to a version ID).
- **To remove the deployment entirely,** which erases every Pimling's data:
  1. `pnpm wrangler delete --name pimling`. This removes the Worker, its route and custom domain, and its Durable Objects with all their data.
  2. Delete DNS record `16774988657fb34e6ee8d4b8eb02ef3b` (`*.pimling.ajac-zero.com`).
  3. Delete DNS record `19fe94b9ae5bbfd5055cde0d7b76ae09` (`pimling.ajac-zero.com`) if the custom domain didn't take it.

  The certificate pack goes with the custom domain.

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
