# Pim at pim.ajac-zero.com

The owner's Pim: invite-only, with small limits for members. The owner is its admin.

- **Address:** <https://pim.ajac-zero.com>
- **Worker:** `pim` in the account `50fc740fb96dd3b4d9aeacd257575377`, zone `ajac-zero.com` (`17127fc4b18698c7c9a609d4ca36a628`, Free plan)
- **Config:** [`wrangler.ajac-zero.jsonc`](../../wrangler.ajac-zero.jsonc); deploy with `pnpm run deploy:ajac-zero`
- **TLS:** `pim.ajac-zero.com` is a Workers Custom Domain, so Cloudflare issues and renews its certificate. One hostname serves everyone, so no wildcard record or certificate is needed.

## Before

Before this, the account ran two test deployments. This one replaces both, and their data isn't kept, as the owner asked:

- the single-person Pim at `pim.ajac-zero.com` (Worker `pim`), with its agent and sign-in in the Durable Objects named `pim` and `auth`;
- hosted Pimling at `pimling.ajac-zero.com` (Worker `pimling`), with a person per subdomain, the owner's account and the tombstones of test accounts, and the `PIMLING_ADMIN_TOKEN` secret.

Their history, with every deploy and acceptance, is in this file as it was at [`f77583c`](https://github.com/ajac-zero/pim/blob/f77583c1eda80eddc8178c5210e548eac2ce64a3/docs/deployments/ajac-zero.md).

## Setup for the owner

1. **Claim it.** Open <https://pim.ajac-zero.com> within 15 minutes of the deploy, pick a username, save the recovery codes and create a passkey. Missed the window: the sign-in screen has the Worker write a setup link to its logs; in the dashboard, open Workers & Pages, then `pim`, then Observability, and open the link in the log that starts with "Pim setup link".
2. **Invite someone:** Settings → People on this Pim → Invite someone, and send them the link. It works once.
3. **Models.** Chats run on Workers AI (`@cf/zai-org/glm-4.7-flash`), billed to this account; members are capped by `PIM_LIMITS`, the admin isn't. Settings → "Use your ChatGPT plan" connects a person's own plan.
4. **Run it** from Settings, or with the admin API in [instance.md](../instance.md#running-it). Watch Workers Logs for the events listed there.

## Limits here

Invite-only; at most 25 accounts and 3 registrations per address a day. Per member, each day: 300,000 tokens, 300 model requests and 100 runs; at most 100 chats, 20 schedules, 10 apps and 200 MB; at most 100 artifacts, 50 versions each, 500,000 bytes a version and 10,000,000 bytes in all. The admin has no limits. Rate limits: 20 sign-in, recovery and registration attempts a minute per address, and 300 API requests a minute per person. Approvals default to explicit: unanswered ones are denied after 5 minutes.

## Removing it

`pnpm wrangler delete --config wrangler.ajac-zero.jsonc` removes the Worker, its custom domain and its Durable Objects with all their data. The certificate goes with the custom domain.
