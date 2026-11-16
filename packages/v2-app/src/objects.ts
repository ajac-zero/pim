import { createHash, randomBytes } from "node:crypto";
import type { ObjectMetadata, ObjectRange, ObjectStore } from "@pim/v2-contracts/platform";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Authorizer } from "./authz.ts";
import type { Db } from "./db.ts";
import { BadRequestError, GoneError, NotFoundError } from "./errors.ts";
import type { Principal } from "@pim/v2-contracts/identity";

export class MemoryObjectStore implements ObjectStore {
	readonly blobs = new Map<string, { body: Uint8Array; contentType: string }>();
	#meta(key: string, size: number, contentType: string, body: Uint8Array): ObjectMetadata {
		return { key, size, contentType, etag: `"${createHash("md5").update(body).digest("hex")}"` };
	}
	async put(key: string, body: Uint8Array, options: { contentType: string }) {
		this.blobs.set(key, { body, contentType: options.contentType });
		return this.#meta(key, body.length, options.contentType, body);
	}
	async get(key: string, range?: ObjectRange) {
		const b = this.blobs.get(key);
		if (!b) return null;
		return { body: range ? b.body.slice(range.start, range.end + 1) : b.body, metadata: this.#meta(key, b.body.length, b.contentType, b.body) };
	}
	async head(key: string) {
		const b = this.blobs.get(key);
		return b ? this.#meta(key, b.body.length, b.contentType, b.body) : null;
	}
	async delete(key: string) {
		this.blobs.delete(key);
	}
	async presign(key: string, options: { method: "GET" | "PUT"; expiresInSeconds: number }) {
		return `memory://${key}?method=${options.method}&expires=${options.expiresInSeconds}`;
	}
}

