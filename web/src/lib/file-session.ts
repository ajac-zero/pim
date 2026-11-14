import {
  type DecodedFile,
  decodeFile,
  type FileText,
  joinText,
} from "~/lib/file-text";
import { mergeText } from "~/lib/merge-text";
import {
  ApiError,
  FileConflictError,
  type FileRead,
  type FileWrite,
  readFile,
  writeFile,
} from "~/lib/pim-api";

/*
 * One file's editing session: the buffer the person is typing in, the hash of
 * the version on disk it started from, and the autosave that connects them.
 * It knows nothing of the editor view or React, so it is tested alone. Changes
 * made to the file elsewhere (an agent, another program, another tab) reach it
 * through fileChanged: a clean buffer takes them silently, an unsaved one
 * merges them by lines, and changes to the same lines wait for the person to
 * choose, with their buffer kept as it was.
 */

export const AUTOSAVE_MS = 500;

export type SessionStatus =
  | "loading"
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "conflict"
  | "error"
  | "readonly";

/** The file on disk as a conflict found it: its hash, and its text, each null when the file is gone or not known. */
export type DiskVersion = { hash: string | null; text: string | null };

export type SessionState = {
  status: SessionStatus;
  /** What a failed save found on disk. */
  conflict: FileConflictError | null;
  /** What a conflict found on disk, for "Overwrite with mine" and the other choices. */
  disk: DiskVersion | null;
  error: string | null;
};

/** The editor view as the session sees it. */
export type EditorHandle = {
  getText(): string;
  /** Replaces the whole document, keeping selection and scroll where it can. */
  setText(text: string): void;
  /** Where the cursor or selection is, with the selected text (cut short), lines and columns counting from 1. */
  getSelection(): EditorSelection;
  /** Scrolls to a line, counting from 1, and puts the cursor there. */
  reveal(line: number): void;
};

export type EditorSelection = {
  from: { line: number; column: number };
  to: { line: number; column: number };
  text: string;
};

export type FileClient = {
  readFile(path: string): Promise<FileRead>;
  writeFile(
    path: string,
    text: string,
    options?: { ifMatch?: string | null; ifNoneMatch?: boolean },
  ): Promise<FileWrite>;
};

export class FileSession {
  private state: SessionState = {
    status: "loading",
    conflict: null,
    disk: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private editor: EditorHandle | null = null;
  private buffer = "";
  private eol: "\n" | "\r\n" = "\n";
  private bom = false;
  private baseHash: string | null = null;
  /** The text of the version on disk the buffer started from: what a merge compares both sides with. */
  private baseText = "";
  /** Whether a change from outside is being taken in, and whether another came meanwhile. */
  private pumping = false;
  private wanted = false;
  /** A change from outside that came while saving: it is looked at once the save ends, against what the save left. */
  private deferred: { kind: string; sha256: string | null } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving = false;
  private flushWanted = false;
  private disposed = false;

  constructor(
    readonly path: string,
    private client: FileClient = { readFile, writeFile },
  ) {}

  /** useSyncExternalStore's pair. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;

  /** The text the editor starts with, after `open`. */
  get text() {
    return this.buffer;
  }

  attach(editor: EditorHandle | null) {
    this.editor = editor;
  }

  private set(next: Partial<SessionState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Takes a decoded file as the new baseline; false when it isn't editable text. */
  private adopt(file: DecodedFile, hash: string | null, readOnly: boolean) {
    if (file.kind !== "text") return false;
    this.buffer = file.text;
    this.eol = file.eol;
    this.bom = file.bom;
    this.baseHash = hash;
    this.baseText = file.text;
    this.set({
      status: readOnly || file.mixedEol ? "readonly" : "clean",
      conflict: null,
      disk: null,
      error: null,
    });
    return true;
  }

  /** Starts the session from a file just read. */
  open(read: FileRead, readOnly: boolean) {
    return this.adopt(decodeFile(read.bytes), read.sha256, readOnly);
  }

  /** The person typed: `text` is the whole buffer. */
  edit(text: string) {
    if (text === this.buffer) return;
    this.buffer = text;
    const { status } = this.state;
    if (
      status === "readonly" ||
      status === "conflict" ||
      status === "loading"
    ) {
      return;
    }
    if (status !== "saving") this.set({ status: "dirty", error: null });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS);
  }

  /** Saves now what is typed, as on blur, tab close and page hide. */
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const { status } = this.state;
    if (
      status === "readonly" ||
      status === "conflict" ||
      status === "loading"
    ) {
      return;
    }
    if (this.saving) {
      this.flushWanted = true;
      return;
    }
    if (status !== "dirty" && status !== "error") return;
    await this.save({ ifMatch: this.baseHash });
  }

