# Artifacts

Artifacts are documents and small interactive pages the agent makes for its owner: a calculator, a chart, a report, trip notes. They stay private to the owner. This is milestone M2a. Publishing artifacts, JSX, and artifacts that keep their own state are later milestones.

## What they are

- **Kinds.** `html` is one self-contained document, with its CSS and JavaScript inline. `markdown` is a document. `svg` is one `<svg>` element: a drawing, a logo, an illustration. `mermaid` is [Mermaid](https://mermaid.js.org) source for a diagram. `jsx` is one React component (JSX or TSX), for an app or a dashboard: it may import only `react`, `recharts` (charts) and `lucide-react` (icons), and is styled with Tailwind classes. A version keeps its source; it's compiled ([Sucrase](https://github.com/alangpierce/sucrase), in [`src/artifact-jsx.ts`](../src/artifact-jsx.ts)) when it's written, so a compile error or another import goes back to whoever wrote it, and again each time it's shown. Content a kind can't show (an `svg` that isn't an `<svg>` element) is refused before it's kept, with what to fix.
- **Where they live.** In the Durable Object `Pim` holding the owner's space, in `pim_artifacts` and `pim_artifact_versions` ([`src/artifacts.ts`](../src/artifacts.ts)). Every request for one goes through the owner's gateway and agent, like the rest of the API. Nothing is cached outside the agent, and there is no index across owners.
- **Versions are append-only.** Each change adds a version, and nothing rewrites one, so a version number and its `sha256` always name the same bytes. Restoring an older version adds a new one with the old content (`source: "restore"`, `restoredFrom`).
- **Every write names its base version.** The agent (`base_version`) and the person (`baseVersion`) both say which version they changed. If it's no longer the latest, the write is refused with `409`, so neither overwrites the other unseen. A write hashes its content first, then rechecks the latest version and every limit and stores it with nothing awaited in between, so two writes that race can't both pass a check meant for one, and the caps can't be overshot. A refused write changes nothing, not even the title.
- **People edit them too.** On the latest version, the owner can edit the source and save it as a new version (`source: "person"`), checked like the agent's. `artifact_read` tells the agent a version is the person's. They can also ask the agent for a change from the artifact itself: the app sends the request, and what's selected in a Markdown artifact, to the chat that made it (or a new one, if that chat is gone) and opens it.
- **Printing.** The viewer prints a version, or saves it as a PDF through the browser's print dialog: the page prints only a full-height copy of it, in dark ink on white whatever the theme. The copy is the same sandboxed frame (or the same Markdown rendering), so printing runs nothing new.
- **Owner-wide.** An artifact records the chat it was made in, but deleting that chat doesn't delete the artifact.

## The agent's tools

| Tool | What it does |
| --- | --- |
| `artifact_create` | `{ title, kind, content }`: a new artifact at version 1 |
| `artifact_update` | `{ id, base_version, edits \| content, title? }`: a new version. `edits` are find-and-replace pairs, each matching exactly once. The same content again makes no version |
| `artifact_read` | `{ id, version?, offset? }`: the source of the latest or a given version, 60,000 characters at a time |
| `artifact_list` | Every artifact's id, title, kind, latest version and size |

`artifact_create` and `artifact_update` answer with a reference (`{ artifact: { id, title, kind, version, sha256, size } }`), never the content. The web app shows that answer as the artifact. A replayed call (after an eviction) returns the version it made instead of making another. The tools need no approval: they change nothing outside the owner's own space.

## The API

Under `/api`, with the owner's passkey session or an API token in the `Authorization` header. A `?token=` in the address is refused with `400` on every artifact path: an address with a token in it can be passed on, logged or kept in history. WebSockets, which can't send the header, still take `?token=`.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/artifacts` | `{ artifacts, bytes }`: each artifact as its latest version, and the bytes all versions take |
| GET | `/artifacts/:id` | The artifact and its `history`, newest first, without content |
| GET | `/artifacts/:id/versions/:v` | One version with its `content`, as JSON |
| GET | `/artifacts/:id/versions/:v/frame` | An HTML version as a page, for the sandboxed frame |
| GET | `/artifacts/:id/versions/:v/download` | The version's exact bytes as an attachment named `.html` or `.md`, served as `text/plain` |
| POST | `/artifacts/:id/versions` | `{ baseVersion, content, title? }`: the person's edit, as a new version: `201` with `saved`, its number, or `200` with `changed: false` when the content is the latest's; `409` if `baseVersion` isn't the latest; `400` for content its kind can't show |
| POST | `/artifacts/:id/restore` | `{ version, baseVersion }`: `201` with the new latest version; `409` if `baseVersion` isn't the latest |
| DELETE | `/artifacts/:id` | Deletes it and every version |
| PUT | `/artifacts/:id/circles` | `{ circles }`: the ids of the circles to share it with (see [Sharing](#sharing)); `[]` stops sharing it |
| GET | `/shared-artifacts` | `{ artifacts }`: what others share with you, each as its latest version with its owner's username as `host` |
| GET | `/shared-artifacts/:host/:id`, `…/versions/:v`, `…/versions/:v/frame` | One of them, its content, and its page, from its owner's Pim; `404` once they stop sharing it or it isn't the latest version |
| POST | `/shared-artifacts/:host/:id/versions/:v/bridge`, `…/grants` | Its bridge calls and permissions, as for your own |

Every artifact response has `Cache-Control: no-store, private`, so every look is a fresh request, checked again: after signing out or losing the passkey a session was made with it gets `401`, while the account is suspended `403`, after the account is deleted `410`, and after the artifact is deleted `404`. When the app finds itself signed out, the sign-in screen takes its place, which unmounts every artifact frame, and it drops what it read of artifacts. That revokes nothing already delivered: a frame still on another screen, a page in the browser's back-forward cache, or a saved download stays as it was.

## How an HTML artifact runs

The artifact is served from the Pim's own origin, which everyone on it shares, so the sandbox is what keeps it apart from the owner's account and everyone else's:

- **Its own response makes it opaque.** The frame and download responses carry `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <the Pim's origin>`, plus `nosniff`, `no-referrer` and a `Permissions-Policy` that turns off the camera, microphone, location and passkeys. The page gets an opaque origin, even when it's opened directly in a tab. It can't read the owner's cookies or storage, call the API, or reach `/auth`.
- **The frame is sandboxed too.** The app shows it in `<iframe sandbox="allow-scripts">` loaded from that URL, with no `allow-same-origin`, top navigation, popups, forms, modals or downloads. The app never makes artifact HTML into a document itself: a `blob:` URL would run with the app's own origin, and `srcdoc` would too unless sandboxed (a `data:` document gets an opaque origin, but isn't needed either). It never opens one with `window.open`, and downloads come from the server.
- **Two messages, through the app.** After the artifact's own markup, the frame page adds a script that reports its height; before it (after the doctype), the bridge (below). The app takes messages only from that frame's window (`event.source`, since the origin is always `"null"`). It accepts `{ type: "pim:artifact-height", height }`, clamps the height, and takes at most 20 a second; and `{ type: "pim:call", id, op, args }`, at most 20 a second, which it relays to Pim and answers with `{ type: "pim:reply", id, value | error }`, only while the page that asked is still the one shown. The frame never gets a token or the API: every call is the app's request, made as this artifact's version.
- **Leaving is noticed.** The frame's second `load` is the page navigating itself away. The app then takes the frame down and says so.

