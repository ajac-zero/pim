import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Object bodies live in S3-compatible storage (SeaweedFS by default); only metadata and ACL are in PostgreSQL. */
export interface BlobStore {
	put(key: string, body: Buffer, contentType: string): Promise<void>;
	get(key: string): Promise<Buffer | undefined>;
	head(key: string): Promise<{ size: number } | undefined>;
}

/** For tests and single-host trials. */
export class FsBlobStore implements BlobStore {
	constructor(private readonly root: string) {}
	async put(key: string, body: Buffer): Promise<void> {
		const path = join(this.root, key);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body);
	}
	async get(key: string): Promise<Buffer | undefined> {
		try {
			return readFileSync(join(this.root, key));
		} catch {
			return undefined;
		}
	}
	async head(key: string): Promise<{ size: number } | undefined> {
		try {
			return { size: statSync(join(this.root, key)).size };
		} catch {
			return undefined;
		}
	}
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

export interface S3Config {
	endpoint: string;
	bucket: string;
	region?: string;
	accessKeyId: string;
	secretAccessKey: string;
}

/** AWS Signature Version 4 for a path-style request (what SeaweedFS and MinIO accept). Exported for its test vector. */
export function signV4(options: { method: string; host: string; path: string; query?: string; headers: Record<string, string>; payloadHash: string; region: string; service: string; accessKeyId: string; secretAccessKey: string; amzDate: string }): string {
	const { method, host, path, query = "", headers, payloadHash, region, service, accessKeyId, secretAccessKey, amzDate } = options;
	const date = amzDate.slice(0, 8);
	const all: Record<string, string> = { ...headers, host };
	const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
	const canonicalHeaders = names.map((n) => `${n}:${String(Object.entries(all).find(([k]) => k.toLowerCase() === n)![1]).trim()}\n`).join("");
	const signedHeaders = names.join(";");
	const canonical = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
	const scope = `${date}/${region}/${service}/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
	const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), "aws4_request");
	const signature = createHmac("sha256", key).update(toSign).digest("hex");
	return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export class S3BlobStore implements BlobStore {
	constructor(private readonly config: S3Config) {}

	async #request(method: string, key: string, body?: Buffer, contentType?: string): Promise<Response> {
		const url = new URL(this.config.endpoint);
		const path = `/${this.config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
		const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
		const payloadHash = sha256(body ?? "");
		const headers: Record<string, string> = { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
		if (contentType) headers["content-type"] = contentType;
		const authorization = signV4({ method, host: url.host, path, headers, payloadHash, region: this.config.region ?? "us-east-1", service: "s3", accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey, amzDate });
		return fetch(`${url.origin}${path}`, { method, headers: { ...headers, authorization }, body: body as unknown as ArrayBuffer | undefined });
	}

	async put(key: string, body: Buffer, contentType: string): Promise<void> {
		const res = await this.#request("PUT", key, body, contentType);
		if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status}`);
	}
	async get(key: string): Promise<Buffer | undefined> {
		const res = await this.#request("GET", key);
		if (res.status === 404) return undefined;
		if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	}
	async head(key: string): Promise<{ size: number } | undefined> {
		const res = await this.#request("HEAD", key);
		if (res.status === 404) return undefined;
		if (!res.ok) throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
		return { size: Number(res.headers.get("content-length") ?? 0) };
	}
}