  private async save(options: {
    ifMatch?: string | null;
    ifNoneMatch?: boolean;
  }) {
    // Never two saves at once: edits made meanwhile wait, and the newest goes next.
    this.saving = true;
    const snapshot = this.buffer;
    this.set({ status: "saving", error: null });
    try {
      const written = await this.client.writeFile(
        this.path,
        joinText(snapshot, { eol: this.eol, bom: this.bom }),
        options,
      );
      // No hash back means a Pim that predates conditional writes: save unconditionally from now on.
      this.baseHash = written.sha256;
      this.baseText = snapshot;
      this.settle();
      if (this.buffer !== snapshot) {
        this.set({ status: "dirty", conflict: null, disk: null });
        if (this.flushWanted) {
          this.flushWanted = false;
          await this.save({ ifMatch: this.baseHash });
        }
        return;
      }
      this.flushWanted = false;
      this.set({ status: "saved", conflict: null, disk: null });
    } catch (failure) {
      this.settle();
      this.flushWanted = false;
      if (failure instanceof FileConflictError) {
        clearTimeout(this.timer);
        this.timer = undefined;
        await this.conflicted(failure);
      } else {
        this.set({
          status: "error",
          error: failure instanceof Error ? failure.message : String(failure),
        });
      }
    }
  }

  /** A save ended: it is no longer in flight, and a change from outside that waited for it is looked at. */
  private settle() {
    this.saving = false;
    const change = this.deferred;
    this.deferred = null;
    if (change) this.fileChanged(change);
  }

  /** A save was refused because the file isn't what the buffer started from: what is on disk now is merged in, or left for the person to choose. */
  private async conflicted(failure: FileConflictError) {
    // A file that is gone has nothing to merge with.
    if (failure.currentHash !== null) {
      try {
        const read = await this.client.readFile(this.path);
        const file = decodeFile(read.bytes);
        if (file.kind === "text" && !this.disposed) {
          this.takeDisk(file, read.sha256);
          // Merged cleanly: the next save goes on from the new version.
          if (this.state.status !== "conflict") return;
          this.set({ conflict: failure });
          return;
        }
      } catch {
        // What is on disk can't be read now: the person is told of the conflict as it was found.
      }
    }
    this.set({
      status: "conflict",
      conflict: failure,
      disk: { hash: failure.currentHash, text: null },
    });
  }

  /** Conflict: throws the person's buffer away for what is on disk. Undo in the editor brings it back. */
  async reloadFromDisk() {
    const read = await this.client.readFile(this.path);
    const file = decodeFile(read.bytes);
    if (file.kind !== "text") return;
    this.adopt(file, read.sha256, false);
    this.editor?.setText(this.buffer);
  }

  /** Conflict: writes the person's buffer over what is on disk. */
  async overwrite() {
    const { conflict, disk } = this.state;
    if (this.state.status !== "conflict" || this.saving) return;
    const hash = disk ? disk.hash : (conflict?.currentHash ?? null);
    await this.save(hash ? { ifMatch: hash } : { ifNoneMatch: true });
  }

