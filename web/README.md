# Pim's web app

Chat with streaming replies and tool calls, approve or deny the actions Pim
asks to take, read its notifications, and manage its model and passkeys.

It is its own component (see the [repository's README](../README.md)): the web host
([`web-host/`](../web-host/)) serves the built app from `web/dist`, and the Pim server serves the API under
`/api` and passkey sign-in under `/auth`; a proxy sends each path to one or the other. Built from [parley](https://github.com/ajac-zero/parley)'s chat UI:
React, TanStack Router and Query, Tailwind, shadcn/ui.

## Develop

Run Pim's preview (`node scripts/v2-dev/preview.mjs` at the repository's root, or `amp orb services ensure`), then, in another terminal:

```sh
PIM_API_TOKEN=... pnpm dev:web
```

with an API token you made in Settings. The dev server (port 3000) proxies
`/api` to the server with that token and signs you in as its owner, so there
are no passkeys here. To try passkeys, use the server's
own address, `http://localhost:8787`. `PIM_API_URL` points the proxy at
another Pim; both variables can live in `web/.env.local`.

```sh
pnpm --filter pim-web test       # reducer tests
pnpm --filter pim-web typecheck
pnpm --filter pim-web lint
```
