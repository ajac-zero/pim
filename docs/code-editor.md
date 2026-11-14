# The code editor canvas

A file of yours opened from a chat shows in the canvas beside it, as a tab. A text file opens in a code editor (CodeMirror 6; Markdown opens rendered, with Edit beside it), and the person and the agent work on the same file: the person's typing saves itself, what an agent writes shows up as it is written, and neither overwrites the other. This page is how that works. The files themselves, `expectedHash` and the conflict an out-of-date write gets are in [Your computer](reference.md#your-computer); the editor is `web/src/components/file-view.tsx` with `web/src/lib/file-session.ts`.

On by default, for every space with a computer. Without one a file tab says the files are on a computer, and offers Connect a computer; the agent has no canvas tools.

## What opens, and what doesn't

Text up to 1 MiB is editable. Text up to 5 MiB opens read-only, and anything bigger, or binary (a NUL byte in its first 8 KiB, or not UTF-8), is for downloading. A file whose lines end in a mix of `\n` and `\r\n` opens read-only, so saving can't change bytes the person didn't touch; a BOM and uniform CRLF are kept. Paths are under `/workspace`, with `..` and links resolved by the computer, which refuses what leads outside.

## Saving

A session (`FileSession`) holds the buffer, the hash of the version on disk it started from, and that version's text. It saves 500 ms after the last keystroke, on blur, and when the tab closes or the page hides, always with `If-Match` of its hash, and takes the hash the write answers with. Never two saves at once.

## Hot reload

An open file tab asks the server to watch the file over the chat's WebSocket (`watch_file`, `unwatch_file`; see `src/protocol.ts`). The server counts the holds each socket has, passes them to the computer's `watch` and `unwatch` (which count too, so a file is watched while any tab has it open), and lets go of a socket's holds when it closes. The tab that closes, or a chat left, lets go of its file; reloading the page opens the tabs the address names, and each asks again. When the server restarts and its sockets survive, it sends `file_resync` and the app asks again; a reconnect does the same.

Changes come back as `file_changed` with the file's new hash, from two places: the computer's own watcher, for anything else that writes the file (a shell command, another program, a `git checkout`), and the space itself, for each write it makes through `Computer.fs.writeFile`, which is every write by an agent or by the person's save, since the computer doesn't report writes it made for the space. A watch also answers with the file as it is, so a change between the app's read and the watch isn't missed. A watch that fails (`watch_error` from the computer) comes as `kind: "unwatched"`, and the tab stops hearing of the file.

A tab that hears of a hash it already has ignores it: its own save, which the server reports before the save's answer reaches the page, is looked at once that answer is in. Otherwise it reads the file.

- **Nothing unsaved:** the text is replaced silently, changing only the span that differs, so the cursor and scroll stay where they were. The next save goes against the new hash.
- **Unsaved typing:** the buffer, the version it started from and the file now are merged by lines (diff3, `web/src/lib/merge-text.ts`). Changes to different places merge, and the merged text saves against the new hash.
- **The same lines changed on both sides:** nothing is replaced and nothing is saved. A banner says the file changed where the person was editing, and the buffer stays as it was. They choose **Show both in the file** (the buffer gets the lines of both between `<<<<<<< mine`, `||||||| earlier`, `=======` and `>>>>>>> on disk`, to settle by hand), **Reload from disk** (the editor's undo brings their text back), or **Overwrite with mine** (saved against the hash found, so it can't lose a change made since). A save refused with 409 goes the same way: what is on disk is read and merged, or left for the banner.
- **The file deleted under unsaved typing:** the tab stays, the banner says so, and **Overwrite with mine** writes it again. A deleted file with nothing unsaved closes to "This file isn't there anymore".

## What the agent can do in the canvas

The `pim.canvas` extension (`src/extensions/canvas.ts`) has three tools, there while the person has a computer.

- `canvas_open_file(path, line?)` opens a tab on a file, scrolled to a line, in the apps that have the chat open (`canvas_open`). The file must exist. With no app showing the chat it says so, and the agent links the file instead.
- `canvas_list_open` lists the file tabs, which one is shown, and which have unsaved changes.
- `canvas_get_selection` reads where the person's cursor is or what they selected (up to 8000 characters) in the shown file. The server asks the app (`canvas_query`) and waits up to five seconds for its `canvas_answer`; selections are never sent along with messages.

## What the person changed since the agent's last turn

A chat remembers each file its agent read, wrote, edited or deleted with the file tools: the hash, and the text when it is at most 64 KiB (the 20 most recent files; `pim_file_seen`). When the person sends a message, each file seen is looked at again, and what differs goes before their message as its own text part:

```
[Files you changed since your last turn]
/workspace/src/app.ts (changed)
@@ line 12 @@
-const retries = 3
+const retries = 5
/workspace/data.bin (changed, 2048 bytes; no diff shown)
/workspace/old.md (deleted)
```

At most 8 files, 24 changed lines of 160 characters each for each, and about 4,000 characters in all, then "... and N more files changed". Each change is told once. It is a part of the message, not a prompt section, so the prompt cache holds, and the app shows only what the person typed. The agent's own file tools never count: it is told of what changed outside them, which includes a program it ran with `shell`. Binary and larger files, and files whose text wasn't kept, are reported as changed without a diff.

## Where the code is

| | |
| --- | --- |
| Server | `src/pim.ts` (`#watchFile`, `#fileEvent`, `#canvasAsk`, `#fileChanges`), `src/computer.ts` (`watch`, `unwatch`, `onFileEvent`), `src/file-changes.ts`, `src/extensions/canvas.ts` |
| Computer | `computer/pim-computer.ts` (the `watch`, `unwatch` and `unwatch_all` calls, `file_changed` and `watch_error` events) |
| App | `web/src/lib/file-session.ts`, `use-file-session.ts`, `pim-client.ts` (`watchFile`, `listenCanvas`), `canvas-live.ts`, `components/file-view.tsx`, `file-editor.tsx` |
| Tests | `test/computer.test.ts` ("the code editor canvas"), `test/computer-watch.node.test.ts`, `web/src/lib/file-session.test.ts` |
