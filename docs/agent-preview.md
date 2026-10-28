# Agent-driven preview: the browser harness and the banner

This is the browser side of an unsafe, authorized preview in which one agent uses the preview's web app and API without a person operating a passkey. It is for a REVIEW branch. **Nothing here has run**: the harness and its tests use fake Playwright objects, and no browser, socket, process, login or credential has been involved. It implements no authentication. The exchange, the session cookie and its validation belong to the auth branch (T-01a180b4-b1fc-77e6-a0d9-ac2d85e474fb); this branch waits for its contract.

## What an agent gets

Both a browser UI and API requests, from one sign-in. Playwright's `BrowserContext.request` shares the context's cookie jar, so the harness POSTs the credential once through it, the Worker's Secure HttpOnly cookie stays in that context's memory, and the same context reads the API (`context.request.get`) and loads pages (`context.newPage`). The existing browser tool cannot attach to this context; an interactive controller must be a Playwright script that imports `computer/cua-host/agent-preview.ts` and drives the session it returns. Nothing is stored: there is no `storageState` method, no profile, no trace, video or HAR, and a context ends with the session.

```diagram
 operator dir (0700)           Playwright, fresh headless Chromium
 └─ credential (0600) ──read──▶ isolated BrowserContext ── POST once ──▶ preview origin (exact)
                                  │  cookie jar (memory)  ◀── Secure HttpOnly cookie
                                  ├─ request.get /api/observations  (same jar)
                                  └─ page.goto /                    (same jar)
```

## The harness (`computer/cua-host/agent-preview.ts`)

`openAgentPreview({ origin, credentialFile, adapter, deadline })` returns a session; `diagnoseObservations(session)` is the first command.

- **Credential.** One file: an absolute, normalized path, in a directory of this account's with mode `0700`, the file a regular file of this account's with mode `0600` and one link, opened without following links, 16–4096 printable characters. Not an environment variable, argument, URL or chat message. Errors name what is wrong, never the path or content.
- **Origin.** Exactly an `https` origin as configured (no path, query or user). The exchange and every request go to it with no redirect followed (a redirect closes the session), and the context aborts any browser request to another origin or any page request that isn't a GET or HEAD. The exchange sends `Origin` itself, since Playwright's request context doesn't and the Worker's writes require it.
- **Isolation.** A fresh `chromium.launch` for the run, never `connectOverCDP` or a persistent profile, so none of the human's cookies or passkeys. Downloads, service workers and permissions are off. WebSockets and the context's other transports are not routed; the cookie and origin rules are what bound them.
- **Lifetime.** The session ends at the adapter's expiry, which the harness refuses unless it is within 30 minutes and before the evaluation's `deadline`. A timer closes the context and browser at that time; each call checks it; a session makes at most 50 requests. The cookie must be Secure, HttpOnly, host-only for the origin, and not outlast the session.
- **One attempt.** A refused or failed exchange, a 401/403, a redirect or a network error closes everything and throws once. Nothing is retried.
- **Output.** Metadata only: origin, expiry, requests left, observation ids, statuses, `notAfter`, whether a host launch is recorded (not its id), and the banner text. Every error is a fixed sentence and code with at most an HTTP status. The credential and cookie values are also scrubbed from anything the harness reads from the page or API. Do not take screenshots or network traces of an authenticated page with request headers or cookies in them.
- **Read only.** The session can `GET /api/observations` and `GET /api/observations/<id>`, no query, and inspect a page. It has no Watch, End, setup, enrollment or tool call, and startup makes none. The first live command is `diagnoseObservations`: one list request and one load of `/`, to see the unresolved observation as it is. The observation routes refuse a request with an `Authorization` header, so after the exchange none is sent.

## The adapter the harness needs

```ts
interface ExchangeAdapter {
  path: string; // the exchange route on the origin, a plain path
  request(credential: string): { headers?: Record<string, string>; data?: unknown };
  accept(status: number, body: unknown): { expiresAt: number } | null; // Unix ms
}
```

There is no default. The auth branch's real contract replaces it; nothing here guesses a second protocol. Expected of that contract: the credential is bound to the exact preview origin, the deployment/evaluation and the existing owner; the session lasts at most 30 minutes and never past the evaluation deadline (the harness checks both again); the cookie is Secure and HttpOnly and set on the exact host; the API requests made with that cookie count as the owner's browser session (the observation routes require `viaSession`).

## The banner

While the mode is on, every page shows **UNSAFE PREVIEW — agent access enabled** in a red bar (`web/src/components/agent-preview-banner.tsx`), signed in or not, to a human as much as to the automation session. For an automation session it adds when it ends and, after that, that it expired. It shows no secret. When the mode is absent the app renders exactly as before. The web app learns of the mode from `agentPreview?: { enabled: true; expiresAt?: number | null }` on the existing `/auth/session` answer (`AuthSession` in `web/src/lib/auth.ts`). **That field is an assumption the auth branch must supply**: until it does, no banner shows.

## Tests

`pnpm --filter pim-cua-host test` runs `test/agent-preview.test.ts` (with the rest); `pnpm --filter pim-web test` runs the banner's. They prove: one context serves the exchange, an API read and a page; the credential only goes in the POST; isolated context options; the origin rules and route aborts; file-permission refusals; redaction; the lifetime limits, timer close and request cap; no retry after a refusal; and that first use is read only.

## Not done

The real adapter and the backend's `agentPreview` field; an interactive controller script; Playwright as an installed dependency; any run of a real browser. Review comes first.
