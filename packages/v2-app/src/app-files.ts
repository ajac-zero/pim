/**
 * What an app's version holds a file as. A version's files are a map of path to string: text as it is, and a file that is not text (an image, a dataset in
 * a binary format) as `pim-binary:` and its bytes in base64, so one version stays one JSON document and the same code that reads text reads it. A text file
 * that began with that prefix would be read as binary; nothing writes one.
 */
export const BINARY_PREFIX = "pim-binary:";
export type AppFiles = Record<string, string>;

export const isBinary = (value: string): boolean => value.startsWith(BINARY_PREFIX);
export const binaryValue = (bytes: Uint8Array): string => BINARY_PREFIX + Buffer.from(bytes).toString("base64");
/** A file's bytes: the bytes a binary one holds, the UTF-8 of a text one. */
export const bytesOf = (value: string): Buffer => (isBinary(value) ? Buffer.from(value.slice(BINARY_PREFIX.length), "base64") : Buffer.from(value, "utf8"));
/** A file's size in bytes. */
export const sizeOfFile = (value: string): number => (isBinary(value) ? Buffer.byteLength(Buffer.from(value.slice(BINARY_PREFIX.length), "base64")) : Buffer.byteLength(value));

/** What a file's name says its type is, for a page that shows it (`<img src>`) and for a download. */
const TYPES: Record<string, string> = {
	css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", svg: "image/svg+xml", html: "text/html", htm: "text/html", txt: "text/plain", md: "text/markdown", csv: "text/csv", xml: "application/xml",
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
	woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", wasm: "application/wasm",
};
export const typeOfFile = (path: string): string => TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
