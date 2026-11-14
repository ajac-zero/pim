import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { languageOf } from "~/lib/editor-language";
import { AUTOSAVE_MS, type FileClient, FileSession } from "~/lib/file-session";
import { decodeFile, joinText } from "~/lib/file-text";
import { ApiError, FileConflictError, type FileWrite } from "~/lib/pim-api";

/** Starts a save without waiting for the mock server to answer it. */
const flushNow = async (session: FileSession) => {
  void session.flush();
  await vi.advanceTimersByTimeAsync(0);
};

const enc = (text: string) => new TextEncoder().encode(text);

/** The editor as the session sees it, over a document the test holds. */
function fakeEditor(initial = "") {
  let doc = initial;
  const setText = vi.fn((text: string) => {
    doc = text;
  });
  return {
    handle: {
      getText: () => doc,
      setText,
      getSelection: () => ({
        from: { line: 1, column: 1 },
        to: { line: 1, column: 1 },
        text: "",
      }),
      reveal: vi.fn(),
    },
    type: (text: string) => {
      doc = text;
    },
    setText,
  };
}

/** A mock of the shared file API: PUT answers with the next hash, or 409s. */
function mockClient(options: { conflictOnce?: FileConflictError } = {}) {
  const writes: { text: string; options: unknown }[] = [];
  const pending: Array<(value: FileWrite) => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let conflict = options.conflictOnce;
  const client: FileClient = {
    readFile: vi.fn(async () => ({
      bytes: enc("disk text\n"),
      sha256: "disk",
    })),
    writeFile: vi.fn((_path, text, opts) => {
      writes.push({ text, options: opts });
      if (conflict) {
        const failure = conflict;
        conflict = undefined;
        return Promise.reject(failure);
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<FileWrite>((resolve) =>
        pending.push((value) => {
          inFlight--;
          resolve(value);
        }),
      );
    }),
  };
  const finish = async (sha256: string | null) => {
    pending.shift()?.({ path: "p", sha256, size: 1, mtime: 1 });
    await vi.advanceTimersByTimeAsync(0);
  };
  return { client, writes, finish, maxInFlight: () => maxInFlight };
}

const open = (client: FileClient, text = "one\n", sha = "h0") => {
  const session = new FileSession("/workspace/a.txt", client);
  session.open({ bytes: enc(text), sha256: sha }, false);
  return session;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("picks a language by extension, and none for plain text", () => {
  expect(languageOf("a.ts")).toBe("typescript");
  expect(languageOf("a.TSX")).toBe("tsx");
  expect(languageOf("a.jsx")).toBe("jsx");
  expect(languageOf("a.rs")).toBe("rust");
  expect(languageOf("a.yml")).toBe("yaml");
  expect(languageOf("a.sh")).toBe("shell");
  expect(languageOf("notes.txt")).toBeNull();
  expect(languageOf(".ts")).toBeNull();
  expect(languageOf("Makefile")).toBeNull();
});

it("round-trips a BOM and CRLF line endings byte for byte", async () => {
  const original = "\ufeffone\r\ntwo\r\n";
  const decoded = decodeFile(enc(original));
  expect(decoded).toMatchObject({
    kind: "text",
    text: "one\ntwo\n",
    eol: "\r\n",
    bom: true,
  });
  const { client, writes, finish } = mockClient();
  const session = open(client, original);
  session.edit("one\ntwo\nthree\n");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
  expect(writes[0]?.text).toBe("\ufeffone\r\ntwo\r\nthree\r\n");
  await finish("h1");
  expect(joinText("x\n", { eol: "\n", bom: false })).toBe("x\n");
});

it("treats mixed line endings as read-only so they are never rewritten", () => {
  const { client } = mockClient();
  const session = open(client, "a\r\nb\nc\n");
  expect(session.getState().status).toBe("readonly");
});

it("saves 500 ms after the last keystroke, with If-Match, and takes the new hash", async () => {
  const { client, writes, finish } = mockClient();
  const session = open(client);
  session.edit("a");
  await vi.advanceTimersByTimeAsync(400);
  session.edit("ab");
  await vi.advanceTimersByTimeAsync(400);
  expect(writes).toHaveLength(0);
  expect(session.getState().status).toBe("dirty");
  await vi.advanceTimersByTimeAsync(100);
  expect(writes).toEqual([{ text: "ab", options: { ifMatch: "h0" } }]);
  expect(session.getState().status).toBe("saving");
  await finish("h1");
  expect(session.getState().status).toBe("saved");
  session.edit("abc");
  await flushNow(session);
  expect(writes[1]?.options).toEqual({ ifMatch: "h1" });
});

it("never saves twice at once and sends the newest buffer next", async () => {
  const { client, writes, finish, maxInFlight } = mockClient();
  const session = open(client);
  session.edit("a");
  await flushNow(session);
  session.edit("ab");
  session.edit("abc");
  void session.flush();
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
  expect(writes).toHaveLength(1);
  await finish("h1");
  expect(writes.map((w) => w.text)).toEqual(["a", "abc"]);
  expect(writes[1]?.options).toEqual({ ifMatch: "h1" });
  await finish("h2");
  expect(session.getState().status).toBe("saved");
  expect(maxInFlight()).toBe(1);
});

it("saves unconditionally when the backend sends no hashes", async () => {
  const { client, writes, finish } = mockClient();
  const session = open(client, "x", null as unknown as string);
  session.edit("y");
  await flushNow(session);
  await finish(null);
  session.edit("z");
  await flushNow(session);
  expect(writes.map((w) => w.options)).toEqual([
    { ifMatch: null },
    { ifMatch: null },
  ]);
});

it("keeps the buffer on a 409, stops autosave, and resolves both ways", async () => {
  const conflict = new FileConflictError("hash_mismatch", "disk", 5, 9);
  const { client, writes, finish } = mockClient({ conflictOnce: conflict });
  const session = open(client);
  const editor = fakeEditor();
  session.attach(editor.handle);
  editor.type("mine");
  session.edit("mine");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
  expect(session.getState().status).toBe("conflict");
  session.edit("mine!");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 4);
  expect(writes).toHaveLength(1);
  expect(session.text).toBe("mine!");

  // Overwrite: If-Match of what was found on disk.
  void session.overwrite();
  await vi.advanceTimersByTimeAsync(0);
  expect(writes[1]).toEqual({ text: "mine!", options: { ifMatch: "disk" } });
  await finish("h9");
  expect(session.getState().status).toBe("saved");
});

it("reloads from disk on conflict, replacing the buffer", async () => {
  const conflict = new FileConflictError("hash_mismatch", "disk", 5, 9);
  const { client } = mockClient({ conflictOnce: conflict });
  const session = open(client);
  const editor = fakeEditor();
  session.attach(editor.handle);
  editor.type("mine");
  session.edit("mine");
  await session.flush();
  await session.reloadFromDisk();
  expect(client.readFile).toHaveBeenCalledWith("/workspace/a.txt");
  expect(editor.setText).toHaveBeenCalledWith("disk text\n");
  expect(session.getState()).toMatchObject({ status: "clean", conflict: null });
});

it("overwrites a deleted file with If-None-Match", async () => {
  const { client, writes } = mockClient({
    conflictOnce: new FileConflictError("missing", null, null, null),
  });
  const session = open(client);
  session.edit("mine");
  await session.flush();
  void session.overwrite();
  expect(writes[1]?.options).toEqual({ ifNoneMatch: true });
});

it("refuses binary bytes and opens only text", () => {
  expect(decodeFile(new Uint8Array([104, 0, 105])).kind).toBe("binary");
  expect(decodeFile(new Uint8Array([0xff, 0xfe, 0x41])).kind).toBe("binary");
  const late = new Uint8Array(9000).fill(65);
  late[8500] = 0; // NUL past the first 8 KB is not sniffed
  expect(decodeFile(late).kind).toBe("text");
  const { client } = mockClient();
  const session = new FileSession("/workspace/a.txt", client);
  expect(session.open({ bytes: new Uint8Array([0]), sha256: "x" }, false)).toBe(
    false,
  );
});

it("opens a 1 to 5 MiB file read-only, where edits save nothing", async () => {
  const { client, writes } = mockClient();
  const session = new FileSession("/workspace/a.txt", client);
  session.open({ bytes: enc("big"), sha256: "x" }, true);
  expect(session.getState().status).toBe("readonly");
  session.edit("changed");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
  expect(writes).toHaveLength(0);
});

/** Makes the next read of the file answer with `text` as hash `hash`. */
const diskNow = (client: FileClient, text: string, hash: string) =>
  vi.mocked(client.readFile).mockResolvedValueOnce({
    bytes: enc(text),
    sha256: hash,
  });

const settle = () => vi.advanceTimersByTimeAsync(0);

it("reloads silently when the file changes elsewhere and nothing is unsaved", async () => {
  const { client, finish } = mockClient();
  const session = open(client);
  const editor = fakeEditor("one\n");
  session.attach(editor.handle);
  diskNow(client, "\ufefffresh\r\n", "h5");
  expect(session.fileChanged({ kind: "modified", sha256: "h5" })).toBe(true);
  await settle();
  expect(editor.setText).toHaveBeenCalledWith("fresh\n");
  expect(session.getState().status).toBe("clean");
  // The new hash is the base for the next save, and CRLF/BOM are kept.
  editor.type("typing");
  session.edit("typing");
  await flushNow(session);
  await finish("h7");
  expect(client.writeFile).toHaveBeenCalledWith(
    "/workspace/a.txt",
    "\ufefftyping",
    { ifMatch: "h5" },
  );
});

it("ignores the change its own save made, and reads nothing for it", async () => {
  const { client, finish } = mockClient();
  const session = open(client);
  session.edit("mine");
  await flushNow(session);
  // Pim reports the write before the save's answer reaches the page.
  expect(session.fileChanged({ kind: "modified", sha256: "h1" })).toBe(true);
  await settle();
  expect(client.readFile).not.toHaveBeenCalled();
  await finish("h1");
  await settle();
  // Once the save answered, the same report is the session's own.
  expect(session.fileChanged({ kind: "modified", sha256: "h1" })).toBe(false);
  expect(client.readFile).not.toHaveBeenCalled();
  expect(session.getState().status).toBe("saved");
});

it("merges an outside change to another part of the file into unsaved typing", async () => {
  const base = "a\nb\nc\nd\ne\n";
  const { client, writes, finish } = mockClient();
  const session = open(client, base, "h0");
  const editor = fakeEditor(base);
  session.attach(editor.handle);
  // The person edits line 1; an agent edits line 5.
  editor.type("A\nb\nc\nd\ne\n");
  session.edit("A\nb\nc\nd\ne\n");
  diskNow(client, "a\nb\nc\nd\nE\n", "h2");
  session.fileChanged({ kind: "modified", sha256: "h2" });
  await settle();
  expect(editor.setText).toHaveBeenCalledWith("A\nb\nc\nd\nE\n");
  expect(session.getState()).toMatchObject({ status: "dirty", disk: null });
  // Saved against what the agent wrote, so neither overwrites the other.
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
  expect(writes).toEqual([
    { text: "A\nb\nc\nd\nE\n", options: { ifMatch: "h2" } },
  ]);
  await finish("h3");
  expect(session.getState().status).toBe("saved");
});

it("keeps unsaved typing as it is when an outside change hits the same lines", async () => {
  const base = "a\nb\nc\n";
  const { client, writes, finish } = mockClient();
  const session = open(client, base, "h0");
  const editor = fakeEditor(base);
  session.attach(editor.handle);
  editor.type("a\nmine\nc\n");
  session.edit("a\nmine\nc\n");
  diskNow(client, "a\ntheirs\nc\n", "h2");
  session.fileChanged({ kind: "modified", sha256: "h2" });
  await settle();
  expect(session.getState()).toMatchObject({
    status: "conflict",
    disk: { hash: "h2", text: "a\ntheirs\nc\n" },
  });
  // Nothing was replaced, and nothing is saved over the agent's version.
  expect(editor.setText).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 4);
  expect(writes).toHaveLength(0);
  expect(session.text).toBe("a\nmine\nc\n");

  // Both sides in the file, to settle by hand.
  session.markConflicts();
  expect(editor.setText).toHaveBeenCalledWith(
    "a\n<<<<<<< mine\nmine\n||||||| earlier\nb\n=======\ntheirs\n>>>>>>> on disk\nc\n",
  );
  expect(session.getState().status).toBe("dirty");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
  expect(writes[0]?.options).toEqual({ ifMatch: "h2" });
  await finish("h3");
});

