# v2 connectors, watches and Pim's own MCP server

How a person connects services to Pim on v2, what an agent can then do with them, and where each part lives. It covers the directory (`/api/app-directory`), native connectors (Gmail, Google Drive, Spotify), OAuth sign-in to remote MCP servers, per-tool permissions, watches, and Pim as an MCP server. Ported from v1's `src/extensions/{app-directory,native-apps,gmail,google,google-drive,spotify,popular-apps,app-events}.ts` and `src/mcp-server.ts`.

## What a connection is

One row of `pim_app.connectors` per connection, owner-scoped by row-level security:

| Column | Meaning |
|---|---|
| `kind` | `native` (Pim implements the service: Gmail, Drive, Spotify), `custom_mcp` (a remote MCP server), `builtin` |
| `url` | the MCP server's address; null for a native connector |
| `app_ref` (0640) | the directory entry it connects: `google/gmail`, `google/drive`, `spotify/spotify`, `pim.apps/<id>` (popular servers), `custom/<id>` (the admin's); null when added by address. One connection per entry per person |
| `status`, `auth_url`, `error` (0640) | `connected`; `auth_required` with the address to send the person to; `disconnected` with why it failed |
| `credential` | the sealed credential (below) |
| `enabled_tools`, `discovered_tools`, `approval` | which tools exist and are on, and the connector's default (`writes`: read-only tools run, others ask; `all`; `none`) |

**Credential shape.** The sealed value (key ring, AAD `connector:<owner>/<id>`) is a bearer token, or a JSON bundle, which is what OAuth sign-ins store and what a migration of a v1 connection should write:

```json
{ "access_token": "…", "refresh_token": "…", "expires_at": 1763000000000, "token_endpoint": "https://…/token", "client_id": "…", "client_secret": "…", "scope": "…", "files": [] }
```

`expires_at` is in milliseconds. Whoever uses the credential renews it first when it is within 30 s of expiring (`refresh` in `packages/v2-server/src/connector-tools.ts`): the Runner before a call, the Gate before a Drive action, maintenance before a watch renewal; the new bundle replaces the sealed value. `files` is Google Drive's picked files. A v1 native credential (`{ accessToken, refreshToken, expiresAt, scope }`, sealed under `APP_CREDENTIALS_KEY`) converts field by field once the provider's token endpoint and the deployment's client are added; the person's grant at the provider stays valid. A v1 MCP server's registration is not in the export, so those servers are connected again.

## The directory and connecting

`GET /api/app-directory` lists, in this order: the popular remote MCP servers (`native/popular-apps.ts`, generated from v1; GitHub only when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set, since its server takes no registration), the native connectors whose OAuth client the admin set, then the admin's own (Settings → Admin). `POST /api/mcp { app }` connects an entry; `{ url, name?, credential? }` connects a server by its address. `GET /api/mcp` lists the person's connections with their state (`ready`, `authenticating` with `authUrl`, `failed` with `error`); `PUT /api/mcp/:id { approval }` sets the policy; `DELETE /api/mcp/:id` ends it (a native connector's grant is revoked at Google).

- **Native sign-in** (`ConnectorService`, `packages/v2-server/src/connector-service.ts`): authorization code with PKCE (S256) at the provider; the client is the admin's, from the environment. The provider returns the browser to `/mcp/callback/apps` (one address for everyone, as in v1, which is what gets registered at the provider). The sign-in's `state` is its own secret in `pim_app.auth_flows`, good fifteen minutes and once; a return in a browser signed in as someone else is refused. Google's sign-in must grant exactly the scopes the connector asks for and offline access, else nothing is kept and the grant is revoked.
- **MCP sign-in** (`native/oauth-client.ts`, the MCP authorization spec): Pim initializes the server without a credential; a 401 starts discovery (the `WWW-Authenticate` `resource_metadata`, or `/.well-known/oauth-protected-resource`, then the authorization server's metadata), then RFC 7591 registration of Pim as a public client (`redirect_uri` `/mcp/callback/<owner>`), or the admin's client (GitHub, at `/mcp/callback/apps`), or a client metadata document (Amp: `GET /mcp/client/<owner>`). A server that needs no sign-in is connected at once, as is one given a token.
- Everything reaching a remote server (probe, metadata, registration, tools) refuses private addresses unless `PIM_CONNECTOR_ALLOW_PRIVATE=1`, which a homelab sets; it also allows `http://` servers there.

## What an agent can do

`connector_tools` and `connector_call` (Runner, `connector-tools.ts`) serve MCP and native connectors alike: `connector_tools` lists every tool a person has left on, 25 a page, and finds one by connector or query (the prompt names the first 60), `connector_call` checks the arguments against the tool's input schema before anyone is asked, and a picture a tool returns reaches the model as an image. Registering each tool as a tool of its own, as v1 did, is not possible here: a Runner's tools are fixed when its partition opens, while a connector's change. The agent also finds, connects and manages connectors (`connector-admin-tools.ts`, over `ConnectorService`): `find_connector`, `list_connectors`, `connect_connector` (answers with the link the person signs in at), `manage_connectors` (changes the agent's own list once the person approves) and the admin majordomo's `add_custom_connector`. Each tool is Off/Ask/On (Settings → Permissions, `tool-permission-routes.ts`) and "always approve" on an approval. A native connector's tools are Pim's own (`native/gmail.ts`, `drive.ts`, `spotify.ts`): read-only ones (Gmail `search`/`get_message`/`get_thread`, Drive `list_files`/`read_file`, Spotify `now_playing`/`search`) run, Spotify's `play`/`pause` ask. A call that is not read-only is made once through an external operation. Google Drive's picker is the person's own page, `/app-pages/google/drive`, whose actions are `POST /api/app-actions/google/drive/{files,picker,select,forget}`; the Picker itself loads Google's script and needs `GOOGLE_DRIVE_API_KEY` and `GOOGLE_DRIVE_APP_ID`, so it is **not exercised against a real Google** here.

**Skills a connector publishes** (`connector-skills.ts`, the MCP Skills extension `io.modelcontextprotocol/skills`): a server that declares the extension is asked `skills/list` (kept as long as it says, an hour by default), and the prompt lists each skill under its connector, as untrusted as the connector's instructions. `read_skill` and `read_skill_file` take the connector's name besides the skill's: every file is read with `resources/read` and checked against the digest and size in the connector's manifest (a skill the connector changed since the listing is listed again once), a path that leaves the skill is refused, and what is loaded says it was written by the connector and must not widen what the person asked for. `GET /api/mcp/:id/skills` lists them for the connectors screen. v1's `save_to` (copy a file to the person's files) is not carried.

## Watches (B3.13)

`list_connector_events`, `watch_connector_event`, `list_watches`, `stop_watch` (`watch-tools.ts`). A watch is a trigger on a connector's event delivering to the chat that made it, plus a row in `pim_app.watch_subscriptions` (0641): the server is asked `events/subscribe` with the callback `<PIM_PUBLIC_URL>/mcp/events/<owner>/<event_key>`, a fresh Standard Webhooks secret (sealed), and a seven-day grant. Deliveries are verified against the watch's secret (and the subscription id the server named), deduplicated by event id, and fire the triggers on that connector's event with a message starting `[Connector event]` that carries the data, marked as data and not instructions. A verification challenge is answered; a gap or the server ending the subscription is recorded on the watch. The maintenance role subscribes again before a grant runs out (`renewDue`, once a minute); the request is idempotent at the server. Deliveries without Standard Webhooks headers are the older generic connector webhook (HMAC under the connector's own secret). If two watches of one chat share a connector and event name but differ in arguments, an event fires both (v1 fired the one it was bound to).