- **SVG, diagrams and JSX run in the same frame.** An SVG version is shown in a page that fits it to the frame, under the same headers. A Mermaid version is put in the page as text, escaped, and drawn there by Mermaid with its `strict` security level. A JSX version is compiled to one inline script, escaped so nothing in it can close the element, which mounts the component on Pim's React runtime with only the modules it imports, and Tailwind's browser build. Diagram and JSX pages, and only they, may also load Pim's own scripts from `/artifact-runtime/` (`script-src 'unsafe-inline' <the Pim's origin>/artifact-runtime/`): static files the web app's build makes (`web/scripts/build-artifact-runtimes.mjs`), the same for everyone, which load nothing else. The page still has an opaque origin, so it requests them without cookies.

**What the sandbox doesn't stop.** An artifact can still send out what it contains, or what someone types into it. It can navigate itself to another site with that data in the address (noticed only afterwards), use WebRTC, or make DNS lookups. Personal data the agent writes into an artifact is therefore as exposed as the artifact. The tools tell the model not to include passwords, codes or personal details unless asked. The app says the same next to every artifact: made by Pim, don't enter passwords or codes. An artifact can also draw something that looks like the app, but only inside its frame, under that caption.

## The bridge

Every framed artifact can use `window.pim`, whose calls return promises:

| Call | What it does | Permission |
| --- | --- | --- |
| `pim.storage.get(key)`, `.set(key, text)`, `.delete(key)`, `.list(prefix?)` | Text the artifact keeps under keys (1 to 200 characters), across visits and versions, until it's deleted | None: it's the artifact's own, and nothing else can read it |
| `pim.shared.get(key)`, `.set(key, text)`, `.delete(key)`, `.list(prefix?)` | The same, kept once for everyone the artifact is shared with, its owner included, in the owner's Pim: a tally, a sign-up sheet, a shared list. Separate from `pim.storage`, which stays each person's own | None, as for `pim.storage` |
| `pim.ask(prompt)` | An answer from the utility model (`ARTIFACT_ASK` in [`src/utility.ts`](../src/utility.ts)), which has no tools and sees only the prompt (at most 20,000 characters). It counts toward the daily model limits | The person's, for this version |
| `pim.tools.call(name, input)` | Runs an app tool, by its tool name, and answers with its result as text | The person's, for this version and this tool; only tools the owner lets run without asking (`on`). A tool that asks first can't be allowed or called: nothing in an artifact could show the person what it's about to do |

The app relays a call to `POST /api/artifacts/:id/versions/:v/bridge` as `{ op, args }`. Pim answers `{ value }`, or `{ needs: { capability, label } }` when the person hasn't allowed it. The app then asks them, over the frame: "“Water tracker” wants to ask Pim's model…", or "…wants to use Calendar: find_events for you". A yes is kept (`POST …/grants { capability }`, in `pim_artifact_grants`) for that version's `sha256`, so a new version, which is new code, asks again. A no is remembered by the frame until it's shown again, and the call fails with "The person didn't allow it."

What an artifact gets back, it could send elsewhere, like anything else it shows (see above), and the prompts say so. What it keeps is in `pim_artifact_data` (with `pim.shared` data apart, by its `scope`), at most 1,000,000 bytes per artifact and 10,000,000 for all of them, within the Pim's storage quota; it's in the export, deleted with the artifact, and counted by the erasure check.

## Sharing

An artifact can be shared with your circles (see [Sharing](../README.md#sharing)): Share on its page lists them. The people in those circles find it in Artifacts under Shared with you, as its latest version, which they can use and print but not change, see older versions of, or download. Stop sharing it, delete it, delete the circle, or take someone out of the circle, and their next look is refused.

- **It runs in their Pim.** Their app asks their own Pim, which asks yours (`guestArtifact`) and checks nothing itself: your Pim checks, at every request, that they're in a circle it's shared with and that the version is the latest. The page is framed and sandboxed as your own are.
- **What it keeps for them is theirs.** `pim.storage` keeps their data in their own Pim, apart from yours and everyone else's. `pim.ask` uses their model and counts toward their limits, and `pim.tools.call` their apps' tools, under their permissions. Nothing of yours is reached but the artifact and its `pim.shared` data.
- **What it keeps for everyone is yours.** `pim.shared` writes go to your Pim (`guestArtifactShared`), within the artifact's limits. Anyone it's shared with can change or delete that data, so an artifact should keep there only what they may all see.

## Markdown

Markdown artifacts are shown in the app itself, through an allowlist of Pim's own (`UNTRUSTED_SCHEMA` in [`markdown.tsx`](../web/src/components/chat/markdown.tsx)), not Streamdown's defaults:

- **No raw HTML is parsed.** Streamdown's raw-HTML plugin isn't run, so raw HTML in an artifact shows as plain text, never as elements.
- **Only text elements survive:** formatting, headings, lists and task lists, tables, code, and links. There are no `picture`, `source`, media, frames, forms, `style` attributes or event handlers.
- **No image is shown, inline or not.** The schema keeps only an image's alt text, shown as "[Image blocked: alt text]", and the app's image component never renders a `src`. Showing a Markdown artifact requests nothing.
- **Links** keep only `http(s):`, `mailto:` and `#` addresses, and open with `noopener noreferrer`. Any other link, including `javascript:`, `data:`, relative and protocol-relative ones, shows as its text only. Streamdown's link hardening runs as well, after the schema.

