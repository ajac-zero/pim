import { createHash } from "node:crypto";
import { sizeOfFile, typeOfFile } from "@pim/v2-app/app-files";
import type { Reply } from "@pim/v2-app/http";

/** The web app counts time in milliseconds. */
export const ms = (d: Date | string | null | undefined): number | null => (d ? new Date(d).getTime() : null);
export const ok = (body: unknown, status = 200): Reply => ({ status, body });
export const deleted = (): Reply => ({ status: 200, body: { deleted: true } });

export type Files = Record<string, string>;

/** Exactly how the application digests a version's files, so a version has one sha256 whichever surface names it. */
export const digestOf = (files: Files) => createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))).digest("hex");
/** A note's digest: of its text, the same in the card an agent's tool draws and in the web app's view of it. */
export const textDigest = (text: string) => createHash("sha256").update(text).digest("hex");
export const sizeOf = (files: Files) => Object.values(files).reduce((n, c) => n + sizeOfFile(c), 0);

const TYPES: Record<string, string> = { html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", jsx: "text/jsx", ts: "text/typescript", tsx: "text/tsx", json: "application/json", md: "text/markdown", svg: "image/svg+xml", txt: "text/plain" };
export const typeOf = (path: string) => {
	const known = TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? typeOfFile(path);
	return known === "application/octet-stream" ? "text/plain" : known;
};

/** The icon an agent was given by upload is an object under its owner; anything else in the column is a named icon. */
export const isUploadedIcon = (ownerId: string, key: string | null | undefined): key is string => typeof key === "string" && key.startsWith(`${ownerId}/`);

export const bytesReply = (served: { status: number; headers: Record<string, string>; body: Uint8Array }): Reply => ({ status: served.status, headers: { ...served.headers, "cache-control": "private, max-age=3600" }, raw: served.body });
