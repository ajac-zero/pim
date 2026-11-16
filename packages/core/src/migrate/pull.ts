import { createHash } from "node:crypto";
import { BundleWriter, PI_TABLES, isLiveHandle } from "./format.ts";
import { encryptSecretsFile } from "./secrets-bundle.ts";

/**
 * Pulls an export bundle from the maintenance/export Worker over its read-only HTTP API. The token and the export key
 * are given as values read from files by the caller; nothing is logged. It reads and writes no state of the old system.
 */
export interface PullOptions {
	base: string;
	token: string;
	out: string;
	exportKey: Buffer;
	fetchImpl?: typeof fetch;
	log?: (message: string) => void;
	/** Fences the bundle records: when and how the old system was quiesced, taken from the cutover record. */
	fence?: Record<string, unknown>;
}

export async function pullExport(options: PullOptions): Promise<{ tenants: string[]; handles: number; blobs: number }> {
	const f = options.fetchImpl ?? fetch;
	const log = options.log ?? (() => undefined);
	const get = async (path: string) => {
		const res = await f(`${options.base}${path}`, { headers: { authorization: `Bearer ${options.token}` } });
		if (!res.ok) throw new Error(`Export request ${path.split("?")[0]} failed: ${res.status}`);
		return res;
	};
	async function* rows(kind: string, name: string, table: string): AsyncGenerator<Record<string, any>> {
		let after = 0;
		for (;;) {
			const page = (await (await get(`/__export/do/${kind}/${encodeURIComponent(name)}/rows?table=${table}&after=${after}&limit=2000`)).json()) as { rows: Record<string, any>[]; next: number | null };
			yield* page.rows;
			if (page.next === null) return;
			after = page.next;
		}
	}
	const tables = async (kind: string, name: string) => (await (await get(`/__export/do/${kind}/${encodeURIComponent(name)}/tables`)).json()) as { name: string; rows: number }[];

	const writer = new BundleWriter(options.out);
	const accounts: Record<string, any>[] = [];
	for await (const row of rows("directory", "directory", "accounts")) accounts.push(row);
	await writer.ndjson("directory/accounts.ndjson", accounts);
	const handles: Record<string, unknown>[] = [];

	for (const { owner_id: tenant } of accounts as { owner_id: string }[]) {
		writer.tenants.add(tenant);
		log(`tenant ${tenant}`);
		const secrets: { id: string; purpose: string; value: string }[] = [];
		const threadIds: string[] = [];
		for (const table of await tables("pim", tenant)) {
			if (table.rows < 0) continue;
			if (table.name === "pim_credentials") {
				for await (const row of rows("pim", tenant, table.name)) secrets.push({ id: `credential:${row.provider}`, purpose: "model-provider", value: String(row.credential) });
				continue;
			}
			if ((PI_TABLES as readonly string[]).includes(table.name)) await writer.ndjson(`tenants/${tenant}/pi/${table.name}.ndjson`, rows("pim", tenant, table.name));
			else if (table.name === "durable_metadata") {
				const meta = (await rows("pim", tenant, table.name).next()).value as { next_id: string; next_seq: number };
				writer.json(`tenants/${tenant}/pi/metadata.json`, { next_id: String(meta.next_id), next_seq: Number(meta.next_seq) });
			} else if (table.name.startsWith("pim_")) {
				await writer.ndjson(`tenants/${tenant}/host/${table.name}.ndjson`, rows("pim", tenant, table.name));
				if (table.name === "pim_coding_threads") for await (const t of rows("pim", tenant, table.name)) threadIds.push(String(t.thread_id));
			}
		}
		for (const table of await tables("auth", tenant)) if (table.rows >= 0 && table.name.startsWith("auth_") && table.name !== "auth_meta" && table.name !== "auth_device_links") await writer.ndjson(`tenants/${tenant}/auth/${table.name}.ndjson`, rows("auth", tenant, table.name));
		// Other secrets the old system kept in its own meta tables are exported by the same route when they are named here.
		if (secrets.length > 0) writer.json(`tenants/${tenant}/secrets.json`, encryptSecretsFile(secrets, options.exportKey, tenant));
		// Coding threads: the whole thread database as raw rows, and the handle that says what is still running on the other side.
		for (const id of threadIds) {
			for (const table of await tables("thread", id)) if (table.rows >= 0 && table.name.startsWith("coding_")) await writer.ndjson(`coding/${id}/${table.name}.ndjson`, rows("thread", id, table.name));
			for await (const t of rows("thread", id, "coding_thread")) {
				handles.push({ tenant, kind: "coding.thread", id: t.thread_id, state: t.state, harness: t.harness, handle: { providerKind: t.provider_kind, orb: t.orb, workspaceRef: t.workspace_ref, poolId: t.pool_id, repo: t.repo_url, branch: t.branch, baseSha: t.base_sha, lastMessage: t.orb_last_message, costUsd: t.orb_cost_usd }, lastEventAt: t.updated_at, terminal: !isLiveHandle({ state: t.state }) });
			}
		}
	}
	await writer.ndjson("external/handles.ndjson", handles);

	// Object bodies, by checksum; the owner's id is the first path segment of a key, as the old system stored them.
	const index: Record<string, unknown>[] = [];
	for (const bucket of ["blobs", "artifacts"]) {
		let cursor: string | null = null;
		do {
			const page = (await (await get(`/__export/r2/${bucket}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).json()) as { objects: { key: string; size: number; contentType?: string }[]; cursor: string | null };
			for (const object of page.objects) {
				const body = Buffer.from(await (await get(`/__export/r2/${bucket}/${encodeURIComponent(object.key)}`)).arrayBuffer());
				const sha256 = createHash("sha256").update(body).digest("hex");
				writer.blob(sha256, body);
				index.push({ tenant: object.key.split("/")[0], legacy_key: `${bucket}:${object.key}`, sha256, size: body.length, content_type: object.contentType ?? "application/octet-stream" });
			}
			cursor = page.cursor;
		} while (cursor);
	}
	await writer.ndjson("blobs/index.ndjson", index);
	writer.finish({ system: "pim-legacy", fence: options.fence });
	return { tenants: [...writer.tenants], handles: handles.length, blobs: index.length };
}
