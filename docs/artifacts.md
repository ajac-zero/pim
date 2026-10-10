# Artifacts

Artifacts are documents and small interactive pages the agent makes for its owner: a calculator, a chart, a report, trip notes. They stay private to the owner. Self-hosted Pims and hosted Pimlings have them alike. This is milestone M2a. Publishing artifacts, JSX, and artifacts that keep their own state are later milestones.

## What they are

- **Kinds.** `html` is one self-contained document, with its CSS and JavaScript inline. `markdown` is a document.
- **Where they live.** In the owner's Pim Durable Object, in `pim_artifacts` and `pim_artifact_versions` ([`src/artifacts.ts`](../src/artifacts.ts)). Every request for one goes through the owner's gateway and agent, like the rest of the API. Nothing is cached outside the agent, and there is no index across owners.
- **Versions are append-only.** Each change adds a version, and nothing rewrites one, so a version number and its `sha256` always name the same bytes. Restoring an older version adds a new one with the old content (`source: "restore"`, `restoredFrom`).
- **Every write names its base version.** The agent (`base_version`) and the person (`baseVersion`) both say which version they changed. If it's no longer the latest, the write is refused with `409`, so neither overwrites the other unseen.
- **Owner-wide.** An artifact records the chat it was made in, but deleting that chat doesn't delete the artifact.

## The agent's tools

| Tool | What it does |
| --- | --- |
| `artifact_create` | `{ title, kind, content }`: a new artifact at version 1 |
| `artifact_update` | `{ id, base_version, edits \| content, title? }`: a new version. `edits` are find-and-replace pairs, each matching exactly once. The same content again makes no version |
| `artifact_read` | `{ id, version?, offset? }`: the source of the latest or a given version, 60,000 characters at a time |
| `artifact_list` | Every artifact's id, title, kind, latest version and size |

`artifact_create` and `artifact_update` answer with a reference (`{ artifact: { id, title, kind, version, sha256, size } }`), never the content. The web app shows that answer as the artifact. A replayed call (after an eviction) returns the version it made instead of making another. The tools need no approval: they change nothing outside the owner's own Pim.

## The API

Under `/api`, with the owner's passkey session or an API token in the `Authorization` header. A `?token=` in the address is refused with `400` on every artifact path: an address with a token in it can be passed on, logged or kept in history. WebSockets, which can't send the header, still take `?token=`.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/artifacts` | `{ artifacts, bytes }`: each artifact as its latest version, and the bytes all versions take |
| GET | `/artifacts/:id` | The artifact and its `history`, newest first, without content |
| GET | `/artifacts/:id/versions/:v` | One version with its `content`, as JSON |
| GET | `/artifacts/:id/versions/:v/frame` | An HTML version as a page, for the sandboxed frame |
| GET | `/artifacts/:id/versions/:v/download` | The version's exact bytes as an attachment named `.html` or `.md`, served as `text/plain` |
| POST | `/artifacts/:id/restore` | `{ version, baseVersion }`: `201` with the new latest version; `409` if `baseVersion` isn't the latest |
| DELETE | `/artifacts/:id` | Deletes it and every version |

Every artifact response has `Cache-Control: no-store, private`, so every look is a fresh request, checked again: after signing out or losing the passkey a session was made with it gets `401`, while the Pimling is suspended `403`, after the account is deleted `410`, and after the artifact is deleted `404`. When the app finds itself signed out, the sign-in screen takes its place, which unmounts every artifact frame, and it drops what it read of artifacts. That revokes nothing already delivered: a frame still on another screen, a page in the browser's back-forward cache, or a saved download stays as it was.

## How an HTML artifact runs

The artifact runs on the owner's host, so the sandbox is what keeps it apart from the owner's account:

- **Its own response makes it opaque.** The frame and download responses carry `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <owner's origin>`, plus `nosniff`, `no-referrer` and a `Permissions-Policy` that turns off the camera, microphone, location and passkeys. The page gets an opaque origin, even when it's opened directly in a tab. It can't read the owner's cookies or storage, call the API, or reach `/auth`.
- **The frame is sandboxed too.** The app shows it in `<iframe sandbox="allow-scripts">` loaded from that URL, with no `allow-same-origin`, top navigation, popups, forms, modals or downloads. The app never makes artifact HTML into a document itself: a `blob:` URL would run with the app's own origin, and `srcdoc` would too unless sandboxed (a `data:` document gets an opaque origin, but isn't needed either). It never opens one with `window.open`, and downloads come from the server.
- **One message, and only one way.** After the artifact's own markup, the frame page adds a script that reports its height. The app takes messages only from that frame's window (`event.source`, since the origin is always `"null"`). It accepts only `{ type: "pim:artifact-height", height }`, clamps the height, and takes at most 20 messages a second. The app sends the frame nothing. There is no bridge to the owner's data or the agent's tools.
- **Leaving is noticed.** The frame's second `load` is the page navigating itself away. The app then takes the frame down and says so.

