# Artifacts

Artifacts are documents, small interactive pages, React apps, drawings and diagrams the agent makes for its owner: a calculator, a chart, a report, trip notes. They are private to the owner until the owner [shares](#sharing) one with their circles or [publishes](#publishing) it, and can keep data and use the owner's model and tools through [the bridge](#the-bridge).

## What they are

- **Kinds.** `html` is a page, `index.html`, with its CSS and JavaScript inline or in files of its own. `markdown` is a document. `svg` is one `<svg>` element: a drawing, a logo, an illustration. `mermaid` is [Mermaid](https://mermaid.js.org) source for a diagram. `jsx` is a React app (JSX or TSX), `App.jsx`, for an app or a dashboard: it may import `react`, `recharts` (charts), `lucide-react` (icons) and its own files, and is styled with Tailwind classes. A version keeps its source; it's compiled ([Sucrase](https://github.com/alangpierce/sucrase), in [`src/artifact-jsx.ts`](../src/artifact-jsx.ts)) when it's written, so a compile error or another import goes back to whoever wrote it, and again each time it's shown. Content a kind can't show (an `svg` that isn't an `<svg>` element) is refused before it's kept, with what to fix.
- **Files.** HTML and JSX artifacts can have up to 100 files besides their main one, by relative path (`app.js`, `components/Chart.tsx`, `data.json`, `images/logo.png`): text the agent writes, or copies of the person's own files (an image, a dataset). The other kinds are their main file alone. See [Several files](#several-files).
- **Where they live.** The owner's space Durable Object keeps them and their versions, and R2 the files' bytes (see [Storage](#storage)). Every request for one goes through the owner's gateway and agent, like the rest of the API. Nothing is cached outside the agent, and there is no index across owners.
- **Versions are append-only.** Each change adds a version, and nothing rewrites one, so a version number and its `sha256` always name the same bytes. Restoring an older version adds a new one with the old content (`source: "restore"`, `restoredFrom`).
- **Every write names its base version.** The agent (`base_version`) and the person (`baseVersion`) both say which version they changed. If it's no longer the latest, the write is refused with `409`, so neither overwrites the other unseen. A write hashes its content first, then rechecks the latest version and every limit and stores it with nothing awaited in between, so two writes that race can't both pass a check meant for one, and the caps can't be overshot. A refused write changes nothing, not even the title.
- **Beside the chat.** In the chat, each version the agent makes is a block naming the artifact and version. Opening it shows that version in a canvas beside the chat (over it on phones), with its history, its source, the person's edits, sharing, and download, print and delete in a menu; the chat stays usable next to it. A version the agent makes while the person watches opens there by itself, and the canvas's address (`/chat/<id>?artifact=<id>&v=<n>`) can be linked. An agent's message can link an artifact as `/artifacts/<id>` (or an `artifact://<id>` it made up); the link opens the artifact in the canvas beside the chat the message is in. From the Artifacts list, an artifact always opens on a page of its own (`/artifacts/<id>`), without loading its chat.
- **People edit them too.** On the latest version, the owner can edit the source and save it as a new version (`source: "person"`), checked like the agent's. `artifact_read` tells the agent a version is the person's. Beside the chat, they ask the agent for a change in the chat. On an artifact's own page, Chat in the top toolbar opens the new-chat screen with `/artifacts/<id>` prefilled at the start of the message, shown in the input as a removable chip with the artifact's icon and title. They add their request and send it when ready; opening the screen sends nothing and doesn't reuse the artifact's original chat. The message still sends the artifact's reference, not just its title.
- **Printing.** The viewer prints a version, or saves it as a PDF through the browser's print dialog: the page prints only a full-height copy of it, in dark ink on white whatever the theme. The copy is the same sandboxed frame (or the same Markdown rendering), so printing runs nothing new.
- **Owner-wide.** An artifact records the chat it was made in, but deleting that chat doesn't delete the artifact.

## The agent's tools

| Tool | What it does |
| --- | --- |
| `artifact_create` | `{ title, kind, content, files? }`: a new artifact at version 1. `content` is its main file; `files` its others, each `{ path, content }` or `{ path, from_file }` (a path in the person's files to copy) |
| `artifact_update` | `{ id, base_version, path?, edits \| content, files?, delete_files?, title? }`: a new version. `edits` (find-and-replace pairs, each matching exactly once) or `content` change one file, the main one unless `path` names another; `files` adds or replaces whole files; `delete_files` removes them. Files it doesn't mention stay. The same files again make no version |
| `artifact_read` | `{ id, version?, path?, offset? }`: one file of the latest or a given version, the main one unless `path` names another, 60,000 characters at a time, with the list of its files |
| `artifact_show` | `{ id, version? }`: shows the latest or a given version in the chat, as the block that opens it, changing nothing. For one made in another chat, such as on a task for another agent |
| `artifact_list` | `{ query? }`: every artifact's id, title, kind, latest version, size and files, from every chat; with `query`, those whose title has all its words |

`artifact_create`, `artifact_update` and `artifact_show` answer with a reference (`{ artifact: { id, title, kind, version, sha256, size } }`), never the content. The web app shows that answer as the artifact. A replayed call (after an eviction) returns the version it made instead of making another. The tools need no approval: they change nothing outside the owner's own space.

## The API

Under `/api`, with the owner's passkey session or an API token in the `Authorization` header. A `?token=` in the address is refused with `400` on every artifact path: an address with a token in it can be passed on, logged or kept in history. WebSockets, which can't send the header, still take `?token=`.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/artifacts` | `{ artifacts, bytes }`: each artifact as its latest version, and the bytes all versions take |
| GET | `/artifacts/:id` | The artifact and its `history`, newest first, without content |
| GET | `/artifacts/:id/versions/:v` | One version with its `files` and the `content` of its main file, or of the file at `?path=`, as JSON; `content` is null for a file that isn't text |
| GET | `/artifacts/:id/versions/:v/frame` | An HTML version as a page, for the sandboxed frame |
| GET | `/artifacts/:id/versions/:v/download` | Its main file's exact bytes, or the file at `?path=`, as an attachment named after the title and version, served as `text/plain` (or `application/octet-stream` for a file that isn't text) |
| POST | `/artifacts/:id/versions` | `{ baseVersion, content, path?, title? }`: the person's edit of one file (the main one unless `path` names another), as a new version: `201` with `saved`, its number, or `200` with `changed: false` when the content is the latest's; `409` if `baseVersion` isn't the latest; `400` for content its kind can't show |
| POST | `/artifacts/:id/restore` | `{ version, baseVersion }`: `201` with the new latest version; `409` if `baseVersion` isn't the latest |
| DELETE | `/artifacts/:id` | Deletes it and every version |
| PUT | `/artifacts/:id/circles` | `{ circles }`: the ids of the circles to share it with (see [Sharing](#sharing)); `[]` stops sharing it |
| GET | `/shared-artifacts` | `{ artifacts }`: what others share with you, each as its latest version with its owner's username as `host` |
| GET | `/shared-artifacts/:host/:id`, `…/versions/:v`, `…/versions/:v/frame` | One of them, its content, and its page, from its owner's space; `404` once they stop sharing it or it isn't the latest version |
| POST | `/shared-artifacts/:host/:id/versions/:v/bridge`, `…/grants` | Its bridge calls and permissions, as for your own |
| GET, POST, DELETE | `/artifacts/:id/publish` | What you published of it, with `linkable` and its public `link` (`404` if nothing); `{ public? }`: publishes its latest version, replacing what was published, and with `public`, lets anyone with the link see it or stops them; or takes it down (see [Publishing](#publishing)) |
| GET | `/published-artifacts` | `{ artifacts }`: published artifacts (`?q=` searches titles and authors), without content |
| GET | `/published-artifacts/:id`, `…/versions/:v`, `…/versions/:v/frame` | One of them, its content, and its page; `404` for any version but the published one |
| POST | `/published-artifacts/:id/versions/:v/bridge`, `…/grants` | Its bridge calls and permissions, as for your own |
| POST | `/published-artifacts/:id/use` | `201` with a new artifact of yours, a copy of the published version |

Every artifact response has `Cache-Control: no-store, private`, so every look is a fresh request, checked again: after signing out or losing the passkey a session was made with it gets `401`, while the account is suspended `403`, after the account is deleted `410`, and after the artifact is deleted `404`. When the app finds itself signed out, the sign-in screen takes its place, which unmounts every artifact frame, and it drops what it read of artifacts. That revokes nothing already delivered: a frame still on another screen, a page in the browser's back-forward cache, or a saved download stays as it was.

## Several files

A sandboxed page can load nothing, its own files included, so the frame page carries them inline. Nothing about the sandbox changes, and the files need no address of their own:

- **A page** (`html`): when it's served, an `HTMLRewriter` puts inline what it names of its own files by relative path: `<script src>` becomes an inline script, with the same escaping as a JSX app's; `<link rel="stylesheet">` becomes `<style>`, its `url()`s of its own files `data:` URLs; `<img>`, `<source>`, `<audio>` and `<video>` sources, video posters and icons become `data:` URLs. A `<script type="application/json" src="data.json">` keeps its type, so a page reads data from it. What names no file of its own is left alone, and blocked. `fetch` stays blocked, so a page can't read its files any other way.
- **An app** (`jsx`) imports its files by relative path (`./components/Chart`, which may leave out `.jsx`, `.tsx`, `.js` or `.ts`, or name a folder's `index`). They're compiled with the main file into one script of modules, each run once, when first imported. A JSON file is its value, a CSS file adds a style to the page, and anything else (an image, a font) is its `data:` URL. An import of a file it doesn't have is refused when it's written.
- The person's edits and the agent's change one file at a time; the viewer's Source view picks the file, and Download saves the one it shows.

## How an HTML artifact runs

The artifact is served from the Pim's own origin, which everyone on it shares, so the sandbox is what keeps it apart from the owner's account and everyone else's:

- **Its own response makes it opaque.** The frame and download responses carry `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <the Pim's origin>`, plus `nosniff`, `no-referrer` and a `Permissions-Policy` that turns off the camera, microphone, location and passkeys. The page gets an opaque origin, even when it's opened directly in a tab. It can't read the owner's cookies or storage, call the API, or reach `/auth`.
- **The frame is sandboxed too.** The app shows it in `<iframe sandbox="allow-scripts">` loaded from that URL, with no `allow-same-origin`, top navigation, popups, forms, modals or downloads. The app never makes artifact HTML into a document itself: a `blob:` URL would run with the app's own origin, and `srcdoc` would too unless sandboxed (a `data:` document gets an opaque origin, but isn't needed either). It never opens one with `window.open`, and downloads come from the server.
- **Two messages, through the app.** After the artifact's own markup, the frame page adds a script that reports its height; before it (after the doctype), the bridge (below). The app takes messages only from that frame's window (`event.source`, since the origin is always `"null"`). It accepts `{ type: "pim:artifact-height", height }`, clamps the height, and takes at most 20 a second; and `{ type: "pim:call", id, op, args }`, at most 20 a second, which it relays to Pim and answers with `{ type: "pim:reply", id, value | error }`, only while the page that asked is still the one shown. The frame never gets a token or the API: every call is the app's request, made as this artifact's version.
- **Leaving is noticed.** The frame's second `load` is the page navigating itself away. The app then takes the frame down and says so.
- **Back leaves the artifact.** A frame shares the browser's history with the app, so a page's moves within itself would each take a press of Back. In a frame, the bridge script makes `history.pushState` replace the current entry, and follows a click on a link to a place in the same page (`#section`) with `location.replace`, unless the page handled the click itself.

- **SVG, diagrams and JSX run in the same frame.** An SVG version is shown in a page that fits it to the frame, under the same headers. A Mermaid version is put in the page as text, escaped, and drawn there by Mermaid with its `strict` security level. A JSX version is compiled to one inline script, escaped so nothing in it can close the element, which mounts the component on Pim's React runtime with only the modules it imports, and Tailwind's browser build. Diagram and JSX pages, and only they, may also load Pim's own scripts from `/artifact-runtime/` (`script-src 'unsafe-inline' <the Pim's origin>/artifact-runtime/`): static files the web app's build makes (`web/scripts/build-artifact-runtimes.mjs`), the same for everyone, which load nothing else. The page still has an opaque origin, so it requests them without cookies.

**What the sandbox doesn't stop.** An artifact can still send out what it contains, or what someone types into it. It can navigate itself to another site with that data in the address (noticed only afterwards), use WebRTC, or make DNS lookups. Personal data the agent writes into an artifact is therefore as exposed as the artifact. The tools tell the model not to include passwords, codes or personal details unless asked. The app shows no warning beside artifacts. An artifact can also draw something that looks like the app, but only inside its frame.

## The bridge

Every framed artifact can use `window.pim`, whose calls return promises:

| Call | What it does | Permission |
| --- | --- | --- |
| `pim.storage.get(key)`, `.set(key, text)`, `.delete(key)`, `.list(prefix?)` | Text the artifact keeps under keys (1 to 200 characters), across visits and versions, until it's deleted | None: it's the artifact's own, and nothing else can read it |
| `pim.shared.get(key)`, `.set(key, text)`, `.delete(key)`, `.list(prefix?)` | The same, kept once for everyone the artifact is shared with, its owner included, in the owner's space: a tally, a sign-up sheet, a shared list. Separate from `pim.storage`, which stays each person's own. A published artifact opened from Discover keeps nothing for everyone, and these calls fail there | None, as for `pim.storage` |
| `pim.ask(prompt)` | An answer from the utility model (`ARTIFACT_ASK` in [`src/utility.ts`](../src/utility.ts)), which has no tools and sees only the prompt (at most 20,000 characters). It counts toward the daily model limits | The person's, for this version |
| `pim.chat(text)` | On a dashboard (see the README's [Your agents](../README.md#your-agents)), puts a message about the artifact in the box below it, with the artifact attached, for the person to send or change: a headline clicked becomes "Tell me more about…". It sends nothing, and the app answers it without asking Pim. Anywhere else, it fails | None: the person sends the message, or doesn't |
| `pim.tools.call(name, input)` | Runs an app tool, by its tool name, and answers with its result as text | The person's, for this version and this tool; only tools the owner lets run without asking (`on`). A tool that asks first can't be allowed or called: nothing in an artifact could show the person what it's about to do |

The app relays a call to `POST /api/artifacts/:id/versions/:v/bridge` as `{ op, args }`. Pim answers `{ value }`, or `{ needs: { capability, label } }` when the person hasn't allowed it. The app then asks them, over the frame: "“Water tracker” wants to ask Pim's model…", or "…wants to use Calendar: find_events for you". A yes is kept (`POST …/grants { capability }`, in `pim_artifact_grants`) for that version's `sha256`, so a new version, which is new code, asks again. A no is remembered by the frame until it's shown again, and the call fails with "The person didn't allow it."

What an artifact gets back, it could send elsewhere, like anything else it shows (see above), and the prompts say so. What it keeps is in `pim_artifact_data` (with `pim.shared` data apart, by its `scope`), at most 1,000,000 bytes per artifact and 10,000,000 for all of them, within the space's storage quota; it's in the export, deleted with the artifact, and counted by the erasure check.

## Sharing

An artifact can be shared with your circles (see [Sharing](../README.md#sharing)): Share on its page lists them. The people in those circles find it in Artifacts under Shared with you, as its latest version, which they can use and print but not change, see older versions of, or download. Stop sharing it, delete it, delete the circle, or take someone out of the circle, and their next look is refused.

- **It runs in their space.** Their app asks their own space, which asks yours (`guestArtifact`) and checks nothing itself: your space checks, at every request, that they're in a circle it's shared with and that the version is the latest. The page is framed and sandboxed as your own are.
- **What it keeps for them is theirs.** `pim.storage` keeps their data in their own space, apart from yours and everyone else's. `pim.ask` uses their model and counts toward their limits, and `pim.tools.call` their apps' tools, under their permissions. Nothing of yours is reached but the artifact and its `pim.shared` data.
- **What it keeps for everyone is yours.** `pim.shared` writes go to your space (`guestArtifactShared`), within the artifact's limits. Anyone it's shared with can change or delete that data, so an artifact should keep there only what they may all see.

## Publishing

An artifact can also be published for everyone on the Pim, from Share on its page, as agents are published (see the README). The Gallery keeps a copy of its latest version, which Discover lists. Publishing again replaces the copy with the latest version; until then, a new version stays the author's own.

- **Anyone signed in can open it.** It runs framed and sandboxed, as their own artifacts do. Like an artifact shared with them, what it keeps for them is in their own space (under `gallery/<id>`), and its model and tool calls are theirs, once they allow the published version. It keeps nothing for everyone: `pim.shared` fails.
- **Make it your own** copies the published version into their artifacts, as a new artifact of theirs to change, and counts the use.
- **Taking it down.** Unpublishing, deleting the artifact, deleting the account, or the admin's takedown removes it from Discover, and the next request for it is refused. Copies people made, and what it kept for them, stay theirs.
- Each person can publish up to 20 artifacts.

### Public links

A published page, React app, drawing or diagram can also be seen by anyone with its link, without an account, once its author turns on "Anyone with the link" under Share. Links are off until the deployment sets `PIM_CONTENT_ORIGIN` to an origin of its own, such as `https://pim-content.example.com`, apart from the app's: a link is `<that origin>/p/<id>`.

- **The content origin serves only published pages.** A request to it gets `/p/<id>` for a published artifact whose link is on, `/artifact-runtime/*`, and `404` for everything else, including the API and `/auth`: nobody signs in there, and the app's cookies, which belong to its own host, aren't sent. Route only `<content host>/p/*` and `<content host>/artifact-runtime/*` to the Worker: the app's static files would answer other paths there.
- **The page is the one Pim frames**, under the same sandbox and headers, plus `x-robots-tag: noindex`, and with the content origin's runtime. At the top of a tab, the bridge has no space to answer it: every `window.pim` call fails ("Pim isn't here"), so it keeps nothing and asks for nothing.
- **Anyone who has the link can pass it on.** Its id is random (64 bits), but it isn't a secret once shared. Turning the link off, unpublishing, deleting the artifact or the account, or the admin's takedown makes the next request `404`; pages already open stay as they are. Requests are rate-limited per address.
- Markdown artifacts don't get links: they're shown in the app, not as pages.

## Markdown

Markdown artifacts are shown in the app itself, through an allowlist of Pim's own (`UNTRUSTED_SCHEMA` in [`markdown.tsx`](../web/src/components/chat/markdown.tsx)), not Streamdown's defaults:

- **No raw HTML is parsed.** Streamdown's raw-HTML plugin isn't run, so raw HTML in an artifact shows as plain text, never as elements.
- **Only text elements survive:** formatting, headings, lists and task lists, tables, code, and links. There are no `picture`, `source`, media, frames, forms, `style` attributes or event handlers.
- **No image is shown, inline or not.** The schema keeps only an image's alt text, shown as "[Image blocked: alt text]", and the app's image component never renders a `src`. Showing a Markdown artifact requests nothing.
- **Links** keep only `http(s):`, `mailto:` and `#` addresses, and open with `noopener noreferrer`. Any other link, including `javascript:`, `data:`, relative and protocol-relative ones, shows as its text only. Streamdown's link hardening runs as well, after the schema.

Downloads are `text/plain`. Chat messages are rendered as before. A render test ([`markdown.test.tsx`](../web/src/components/chat/markdown.test.tsx)) pins this with a hostile corpus: `picture`/`source` and `img` with `src` and `srcset`, `video` with `poster`, `audio`, `iframe`, `object`, `embed`, `link`, `style` elements and inline `style` with `url()`, event handlers, `form` with `input type=image` and `formaction`, and `javascript:`, `data:`, relative and protocol-relative links and images. It checks that no element or attribute that could load, run, submit or send anything survives, that the only links are the allowed ones, and that raw HTML and images show only as text. It fails if the raw-HTML plugin comes back, if Streamdown's default schema replaces Pim's, or if the link filter is removed.

## Storage

A version is a set of files: an HTML page's `index.html`, a JSX app's `App.jsx`, and so on (`ENTRY_FILES` in [`src/artifacts.ts`](../src/artifacts.ts)). The owner's Durable Object keeps the artifacts, their versions and the files each version lists (`pim_artifact_files`: path, SHA-256, size, media type). The files' bytes are in R2, in the artifacts' own bucket (`ARTIFACTS`), at `<owner>/<sha256>`:

- **Each file is stored once.** A new version stores only files that changed; the same file in two versions, or two artifacts, is one object, counted once against the limits. A restore lists the older version's files again and stores nothing.
- **Writing stores first, then lists.** A write stores its new files, then, with nothing awaited between its checks and its writes, adds the version, or is refused (`409`, `413`, `429`). The checks run before storing too, so a write that's sure to be refused stores nothing.
- **Deleting frees what nothing else lists.** Deleting an artifact deletes from R2 each of its files that no other version has. A write storing the same file at that moment has claimed it (`pim_artifact_pending`), and work on one file waits for the work on it before, so a deletion can't take a file from under a write. A file a refused write stored is freed the same way.
- **Versions from before files** keep their one file in the version row, where the owner's space reads it. When someone else's space needs it (sharing, publishing, a restore), it moves to R2, keeping its hash, so permissions given to that version still hold.
- Others' spaces read files from R2 themselves, under the owner's prefix, after the owner's space (or the Gallery, for a published one) has said which: an artifact shared with a circle, or published, is never copied to them, except by making it their own.

## Limits

Each limit is checked against the stored versions before anything is written. They are set in `PIM_LIMITS`, or per person with the admin API. A version also has at most 100 files. What the agent writes in one tool call is bounded by its chat's transcript, which keeps the call, far below these:

| Limit | Meaning | Always at most |
| --- | --- | --- |
| `artifacts` | Artifacts kept | |
| `artifactVersions` | Versions one artifact keeps. At the limit, it takes no new versions: delete it, or make a new one | |
| `artifactBytes` | One version's size: all its files, in bytes | 10,000,000 (a framed version is served as one page) |
| `artifactStorageBytes` | All artifacts' files, each distinct file once | 100,000,000 |
| `storageBytes` | The whole space: a write is refused if it wouldn't fit | |

## Export and deletion

- **Export** (`/export`, and `/account/export`) includes every artifact with every version and the files it lists, what each keeps (its own and shared data), the circles it's shared with, and what artifacts others share or publish keep for you. The files' contents are in `artifactFiles`, by SHA-256, once each: text as text, anything else as base64. Past 32,000,000 bytes, files are listed there without their contents, which the app still downloads.
- **Deleting an artifact** removes all its versions, and the blocks in chats that named it say it was deleted. The chats keep their own copy: what the agent sent to make or change it is part of the conversation until that chat is deleted. The app says so when you delete one.
- **Deleting an account** erases artifacts with everything else: their files in R2 first, by the owner's prefix, including any a lost write left unlisted. The erasure check (`remainingData`) counts `artifacts`, `artifact versions` and `artifact files` (anything left in R2 under the prefix). A request or a run still under way when the deletion begins writes nothing.
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
| Files are stored once, freed when no version lists them, and read from versions from before files, which move to R2 keeping their hash | "keep each file once in R2…" |
| Several files: a page's own scripts, styles, data and images put inline when shown, with what names no file of its own left alone; an app's modules, JSON, CSS and images compiled into one script; files copied from the person's files; one file read, changed, downloaded or deleted at a time; the main file kept; other kinds refused more files | "span several files…" |
| Delete removes every version; export has every version | "are deleted with every version…" |
| Per-version, version-count, artifact-count, total and storage limits, checked before writing | "stay within their limits…" |
| A refused write (`413` too big, `429` too many versions or too much in all, `409` stale base, for an edit or a restore) leaves the title, time, latest version, history and content as they were | "change nothing on a refused write…" |
| Racing writes: an edit and a restore on the same base give one version and a `409`; two creates that don't both fit give one and a `429`, under a limit and under the hard cap | "take one of two writes racing on the same version…", "export near their total cap…" |
| The bridge is the page's first script; storage is the artifact's own, within its limits, kept across versions, exported and deleted with it; the model and app tools need the person's yes for each version; tools that ask first can't be allowed or called | "keep their own data through the bridge…", `test/mcp.test.ts`: "lets an artifact call a tool…" |
| Markdown: the hostile corpus above leaves no loading, running or submitting element or attribute; only `http(s)`, `mailto` and `#` links; raw HTML and images only as text; task lists, tables and code still render | `web/src/components/chat/markdown.test.tsx` |
| Export near the total cap, inlining what fits and listing the rest, and the cap holding with no limits set | "export near their total cap…" |
| Shared with circles: their people see only the latest version, from their own space, with their own storage apart and shared data in the owner's space; stopping sharing, an older version, or someone outside the circles gets `404` | `test/people.test.ts`: "are shown to the people of the circles they're shared with…" |
| Published: a copy of one version for everyone signed in, with their own storage, model and tools and no `pim.shared`; republishing replaces the version; made their own as a copy; taken down by unpublishing, deletion or the admin | `test/people.test.ts`: "are published to everyone as a copy of one version…" |
| Public links: off until the author turns them on, only for framed kinds; the content origin serves the sandboxed page with no bridge and `404` for anything else, cookies or not; turning the link off ends it | "are published to everyone as a copy of one version…" |
| Another person's space returns `404` for the artifact; anonymous `401` | `test/people.test.ts`: "are shown only to their owner" |
| Fresh requests refused: signed out `401`, passkey removed `401`, suspended `403`, deleted `410` on frame, download and metadata; account export has every version; erased | "stop showing when the browser signs out, its passkey is removed…" |
| A tool call or a restore under way during the erasure leaves nothing | "keeps an artifact the model asks for during the erasure…", "refuses an artifact restore in the agent's handler…" |
| In a real browser: the card and viewer render on desktop and a 390 px phone; the page's own script runs; a hostile artifact can't read cookies or storage, reach the parent or the API, fetch or load remote resources, open windows or submit forms (it can still navigate itself away, which the app notices); leaving is noticed; restore and delete work; Markdown loads nothing remote; signing out unmounts every frame | Browser acceptance against the local preview, recorded in the pull request |
