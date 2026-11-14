import {
  type DecodedFile,
  decodeFile,
  joinText,
  splitText,
} from "~/lib/file-text";
import {
  FileConflictError,
  type FileRead,
  type FileWrite,
  readFile,
  writeFile,
} from "~/lib/pim-api";

/*
 * One file's editing session: the buffer the person is typing in, the hash of
 * the version on disk it started from, and the autosave that connects them.
 * It knows nothing of the editor view or React, so it is tested alone, and a
 * later watcher feeds changes from outside through applyExternalContent.
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

export type SessionState = {
  status: SessionStatus;
  /** What a conflict found on disk, for "Overwrite with mine". */
  conflict: FileConflictError | null;
  error: string | null;
};

/** The editor view as the session sees it. */
export type EditorHandle = {
  getText(): string;
  /** Replaces the whole document, keeping selection and scroll where it can. */
  setText(text: string): void;
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
    error: null,
  };
  private listeners = new Set<() => void>();
  private editor: EditorHandle | null = null;
  private buffer = "";
  private eol: "\n" | "\r\n" = "\n";
  private bom = false;
  private baseHash: string | null = null;
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
    this.set({
      status: readOnly || file.mixedEol ? "readonly" : "clean",
      conflict: null,
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
      this.saving = false;
      if (this.buffer !== snapshot) {
        this.set({ status: "dirty", conflict: null });
        if (this.flushWanted) {
          this.flushWanted = false;
          await this.save({ ifMatch: this.baseHash });
        }
        return;
      }
      this.flushWanted = false;
      this.set({ status: "saved", conflict: null });
    } catch (failure) {
      this.saving = false;
      this.flushWanted = false;
      if (failure instanceof FileConflictError) {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.set({ status: "conflict", conflict: failure });
      } else {
        this.set({
          status: "error",
          error: failure instanceof Error ? failure.message : String(failure),
        });
      }
    }
  }

  /** Conflict: throws the person's buffer away for what is on disk. */
  async reloadFromDisk() {
    const read = await this.client.readFile(this.path);
    const file = decodeFile(read.bytes);
    if (file.kind !== "text") return;
    this.adopt(file, read.sha256, false);
    this.editor?.setText(this.buffer);
  }

  /** Conflict: writes the person's buffer over what is on disk. */
  async overwrite() {
    const conflict = this.state.conflict;
    if (!conflict || this.saving) return;
    await this.save(
      conflict.currentHash
        ? { ifMatch: conflict.currentHash }
        : { ifNoneMatch: true },
    );
  }

  /**
   * A change to the file made elsewhere, with its new hash. It replaces the
   * document only when nothing typed is unsaved; returns whether it did.
   */
  applyExternalContent(text: string, newHash: string | null) {
    const { status } = this.state;
    if (status !== "clean" && status !== "saved") return false;
    const file = splitText(text);
    this.buffer = file.text;
    this.eol = file.eol;
    this.bom = file.bom;
    this.baseHash = newHash;
    this.editor?.setText(file.text);
    this.set({ status: "clean" });
    return true;
  }

  /** Saves what is pending and stops every timer; the session is done. */
  dispose() {
    void this.flush();
    clearTimeout(this.timer);
    this.disposed = true;
  }
}