## Pim as an MCP server (B1.09, B1.31)

`/mcp` is JSON-RPC over HTTP with OAuth 2.1 (`McpOAuth`, `packages/v2-app/src/mcp.ts`): discovery metadata, dynamic client registration of public clients, PKCE (S256), one-hour access tokens and thirty-day rotating refresh tokens as `token_consumers`, a consent page, Settings listing and disconnecting clients, and API tokens accepted as bearers. **Clients re-register after a migration:** v1's registrations, grants and tokens are in `OAUTH_KV` in a library-internal format and are not carried; an MCP client (Claude, ChatGPT) that gets a 401 or `invalid_grant` repeats registration and consent by itself.

Tool by tool against v1 (v1 has one tool, `pim`): the title, the description, the input schema (with its descriptions), the output schema (`{ conversation, reply }`), the annotations, the reply wait and the continue-a-conversation behaviour now match. v2's call waits (45 s) for what the agent sends the person in that turn (its `send_to_user` calls, read from the projection, so it needs the `live` role), and answers that Pim is still working if the turn outlasts it. Differences kept: the title says "Message Pim" and not the majordomo's own name; a process with no transcript source (no Live) answers at once that the message was accepted.

## Environment

| Variable | For |
|---|---|
| `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET` | Gmail's OAuth client (its own Google Cloud project; redirect URI `<PIM_PUBLIC_URL>/mcp/callback/apps`) |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_API_KEY`, `GOOGLE_DRIVE_APP_ID` | Drive's client (a project of its own), and the Picker's key and project number |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Spotify's client (redirect URI as above) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub's MCP server's client, which GitHub does not let Pim register itself (redirect URI `<PIM_PUBLIC_URL>/mcp/callback/apps`) |
| `PIM_CONNECTOR_ALLOW_PRIVATE=1` | connectors at private addresses and `http://` servers (homelab, tests) |
| `PIM_GOOGLE_AUTH_URL`, `PIM_GOOGLE_TOKEN_URL`, `PIM_GOOGLE_REVOKE_URL`, `PIM_GMAIL_API_URL`, `PIM_DRIVE_API_URL`, `PIM_SPOTIFY_AUTH_URL`, `PIM_SPOTIFY_TOKEN_URL`, `PIM_SPOTIFY_API_URL` | the services' addresses, for a proxy or a stand-in; unset, the real ones |

All of them are in `.env`, which every Compose role reads. `PIM_PUBLIC_URL` must be the address the provider and the MCP servers reach. A native connector is offered only once its client is set; a person asking for one that is not gets the names of what the admin must set.

## Migrations

`0640_native_connectors.sql` (`app_ref`, `auth_url`, `error`, `runner_connectors` now returns native connectors and `appRef`) and `0641_watches.sql` (`watch_subscriptions`).

## Trying it without any provider

`scripts/v2-compose/fake-connectors.mjs` stands in for Google, Spotify and an OAuth-protected MCP server (its header lists the `.env` lines and the container to run). `packages/v2-server/test/native-connectors.test.ts` runs the same flows against the real stack in the test suite, and `test/mcp-surface.test.ts` covers Pim's MCP server.

## Not carried

- **Connector skills** (the MCP Skills extension: `skills/list`, `resources/read`, installing a connector's skill) and the cached event catalog: `GET /api/mcp/:id/skills` and `/events` answer empty (B3.05).
- **Real providers:** no real Google, Spotify or GitHub account was used, so Google's consent screen, the Drive Picker and GitHub's OAuth app are untried here.
- **Notion MCP, Linear, Atlassian and the other popular servers** are listed and connect by the same standard flow; none was reached.
- Two native tools' widgets (v1 drew a card for now-playing and search results) are text only.