/** Any S3-compatible service: SeaweedFS, MinIO, R2 or S3. Path-style addressing, so a bare endpoint works. */
export class S3ObjectStore implements ObjectStore {
	readonly #s3: S3Client;
	constructor(private readonly bucket: string, config: S3ClientConfig) {
		this.#s3 = new S3Client({ forcePathStyle: true, ...config });
	}
	async put(key: string, body: Uint8Array, options: { contentType: string }) {
		const out = await this.#s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: options.contentType }));
		return { key, size: body.length, contentType: options.contentType, etag: out.ETag ?? "" };
	}
	async get(key: string, range?: ObjectRange) {
		try {
			const out = await this.#s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }));
			const body = await out.Body!.transformToByteArray();
			const total = out.ContentRange ? Number(out.ContentRange.split("/")[1]) : (out.ContentLength ?? body.length);
			return { body, metadata: { key, size: total, contentType: out.ContentType ?? "application/octet-stream", etag: out.ETag ?? "" } };
		} catch (error) {
			if ((error as { name?: string }).name === "NoSuchKey") return null;
			throw error;
		}
	}
	async head(key: string) {
		try {
			const out = await this.#s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
			return { key, size: out.ContentLength ?? 0, contentType: out.ContentType ?? "application/octet-stream", etag: out.ETag ?? "" };
		} catch {
			return null;
		}
	}
	async delete(key: string) {
		await this.#s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
	}
	presign(key: string, options: { method: "GET" | "PUT"; expiresInSeconds: number; contentType?: string }) {
		const command = options.method === "GET" ? new GetObjectCommand({ Bucket: this.bucket, Key: key }) : new PutObjectCommand({ Bucket: this.bucket, Key: key, ...(options.contentType ? { ContentType: options.contentType } : {}) });
		return getSignedUrl(this.#s3, command, { expiresIn: options.expiresInSeconds });
	}
}

const starts = (b: Uint8Array, ...sig: number[]) => sig.every((v, i) => b[i] === v);
/** The image type a file's own bytes show, whatever its name or declared type says. */
export function sniffImage(b: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
	if (starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(b, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(b, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (starts(b, 0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
	return null;
}

export type Served = { status: 200 | 206 | 416; headers: Record<string, string>; body: Uint8Array };

/** Parses one `Range: bytes=a-b | a- | -n` against a size; null means unsatisfiable. Multiple ranges are not supported and answer with the whole object. */
export function parseRange(header: string, size: number): { start: number; end: number } | null | "whole" {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return "whole";
	const [, a = "", b = ""] = m;
	if (a === "" && b === "") return "whole";
	let start: number;
	let end: number;
	if (a === "") {
		const n = Number(b);
		if (n === 0) return null;
		start = Math.max(size - n, 0);
		end = size - 1;
	} else {
		start = Number(a);
		end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
	}
	return start >= size || start > end ? null : { start, end };
}

/** Object metadata and access control in PostgreSQL, bytes in a ObjectStore. The ACL row decides who reads; the store holds no permissions. */
export class Objects {
	constructor(private readonly db: Db, private readonly store: ObjectStore, private readonly opts: { hideSuspended?: boolean } = {}, private readonly authz = new Authorizer(db)) {}

	async put(p: Principal, input: { bytes: Uint8Array; contentType: string; purpose: "image" | "media" | "artifact_file" | "file"; acl?: "private" | "public"; key?: string }): Promise<{ key: string; contentType: string }> {
		await this.authz.enforce(p, "api:write");
		let contentType = input.contentType;
		if (input.purpose === "image") {
			const sniffed = sniffImage(input.bytes);
			if (!sniffed) throw new BadRequestError("That file is not a PNG, JPEG, GIF or WebP image");
			contentType = sniffed;
		}
		const key = input.key ?? `${p.ownerId}/${randomBytes(12).toString("hex")}`;
		if (!key.startsWith(`${p.ownerId}/`)) throw new BadRequestError("An object lives under its owner");
		await this.store.put(key, input.bytes, { contentType });
		await this.db.owner(p.ownerId, (tx) =>
			tx.query(
				"INSERT INTO pim_app.objects (key, owner_id, purpose, content_type, size, sha256, acl) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (key) DO UPDATE SET content_type = $4, size = $5, sha256 = $6, acl = $7, deleted_at = NULL",
				[key, p.ownerId, input.purpose, contentType, input.bytes.length, createHash("sha256").update(input.bytes).digest("hex"), input.acl ?? "private"],
			),
		);
		return { key, contentType };
	}

	/**
	 * Serves an object. A public object is served to anyone while its owner's account is not deleted; a private one only to its owner (live).
	 * `Range` gives 206 with Content-Range, so video and audio seek; a range past the end gives 416.
	 */
	async serve(p: Principal | null, key: string, rangeHeader?: string): Promise<Served> {
		const ownerId = key.split("/")[0] ?? "";
		const meta = await this.db.lookup(key, async (tx) => (await tx.query("SELECT owner_id, content_type, size, acl, sha256 FROM pim_app.objects WHERE key = $1 AND deleted_at IS NULL", [key])).rows[0]);
		if (!meta) throw new NotFoundError();
		const mine = p && p.ownerId === meta.owner_id;
		if (meta.acl !== "public" && !mine) throw new NotFoundError();
		if (mine) await this.authz.enforce(p!, "api:read");
		else {
			// Serving rules for someone else's public object: a deleted author's is gone (410); a suspended author's stays served unless the instance hides it (audit U3).
			const author = await this.authz.account(ownerId);
			if (!author || author.status === "deleting" || author.status === "deleted") throw new GoneError("The author of this has deleted their account");
			if (author.status === "suspended" && this.opts.hideSuspended) throw new NotFoundError();
		}
		const size = Number(meta.size);
		const base = { "content-type": meta.content_type, "accept-ranges": "bytes", etag: `"${meta.sha256}"`, "x-content-type-options": "nosniff" };
		const range = rangeHeader ? parseRange(rangeHeader, size) : "whole";
		if (range === null) return { status: 416, headers: { ...base, "content-range": `bytes */${size}` }, body: new Uint8Array() };
		if (range === "whole") return { status: 200, headers: { ...base, "content-length": String(size) }, body: await this.#bytes(key) };
		return { status: 206, headers: { ...base, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) }, body: await this.#bytes(key, range) };
	}

	async #bytes(key: string, range?: { start: number; end: number }): Promise<Uint8Array> {
		const got = await this.store.get(key, range);
		if (!got) throw new NotFoundError("No such object");
		return got.body;
	}

	async delete(p: Principal, key: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		const n = await this.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.objects SET deleted_at = now() WHERE key = $1 AND deleted_at IS NULL", [key])).rowCount);
		if (!n) throw new NotFoundError();
		await this.store.delete(key);
	}
}