**What the sandbox doesn't stop.** An artifact can still send out what it contains, or what someone types into it. It can navigate itself to another site with that data in the address (noticed only afterwards), use WebRTC, or make DNS lookups. Personal data the agent writes into an artifact is therefore as exposed as the artifact. The tools tell the model not to include passwords, codes or personal details unless asked. The app says the same next to every artifact: made by Pim, don't enter passwords or codes. An artifact can also draw something that looks like the app, but only inside its frame, under that caption.

## Markdown

Markdown artifacts are shown in the app itself, with raw HTML dropped. Only inline images (`data:image/png|jpeg|gif|webp`) are shown; any other image is replaced by its alt text, so showing an artifact fetches nothing. Links are kept only for `http(s):`, `mailto:` and `#` addresses, and open with `noopener noreferrer`. Downloads are `text/plain`. Chat messages are rendered as before.

## Limits

Each limit is checked against the stored versions before anything is written. They are set in `PIM_LIMITS`, or per person with the admin API:

| Limit | Meaning | Always at most |
| --- | --- | --- |
| `artifacts` | Artifacts kept | |
| `artifactVersions` | Versions one artifact keeps. At the limit, it takes no new versions: delete it, or make a new one | |
| `artifactBytes` | One version's size, in UTF-8 bytes | 1,000,000 (a SQLite row is at most 2 MB) |
| `artifactStorageBytes` | All versions of all artifacts | 10,000,000 (an export holds them all in memory, and the chats that made them hold their text again) |
| `storageBytes` | The whole Pim: a write is refused if it wouldn't fit | |

The ajac-zero deployment sets 100 artifacts, 50 versions, 500,000 bytes per version and 10,000,000 in all.

## Export and deletion

- **Export** (`/export`, and Pimling's `/account/export`) includes every artifact with every version and its content.
- **Deleting an artifact** removes all its versions, and the chat cards that showed it say it was deleted. The chats keep their own copy: what the agent sent to make or change it is part of the conversation until that chat is deleted. The app says so when you delete one.
- **Deleting a Pimling** erases artifacts with everything else, and the erasure check (`remainingData`) counts `artifacts` and `artifact versions`. A request or a run still under way when the deletion begins writes nothing.
- **Already downloaded files** can't be taken back.

## Acceptance

| Requirement | Checked by |
| --- | --- |
| Created by the model, answered with a reference; read returns the requested source, in parts | `test/artifacts.test.ts`: "are made by the model…" |
| Frame and download headers: `sandbox allow-scripts`, no unsafe sandbox flags, `connect-src 'none'`, `frame-ancestors` the owner's origin, `no-store`, `nosniff`, `no-referrer` | "are shown only in an opaque sandbox…", "download as plain-text attachments…" |
| Downloads are plain-text attachments with names that can't inject headers, sandboxed and `nosniff` | "download as plain-text attachments…" |
| `?token=` refused on artifact paths; WebSockets still take it | "refuse an API token in the address, which WebSockets still use" |
| Stale base version refused, edits match exactly once, unchanged content makes no version | "get new versions only from the latest…" |
| Restore is append-only and needs the latest base | "restore an older version as a new one…" |
| Delete removes every version; export has every version | "are deleted with every version…" |
| Per-version, version-count, artifact-count, total and storage limits, checked before writing | "stay within their limits…" |
| Export near the total cap, and the cap holding with no limits set | "export in full near their total cap…" |
| Another owner's host returns `404` for the artifact; stolen cookies `401`; anonymous `401` | `test/hosted/hosted.test.ts`: "are shown only to their owner…" |
| Fresh requests refused: signed out `401`, passkey removed `401`, suspended `403`, deleted `410` on frame, download and metadata; account export has every version; erased | "stop showing when the browser signs out, its passkey is removed…" |
| A tool call or a restore under way during the erasure leaves nothing | "keeps an artifact the model asks for during the erasure…", "refuses an artifact restore in the agent's handler…" |
| In a real browser: the card and viewer render on desktop and a 390 px phone; the page's own script runs; a hostile artifact can't read cookies or storage, reach the parent, the API or the network, open windows, submit forms or load remote images; leaving is noticed; restore and delete work; Markdown loads nothing remote; signing out unmounts every frame | Browser acceptance against the local preview, recorded in the pull request |
