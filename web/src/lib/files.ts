import type { BundledLanguage } from "shiki";
import { FILES_ROOT } from "~/lib/pim-api";

/** The folder a file or folder is in; the root has none. */
export function parentOf(path: string): string | null {
  if (path === FILES_ROOT) return null;
  return path.slice(0, path.lastIndexOf("/")) || FILES_ROOT;
}

/** The last part of a path: a file's or folder's name. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A path as people read it: from your files, without the folder agents see them in. */
export function displayPath(path: string): string {
  return path === FILES_ROOT ? "" : path.slice(FILES_ROOT.length + 1);
}

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif"]);
const AUDIO = new Set(["mp3", "wav"]);
const VIDEO = new Set(["mp4", "webm"]);
/** Text files the preview shows highlighted, and the language each is in. */
const CODE: Record<string, BundledLanguage> = {
  json: "json",
  js: "javascript",
  mjs: "javascript",
  ts: "typescript",
  py: "python",
  html: "html",
  css: "css",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "shellscript",
  sql: "sql",
};
const PLAIN = new Set(["txt", "csv", "tsv", "log", "ics", "vcf"]);

export type FilePreview =
  | { kind: "image" | "audio" | "video" | "markdown" | "text" | "none" }
  | { kind: "code"; language: BundledLanguage };

/** How the app shows a file, by its name; the bytes are served as inert data whatever it is. */
export function previewOf(name: string): FilePreview {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (IMAGES.has(extension)) return { kind: "image" };
  if (AUDIO.has(extension)) return { kind: "audio" };
  if (VIDEO.has(extension)) return { kind: "video" };
  if (extension === "md" || extension === "markdown")
    return { kind: "markdown" };
  const language = CODE[extension];
  if (language) return { kind: "code", language };
  if (PLAIN.has(extension) || extension === "") return { kind: "text" };
  return { kind: "none" };
}
