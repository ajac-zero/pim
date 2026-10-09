# Pim's web app

Chat with streaming replies and tool calls, approve or deny the actions Pim
asks to take, read its notifications, and manage its model and passkeys.

The Pim Worker serves it (see the [repository's README](../README.md)): the
built app from `web/dist`, the API under `/api`, and passkey sign-in under
`/auth`. Built from [parley](https://github.com/ajac-zero/parley)'s chat UI:
React, TanStack Router and Query, Tailwind, shadcn/ui.

## Develop

Run Pim with `pnpm dev` at the repository's root, then, in another terminal:

```sh
PIM_API_TOKEN=... pnpm dev:web
```

The dev server (port 3000) proxies `/api` to the Worker with that token and
signs you in, so there are no passkeys here. To try passkeys, use the Worker's
own address, `http://localhost:8787`. `PIM_API_URL` points the proxy at
another Pim; both variables can live in `web/.env.local`.

```sh
pnpm --filter pim-web test       # reducer tests
pnpm --filter pim-web typecheck
pnpm --filter pim-web lint
```
