# Guests, circles, the admin's majordomo and the Gate's limits on V2

What the workstream "admin and guests" added to `pim/v2-canonical`, where it lives and what it does not do. The rows it answers are B1.12, B1.14, B1.18, B2.19, B2.22 and B3.21 of [v2-inventory-coverage.md](v2-inventory-coverage.md), and circle permissions (B1.16's deferred part).

## Guests of a shared bot (`@pim/v2-app/guests`, `packages/v2-server/src/guest-tools.ts`)

Only an admin shares an agent as a bot (`PUT /api/agents/:id/bot`, `admin:bots`). The link `/b/<id>` is live while its author is an active admin. `POST /auth/register {username, bot}` makes a guest account (role `guest`, `bot = true`) whatever the registration mode, under the per-address limit, with its own copy of the bot's agent (`pim_app.guest_bots`). The guest chats in their own space, on their own runs; what they can reach of the host's space is the **boundary**, which `Guests.boundary` re-reads on every call:

- `guest_tools` and `guest_call` are the only tools that leave the guest's space. They reach the connectors of the host that the bot lists (`bots.settings.tools`, `ask`) and the connector has enabled; a tool the host did not grant answers as one that does not exist. A destructive tool always asks.
- A guest's agent has a short list of tools (its own memory, skills, the clock, `send_to_user`, the two above): nothing of a computer, files, coding, the web or the host's other connectors. A chat of kind `visit` in a host's space has `send_to_user` and the clock only.
- A tool that asks files an approval **on the host** (`g-<digest of guest, chat, call>`, so a replay finds the same one; a day to answer, then denied, never approved by time). The host decides it in their approvals (the card says who asked); the Gate carries the decision to the guest's parked task (`deliverApprovalDecisions`, `sweepApprovals`). "Always approve" opens the tool to that bot or circle alone and settles its other waiting calls of it.
- Limits: calls a day (`dailyToolCalls`, default 20, 200 for a circle's member) and messages a day (`dailyMessages`, default 50), counted in `pim_app.guest_calls`; a bot turned off makes both 0. The host reads what guests did at `GET /api/circles/activity` (`guest_activity`, kept to 500).
- A route allow-list for guests in `limits.ts` (chats, files, goals, schedules, notifications, their agent, settings, their account); anything else is 403.

## Circles (`compat/guests.ts`)

Circles answer in the web app's shape: up to 20 circles of up to 40-character names, 200 people in all, a person in at most one circle (adding moves them), `enabled` (pause), `memoryScopes`, members with when they came in. A new circle has every tool off. `GET/PUT /api/permissions` with `circle` set the host's Off/Ask/On for the circle (`tool_permissions`, audience `circle:<id>`); the host's own agents never read those rows. A member visits a host with `POST /api/visits/:username`: a chat in the member's own space (`visit_links`) whose `guest_call` is judged by the circle (member removed, circle paused, tool off, calls used: each refuses the next call).

## The admin's majordomo (`admin-tools.ts`)

`admin_read` (any GET of `/api/admin/*`), `admin_write` (what can be undone) and `admin_write_approved` (every DELETE, providers and keys, compute, sign-in, setup links, invites, suspending: the admin approves each one, never a standing approval). Only the majordomo of an active admin has them; each call goes through the same route a screen does, with secrets stripped from the answer and a row in the audit log. `GET /api/admin/stats`, paged `GET /api/admin/accounts` and one account by name are the admin API's reads for it.

## Built-in apps, shared providers, limits

- Built-in apps (Notes): `/api/admin/builtin-apps` and `/api/builtin-apps`; off for everyone means no Notes routes and no note tools.
- An admin's provider with `config.shared` (`POST /api/admin/providers`) is in every catalog as `shared:<id>`, key opened under the admin's owner id (`pim_app.shared_providers`, migration 0626, which reads only an active admin's rows).
- Limits (`limits.ts`, `pim_app.rate_limits`): `auth` 30 a minute per address, `api` 600 a minute per owner (snapshot reads exempt), `public` 600 a minute per address; `PIM_RATE_AUTH|API|PUBLIC` override, an unreadable value is 0. The address is `x-pim-client-ip` when `PIM_INGRESS_SECRET` is set.

## Not done

Hosted apps' backends and the app bridge (another workstream), a circle member's visit running on the member's own model with the host's brief and memory view (a visit here is the member's own agent with `guest_call`), the host's time zone and `recall` of a circle's memory scopes in a visit, per-account limits (`PUT /api/admin/accounts/:u/limits`) and compute quota, Web Push for a guest's ask, a bot's model override (stored, not applied), a bot's `generate_image`.