Downloads are `text/plain`. Chat messages are rendered as before. A render test ([`markdown.test.tsx`](../web/src/components/chat/markdown.test.tsx)) pins this with a hostile corpus: `picture`/`source` and `img` with `src` and `srcset`, `video` with `poster`, `audio`, `iframe`, `object`, `embed`, `link`, `style` elements and inline `style` with `url()`, event handlers, `form` with `input type=image` and `formaction`, and `javascript:`, `data:`, relative and protocol-relative links and images. It checks that no element or attribute that could load, run, submit or send anything survives, that the only links are the allowed ones, and that raw HTML and images show only as text. It fails if the raw-HTML plugin comes back, if Streamdown's default schema replaces Pim's, or if the link filter is removed.

## Limits

Each limit is checked against the stored versions before anything is written. They are set for every member with the `PIM_LIMIT_*` variables, or per person with the admin API:

| Limit | Meaning | Always at most |
| --- | --- | --- |
| `artifacts` | Artifacts kept | |
| `artifactVersions` | Versions one artifact keeps. At the limit, it takes no new versions: delete it, or make a new one | |
| `artifactBytes` | One version's size, in UTF-8 bytes | 1,000,000 (a SQLite row is at most 2 MB) |
| `artifactStorageBytes` | All versions of all artifacts | 10,000,000 (an export holds them all in memory, and the chats that made them hold their text again) |
| `storageBytes` | The whole space: a write is refused if it wouldn't fit | |

