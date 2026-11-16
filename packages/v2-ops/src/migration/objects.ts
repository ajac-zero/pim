import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** What the new system's `Objects` port needs from an S3-compatible store; the migration and backup tools use nothing else. */
export interface ObjectStore {
	put(bucket: string, key: string, bytes: Uint8Array, contentType: string | null): Promise<void>;
	get(bucket: string, key: string): Promise<Buffer | null>;
	list(bucket: string, prefix?: string): Promise<{ key: string; size: number }[]>;
	delete(bucket: string, key: string): Promise<void>;
}

const enc = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/** A directory standing in for a bucket: for rehearsals and tests where no S3 server runs. */
export class FsObjectStore implements ObjectStore {
	readonly root: string;
	constructor(root: string) {
		this.root = root;
	}
	#path(bucket: string, key: string) {
		return join(this.root, bucket, enc(key));
	}
	async put(bucket: string, key: string, bytes: Uint8Array, _contentType?: string | null) {
		const path = this.#path(bucket, key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes);
	}
	async get(bucket: string, key: string) {
		return readFile(this.#path(bucket, key)).catch(() => null);
	}
	async list(bucket: string, prefix = "") {
		const out: { key: string; size: number }[] = [];
		const walk = async (dir: string, rel: string) => {
			let names: string[];
			try {
				names = await readdir(dir);
			} catch {
				return;
			}
			for (const name of names) {
				const full = join(dir, name);
				if ((await stat(full)).isDirectory()) await walk(full, `${rel}${name}/`);
				else {
					const key = decodeURIComponent(`${rel}${name}`);
					if (key.startsWith(prefix)) out.push({ key, size: (await stat(full)).size });
				}
			}
		};
		await walk(join(this.root, bucket), "");
		return out.sort((a, b) => (a.key < b.key ? -1 : 1));
	}
	async delete(bucket: string, key: string) {
		await rm(this.#path(bucket, key), { force: true });
	}
}
