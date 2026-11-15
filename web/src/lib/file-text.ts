/*
 * How a file's bytes become the text an editor shows, and back. The editor
 * works on LF text without a byte order mark; the file's own line endings and
 * BOM are remembered here and put back on save, so saving never rewrites
 * bytes the person didn't touch.
 */

/** The largest file the editor lets people change. */
export const MAX_EDITABLE_BYTES = 1024 * 1024;
/** The largest file the app opens at all; a bigger one is for downloading. */
export const MAX_VIEWABLE_BYTES = 5 * 1024 * 1024;
/** How much of a file is searched for NUL bytes to tell binary from text. */
const BINARY_SNIFF_BYTES = 8192;

export type FileText = {
  /** The text as the editor holds it: LF line breaks, no BOM. */
  text: string;
  eol: "\n" | "\r\n";
  bom: boolean;
  /** The file mixes line endings, so it can't round-trip through LF text. */
  mixedEol: boolean;
};

export type DecodedFile = { kind: "binary" } | ({ kind: "text" } & FileText);

/** Reads bytes as UTF-8 text, or says they are binary: NUL bytes early on, or not UTF-8. */
export function decodeFile(bytes: Uint8Array): DecodedFile {
  const head = bytes.subarray(0, BINARY_SNIFF_BYTES);
  if (head.includes(0)) return { kind: "binary" };
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return { kind: "binary" };
  }
  return { kind: "text", ...splitText(raw) };
}

/** Takes a BOM and the line-ending style off text read from a file. */
export function splitText(raw: string): FileText {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length - crlf;
  const loneCr = (body.match(/\r(?!\n)/g) ?? []).length;
  const mixedEol = loneCr > 0 || (crlf > 0 && lf > 0);
  const eol = crlf > 0 && lf === 0 ? "\r\n" : "\n";
  return {
    text: eol === "\r\n" ? body.replace(/\r\n/g, "\n") : body,
    eol,
    bom,
    mixedEol,
  };
}

/** The file's text again, with its own line endings and BOM. */
export function joinText(
  text: string,
  { eol, bom }: Pick<FileText, "eol" | "bom">,
): string {
  return (
    (bom ? "\ufeff" : "") + (eol === "\r\n" ? text.replace(/\n/g, eol) : text)
  );
}

export const MIN_EDITOR_FONT_SIZE = 10;
export const MAX_EDITOR_FONT_SIZE = 24;
export const EDITOR_FONT_STEP = 1;
export const EDITOR_FONT_SIZE_KEY = "pim-editor-font-size";

export function clampEditorFontSize(size: number) {
  return Math.min(
    MAX_EDITOR_FONT_SIZE,
    Math.max(MIN_EDITOR_FONT_SIZE, Math.round(size)),
  );
}

/** 13px like other code views; 16px on phones, so iOS does not zoom the page when the editor is focused. */
export function defaultEditorFontSize() {
  return window.matchMedia?.("(max-width: 767px) and (pointer: coarse)")
    ?.matches
    ? 16
    : 13;
}