## Export and deletion

- **Export** (`/export`, and `/account/export`) includes every artifact with every version and its content, what each keeps (its own and shared data), the circles it's shared with, and what artifacts others share with you keep for you.
- **Deleting an artifact** removes all its versions, and the chat cards that showed it say it was deleted. The chats keep their own copy: what the agent sent to make or change it is part of the conversation until that chat is deleted. The app says so when you delete one.
- **Deleting an account** erases artifacts with everything else, and the erasure check (`remainingData`) counts `artifacts` and `artifact versions`. A request or a run still under way when the deletion begins writes nothing.
- **Already downloaded files** can't be taken back.

## Acceptance

| Requirement | Checked by |
| --- | --- |
| Created by the model, answered with a reference; read returns the requested source, in parts | `test/artifacts.test.ts`: "are made by the model…" |
| Frame and download headers: `sandbox allow-scripts`, no unsafe sandbox flags, `connect-src 'none'`, `frame-ancestors` the Pim's origin, `no-store`, `nosniff`, `no-referrer` | "are shown only in an opaque sandbox…", "download as plain-text attachments…" |
| SVG and Mermaid: the same sandbox; only diagrams may load Pim's runtime; diagram source is escaped text; content a kind can't show is refused | "draw SVG and Mermaid in the same sandbox…" |
| JSX: kept as source and compiled for the frame; the page loads React, Tailwind and only the modules it imports; its strings can't close a script; compile errors, other imports and a missing default export are refused | "run JSX compiled…" |
| Downloads are plain-text attachments with names that can't inject headers, sandboxed and `nosniff` | "download as plain-text attachments…" |
| `?token=` refused on artifact paths; WebSockets still take it | "refuse an API token in the address, which WebSockets still use" |
| Stale base version refused, edits match exactly once, unchanged content makes no version | "get new versions only from the latest…" |
| Restore is append-only and needs the latest base | "restore an older version as a new one…" |
| The person's edits are versions from the latest base, refused when stale or unshowable, and read by the model as theirs | "take the person's edits as new versions…" |
| Delete removes every version; export has every version | "are deleted with every version…" |
| Per-version, version-count, artifact-count, total and storage limits, checked before writing | "stay within their limits…" |
| A refused write (`413` too big, `429` too many versions or too much in all, `409` stale base, for an edit or a restore) leaves the title, time, latest version, history and content as they were | "change nothing on a refused write…" |
| Racing writes: an edit and a restore on the same base give one version and a `409`; two creates that don't both fit give one and a `429`, under a limit and under the hard cap | "take one of two writes racing on the same version…", "export in full near their total cap…" |
| The bridge is the page's first script; storage is the artifact's own, within its limits, kept across versions, exported and deleted with it; the model and app tools need the person's yes for each version; tools that ask first can't be allowed or called | "keep their own data through the bridge…", `test/mcp.test.ts`: "lets an artifact call a tool…" |
| Markdown: the hostile corpus above leaves no loading, running or submitting element or attribute; only `http(s)`, `mailto` and `#` links; raw HTML and images only as text; task lists, tables and code still render | `web/src/components/chat/markdown.test.tsx` |
| Export near the total cap, and the cap holding with no limits set | "export in full near their total cap…" |
| Shared with circles: their people see only the latest version, from their own space, with their own storage apart and shared data in the owner's space; stopping sharing, an older version, or someone outside the circles gets `404` | `test/people.test.ts`: "are shown to the people of the circles they're shared with…" |
| Another person's space returns `404` for the artifact; anonymous `401` | `test/people.test.ts`: "are shown only to their owner" |
| Fresh requests refused: signed out `401`, passkey removed `401`, suspended `403`, deleted `410` on frame, download and metadata; account export has every version; erased | "stop showing when the browser signs out, its passkey is removed…" |
| A tool call or a restore under way during the erasure leaves nothing | "keeps an artifact the model asks for during the erasure…", "refuses an artifact restore in the agent's handler…" |
| In a real browser: the card and viewer render on desktop and a 390 px phone; the page's own script runs; a hostile artifact can't read cookies or storage, reach the parent or the API, fetch or load remote resources, open windows or submit forms (it can still navigate itself away, which the app notices); leaving is noticed; restore and delete work; Markdown loads nothing remote; signing out unmounts every frame | Browser acceptance against the local preview, recorded in the pull request |
