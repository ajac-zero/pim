# Pim at pim.ajac-zero.com

The owner's Pim: invite-only, with small limits for members. The owner is its admin.

- **Address:** <https://pim.ajac-zero.com>
- **Worker:** `pim` in the account `50fc740fb96dd3b4d9aeacd257575377`, zone `ajac-zero.com` (`17127fc4b18698c7c9a609d4ca36a628`, Free plan)
- **Config:** [`wrangler.ajac-zero.jsonc`](../../wrangler.ajac-zero.jsonc); deploy with `pnpm run deploy:ajac-zero`
- **TLS:** `pim.ajac-zero.com` is a Workers Custom Domain, so Cloudflare issues and renews its certificate. One hostname serves everyone, so no wildcard record or certificate is needed.

## Before

Before this, the account ran two test deployments. This one replaces both, and their data wasn't kept, as the owner asked:

- the single-person Pim at `pim.ajac-zero.com` (Worker `pim`), with its agent and sign-in in the Durable Objects named `pim` and `auth`;
- hosted Pimling at `pimling.ajac-zero.com` (Worker `pimling`), with a person per subdomain, the owner's account and the tombstones of test accounts, and the `PIMLING_ADMIN_TOKEN` secret.

Their history, with every deploy and acceptance, is in this file as it was at [`f77583c`](https://github.com/ajac-zero/pim/blob/f77583c1eda80eddc8178c5210e548eac2ce64a3/docs/deployments/ajac-zero.md).

## Current state

| | |
| --- | --- |
| Serving | `a68679a2-ac89-4ded-8607-997805a51685` (100%), deployed 2026-10-12 05:03 UTC from `main` at [`b2bf345`](https://github.com/ajac-zero/pim/commit/b2bf345) (images in chat) |
| Custom domain `pim.ajac-zero.com` | `936379e175647dd9c83f50a4ef5010cd7e11966e`, with DNS record `327d910050f4a2b3fd9eb711e651be20` (`AAAA 100::`, proxied), both made by wrangler |
| Durable Object namespaces | `Pim` `1ec6ba0dd84b4c0f941ff5ee3846e894`, `Auth` `5ade5dd299084d47af5bcb21f5bd2da8`, `Directory` `876c4e51b412464c80d5f3718bf5c069`, `Gallery` `931c10f09aad431487bba687aef3b745` (migrations v1 to v4, all new) |
| R2 bucket | `pim-images` (binding `IMAGES`), made with `wrangler r2 bucket create` before the deploy of `b2bf345`: the images people send in chats |
| Secrets | none |
| Accounts | claimed by the owner |

## The deploy of 2026-10-11

- **Removed first,** with `wrangler delete --force`: the Worker `pimling` (its custom domain `pimling.ajac-zero.com`, its route `*.pimling.ajac-zero.com/*`, its secret and its four Durable Object namespaces with all their data) and the Worker `pim` (its custom domains `pim.ajac-zero.com` and `api.pim.ajac-zero.com`, which wasn't in any config, and its two Durable Object namespaces with all their data). The DNS records of those custom domains went with them. The wildcard record `*.pimling.ajac-zero.com` (`16774988657fb34e6ee8d4b8eb02ef3b`), made by hand, was deleted through the API. Nothing else in the zone was touched: the `packages.ajac-zero.com/*` route and the other custom domains are as they were.
- **Checked before deploying,** at `c9781f5`: typecheck, 204 Worker tests and 25 web tests, the web build, and `wrangler deploy --dry-run` with this config. In Chrome with virtual passkeys against the local preview: claiming, recovery codes and the first passkey, inviting and joining, signing out and in, suspending, recovery and the logs' setup link.
- **Live, read-only, after deploying:** `/health`, the app shell and `/settings` `200`; `/auth/session` says not claimed, claimable, invite-only; anonymous `/api/sessions` and `/api/admin/stats` `401`; a made-up token `401`; app callbacks for an unknown owner `404`; the certificate covers the hostname until 2026-12-31. No account was made: the first one is the owner's.

## Setup for the owner

1. **Claim it.** Open <https://pim.ajac-zero.com> within 15 minutes of the deploy, pick a username, save the recovery codes and create a passkey. Missed the window: the sign-in screen has the Worker write a setup link to its logs; in the dashboard, open Workers & Pages, then `pim`, then Observability, and open the link in the log that starts with "Pim setup link".
2. **Invite someone:** Settings → People on this Pim → Invite someone, and send them the link. It works once.
3. **Models.** Chats run on Workers AI (`@cf/zai-org/glm-4.7-flash`), billed to this account; members are capped by `PIM_LIMITS`, the admin isn't. Settings → "Use your ChatGPT plan" connects a person's own plan.
4. **Run it** from Settings, or with the admin API in [instance.md](../instance.md#running-it). Watch Workers Logs for the events listed there.

## Limits here

Invite-only; at most 25 accounts and 3 registrations per address a day. Per member, each day: 300,000 tokens, 300 model requests and 100 runs; at most 100 chats, 20 schedules, 10 apps and 200 MB; at most 100 artifacts, 50 versions each, 500,000 bytes a version and 10,000,000 bytes in all. The admin has no limits. Rate limits: 20 sign-in, recovery and registration attempts a minute per address, and 300 API requests a minute per person. Approvals default to explicit: unanswered ones are denied after 5 minutes.

## Removing it

`pnpm wrangler delete --config wrangler.ajac-zero.jsonc` removes the Worker, its custom domain and its Durable Objects with all their data. The certificate goes with the custom domain.