it("overwrites what an outside change left, when the person says so", async () => {
  const { client, writes, finish } = mockClient();
  const session = open(client, "a\n", "h0");
  session.edit("mine\n");
  diskNow(client, "theirs\n", "h2");
  session.fileChanged({ kind: "modified", sha256: "h2" });
  await settle();
  expect(session.getState().status).toBe("conflict");
  void session.overwrite();
  await settle();
  expect(writes[0]).toEqual({ text: "mine\n", options: { ifMatch: "h2" } });
  await finish("h3");
  expect(session.getState().status).toBe("saved");
});

it("looks at a change that came during a save once the save ends", async () => {
  const { client, finish } = mockClient();
  const session = open(client, "a\n", "h0");
  session.edit("b\n");
  await flushNow(session);
  diskNow(client, "elsewhere\n", "h9");
  session.fileChanged({ kind: "modified", sha256: "h9" });
  await settle();
  expect(client.readFile).not.toHaveBeenCalled();
  await finish("h1");
  await settle();
  expect(client.readFile).toHaveBeenCalledTimes(1);
});

it("merges on a 409 too, when its version differs elsewhere than the typing", async () => {
  const base = "a\nb\nc\nd\ne\n";
  const { client, writes, finish } = mockClient({
    conflictOnce: new FileConflictError("hash_mismatch", "h2", 5, 9),
  });
  const session = open(client, base, "h0");
  const editor = fakeEditor(base);
  session.attach(editor.handle);
  editor.type("A\nb\nc\nd\ne\n");
  session.edit("A\nb\nc\nd\ne\n");
  diskNow(client, "a\nb\nc\nd\nE\n", "h2");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
  expect(editor.setText).toHaveBeenCalledWith("A\nb\nc\nd\nE\n");
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
  expect(writes[1]).toEqual({
    text: "A\nb\nc\nd\nE\n",
    options: { ifMatch: "h2" },
  });
  await finish("h3");
});

it("keeps unsaved typing when the file is deleted under it", async () => {
  const { client, writes } = mockClient();
  const session = open(client);
  session.edit("mine");
  vi.mocked(client.readFile).mockRejectedValueOnce(
    new ApiError(404, "not found"),
  );
  session.fileChanged({ kind: "deleted", sha256: null });
  await settle();
  expect(session.getState()).toMatchObject({
    status: "conflict",
    disk: { hash: null },
  });
  void session.overwrite();
  expect(writes[0]?.options).toEqual({ ifNoneMatch: true });
});

it("leaves no timers running after dispose", async () => {
  const { client } = mockClient();
  const session = open(client);
  session.edit("a");
  session.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(client.writeFile).toHaveBeenCalledTimes(1);
});