  /**
   * Conflict: puts what is on disk into the buffer beside the person's, in
   * conflict markers, for them to settle by hand in the editor. It saves as
   * any edit does once they have.
   */
  markConflicts() {
    const { disk } = this.state;
    if (this.state.status !== "conflict" || disk?.text == null) return;
    const merged = mergeText(
      this.editor?.getText() ?? this.buffer,
      this.baseText,
      disk.text,
    );
    this.baseHash = disk.hash;
    this.baseText = disk.text;
    this.buffer = merged.text;
    this.editor?.setText(merged.text);
    this.set({ status: "dirty", conflict: null, disk: null });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS);
  }

  /** What the person has selected, or where the cursor is; null with no editor showing. */
  selection(): EditorSelection | null {
    return this.editor?.getSelection() ?? null;
  }

  /** Whether the person has typed something not yet on disk. */
  get dirty() {
    const { status } = this.state;
    return status === "dirty" || status === "saving" || status === "conflict";
  }

  /** Scrolls the editor to a line, if one is showing; whether it was. */
  reveal(line: number) {
    if (!this.editor) return false;
    this.editor.reveal(line);
    return true;
  }

  /**
   * The file changed elsewhere, as the server's watch tells it: `sha256` is
   * what it is now, null when it is gone. A change that is what the session
   * already has, such as its own save, is ignored; returns whether it wasn't.
   */
  fileChanged(change: { kind: string; sha256: string | null }) {
    if (this.disposed || change.kind === "unwatched") return false;
    if (change.sha256 !== null && change.sha256 === this.baseHash) return false;
    // The save's own write shows up as a change before its answer does.
    if (this.saving) {
      this.deferred = change;
      return true;
    }
    this.wanted = true;
    void this.pump();
    return true;
  }

  /** Takes in changes from outside one at a time, as many as came. */
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.wanted && !this.disposed) {
        this.wanted = false;
        await this.refresh();
      }
    } finally {
      this.pumping = false;
    }
  }

  private async refresh() {
    let read: FileRead;
    try {
      read = await this.client.readFile(this.path);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) {
        this.vanished();
      }
      return;
    }
    if (read.sha256 !== null && read.sha256 === this.baseHash) return;
    const file = decodeFile(read.bytes);
    if (file.kind === "text" && !this.disposed)
      this.takeDisk(file, read.sha256);
  }

  /** The file was deleted: unsaved typing is kept, for the person to save as a new file or let go. */
  private vanished() {
    if (this.dirty && this.state.status !== "conflict") {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.set({ status: "conflict", disk: { hash: null, text: null } });
    }
  }

  /** The file on disk is now `file`: a clean buffer becomes it; unsaved typing is merged with it by lines, and what both changed is left for the person. */
  private takeDisk(file: FileText & { kind: "text" }, hash: string | null) {
    const { status } = this.state;
    if (status === "loading") return;
    const settled =
      status === "clean" || status === "saved" || status === "readonly";
    if (settled) {
      this.adopt(file, hash, status === "readonly" && !file.mixedEol);
      this.editor?.setText(this.buffer);
      return;
    }
    const mine = this.editor?.getText() ?? this.buffer;
    const merged = file.mixedEol
      ? null
      : mergeText(mine, this.baseText, file.text);
    if (!merged?.clean) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.set({
        status: "conflict",
        conflict: null,
        disk: { hash, text: file.text },
      });
      return;
    }
    this.eol = file.eol;
    this.bom = file.bom;
    this.baseHash = hash;
    this.baseText = file.text;
    this.buffer = merged.text;
    this.editor?.setText(merged.text);
    if (merged.text === file.text) {
      this.set({ status: "clean", conflict: null, disk: null });
      return;
    }
    this.set({ status: "dirty", conflict: null, disk: null });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS);
  }

  /** Saves what is pending and stops every timer; the session is done. */
  dispose() {
    void this.flush();
    clearTimeout(this.timer);
    this.disposed = true;
  }
}
